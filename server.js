const express = require('express');
const ytDlp = require('yt-dlp-exec');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';

let cachedModelName = null;

async function fetchWithTimeout(url, options = {}, timeout = 25000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

// 1. הורדת הקלטה מימות המשיח מכל הנתיבים האפשריים
async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const candidates = [
        `ivr2:/${cleanPath}`,
        `ivr2:${cleanPath}`,
        cleanPath
    ];
    if (cleanDir) {
        candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
        candidates.push(`ivr2:${cleanDir}/${cleanPath}`);
    }
    if (!cleanPath.toLowerCase().endsWith('.wav')) {
        candidates.push(`ivr2:/${cleanPath}.wav`);
        if (cleanDir) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}.wav`);
    }

    const uniquePaths = [...new Set(candidates)];
    console.log('[Yemot Download] Trying paths:', uniquePaths.join(' | '));

    let lastYemotResponse = '';
    for (const p of uniquePaths) {
        const url = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;
        try {
            const res = await fetchWithTimeout(url, {}, 15000);
            if (!res.ok) {
                lastYemotResponse = `HTTP_${res.status}`;
                continue;
            }
            const buf = Buffer.from(await res.arrayBuffer());
            const headStr = buf.toString('utf8', 0, Math.min(buf.length, 150));
            
            if (buf.length > 200 && !headStr.includes('responseStatus') && !headStr.includes('EXCEPTION')) {
                console.log(`[Yemot Download] Success from ${p} (${buf.length} bytes)`);
                fetchWithTimeout(`${YM}FileAction?token=${encodeURIComponent(TOKEN)}&action=delete&what=${encodeURIComponent(p)}`).catch(() => null);
                return buf;
            } else {
                lastYemotResponse = headStr;
                console.warn(`[Yemot Download] Invalid content at ${p}:`, headStr);
            }
        } catch (e) {
            lastYemotResponse = e.message;
        }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

// 2. זיהוי אוטומטי של המודל הפעיל ב-Gemini (כולל gemini-3.0-flash)
async function getAvailableGeminiModel() {
    if (cachedModelName) return cachedModelName;
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 10000);
        if (res.ok) {
            const data = await res.json();
            const models = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''));
            
            console.log('[Gemini] Available models for key:', models.join(', '));

            const preferred = [
                'gemini-3.0-flash',
                'gemini-3.0-flash-001',
                'gemini-3-flash',
                'gemini-flash-latest',
                'gemini-2.0-flash'
            ];
            for (const p of preferred) {
                if (models.includes(p)) {
                    cachedModelName = p;
                    return p;
                }
            }
            const anyFlash = models.find(m => m.includes('flash') && !m.includes('tts') && !m.includes('image') && !m.includes('vision'));
            if (anyFlash) {
                cachedModelName = anyFlash;
                return anyFlash;
            }
            if (models.length > 0) {
                cachedModelName = models[0];
                return models[0];
            }
        } else {
            console.error('[Gemini] ListModels failed:', await res.text());
        }
    } catch (e) {
        console.error('[Gemini] Error listing models:', e.message);
    }
    return 'gemini-3.0-flash';
}

async function transcribeAudio(audioBase64) {
    const primary = await getAvailableGeminiModel();
    const modelsToTry = [...new Set([primary, 'gemini-3.0-flash', 'gemini-flash-latest', 'gemini-2.0-flash'])];
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.";

    let lastErr = '';
    for (const model of modelsToTry) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        const res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
                    ]
                }]
            })
        }, 20000);

        if (res.ok) {
            cachedModelName = model;
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            console.log(`[Gemini] Model ${model} transcription:`, JSON.stringify(text));
            return text;
        }

        lastErr = await res.text();
        console.warn(`[Gemini] Model ${model} error (${res.status}):`, lastErr);
        if (res.status === 404) cachedModelName = null;
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// 3. הורדה, המרה והעלאה מהירה לימות המשיח
async function downloadConvertAndUploadToYemot(videoId, targetYemotPath) {
    const tmpWav = path.join(os.tmpdir(), `yt_${videoId}_${Date.now()}.wav`);
    try {
        console.log(`[Audio] Converting video ${videoId}...`);
        await new Promise((resolve, reject) => {
            const subprocess = ytDlp.exec(`https://www.youtube.com/watch?v=${videoId}`, {
                output: '-',
                format: 'bestaudio[ext=m4a]/bestaudio/best',
                noWarnings: true,
                noCheckCertificates: true,
                extractorArgs: 'youtube:player_client=android,web'
            }, { stdio: ['ignore', 'pipe', 'ignore'] });

            ffmpeg(subprocess.stdout)
                .format('wav')
                .audioCodec('pcm_s16le')
                .audioChannels(1)
                .audioFrequency(8000)
                .duration(900) // 15 דקות ראשונות להמרה והעלאה מהירה ללא Timeout
                .on('end', resolve)
                .on('error', reject)
                .save(tmpWav);
        });

        const wavBuffer = await fs.promises.readFile(tmpWav);
        console.log(`[Audio] WAV size: ${wavBuffer.length} bytes. Uploading to ${targetYemotPath}...`);

        const formData = new FormData();
        formData.append('token', TOKEN);
        formData.append('path', targetYemotPath);
        formData.append('convertAudio', '0');
        formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), '000.wav');

        const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
            method: 'POST',
            body: formData
        }, 30000);

        const upText = await upRes.text();
        console.log('[Yemot Upload] Response:', upText);
        fs.promises.unlink(tmpWav).catch(() => null);
        return true;
    } catch (e) {
        fs.promises.unlink(tmpWav).catch(() => null);
        throw e;
    }
}

app.get('/', (req, res) => { res.send('YouTube Line Server v5.0 OK - Active'); });

// נתיב הזרמה ישיר בפורמט MP3 ו-WAV
app.get('/stream/:videoId.:ext', (req, res) => {
    const { videoId, ext } = req.params;
    if (!videoId) return res.status(400).end();

    const isWav = ext === 'wav';
    res.setHeader('Content-Type', isWav ? 'audio/wav' : 'audio/mpeg');
    
    const subprocess = ytDlp.exec(`https://www.youtube.com/watch?v=${videoId}`, {
        output: '-',
        format: 'bestaudio/best',
        noWarnings: true,
        noCheckCertificates: true,
        extractorArgs: 'youtube:player_client=android,web'
    }, { stdio: ['ignore', 'pipe', 'ignore'] });

    const proc = ffmpeg(subprocess.stdout)
        .audioChannels(1)
        .audioFrequency(isWav ? 8000 : 16000);

    if (isWav) {
        proc.format('wav').audioCodec('pcm_s16le');
    } else {
        proc.format('mp3').audioCodec('libmp3lame').audioBitrate('32k');
    }

    proc.on('error', (err) => {
        console.error('[Stream] Error:', err.message);
        if (!res.headersSent) res.status(500).end();
    }).pipe(res, { end: true });

    req.on('close', () => {
        try { subprocess.kill(); } catch (e) {}
    });
});

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        // שלב 1: בקשת הקלטה פשוטה ותקנית
        if (!q.RecordPath) {
            return res.send('read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=RecordPath,no,record,,no,7,2');
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(q.RecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח בדקו את הטוקן&go_to_folder=/');
        }

        // שלב 3: תמלול ב-Gemini
        let rawText = '';
        try {
            rawText = await transcribeAudio(audioBuf.toString('base64'));
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            return res.send('id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&go_to_folder=/');
        }

        const cleanQuery = rawText.replace(/[^א-תa-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
        console.log('[Step 3 Clean Query]', cleanQuery);

        if (!cleanQuery) {
            return res.send('id_list_message=t-ההקלטה הייתה שקטה מדי אנא נסו שנית&go_to_folder=/');
        }

        // שלב 4: חיפוש ב-YouTube API
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl);
        const ytData = await ytRes.json();

        if (!ytRes.ok) {
            console.error('[Step 4 Error]', JSON.stringify(ytData));
            return res.send('id_list_message=t-שגיאה במפתח החיפוש של יוטיוב&go_to_folder=/');
        }

        if (!ytData.items || ytData.items.length === 0) {
            return res.send(`id_list_message=t-לא נמצאו תוצאות עבור ${cleanQuery}&go_to_folder=/`);
        }

        const videoId = ytData.items[0].id.videoId;
        const title = (ytData.items[0].snippet.title || '').replace(/[^א-תa-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

        // שלב 5: השמעת התוצאה
        const hostUrl = `https://${req.get('host')}`;
        const streamUrl = `${hostUrl}/stream/${videoId}.mp3`;

        return res.send(`id_list_message=t-משמיע ${title}.f-${streamUrl}&go_to_folder=/`);

    } catch (e) {
        console.error('[General Error v5.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v5.0 Ready on port ${port} ===`));
