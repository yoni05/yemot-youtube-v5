const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';

let cachedModelName = null;

async function fetchWithTimeout(url, options = {}, timeout = 20000) {
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

// 1. הורדת ההקלטה מימות המשיח
async function downloadRecordingFromYemot(recordPath, apiDir) {
    const cleanPath = String(recordPath).replace(/^ivr2:\/*/, '').replace(/^\/*/, '');
    const cleanDir = String(apiDir || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const candidates = [
        `ivr2:/${cleanPath}`,
        `ivr2:${cleanPath}`
    ];
    if (cleanDir && !cleanPath.startsWith(cleanDir + '/')) {
        candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}`);
    }
    if (!cleanPath.toLowerCase().endsWith('.wav')) {
        candidates.unshift(`ivr2:/${cleanPath}.wav`);
        if (cleanDir) candidates.unshift(`ivr2:/${cleanDir}/${cleanPath}.wav`);
    }

    const uniquePaths = [...new Set(candidates)];
    console.log('[Yemot Download] Trying paths:', uniquePaths.join(' | '));

    let lastYemotResponse = '';
    for (const p of uniquePaths) {
        const url = `${YM}DownloadFile?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(p)}`;
        try {
            const res = await fetchWithTimeout(url, {}, 10000);
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
            }
        } catch (e) {
            lastYemotResponse = e.message;
        }
    }
    throw new Error('YEMOT_DOWNLOAD_ERR: ' + lastYemotResponse);
}

// 2. בחירת המודל המהיר לתמלול ב-Gemini
async function getFastGeminiModels() {
    const defaultFastOrder = [
        'gemini-flash-lite-latest',
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.5-transcribe',
        'gemini-flash-latest',
        'gemini-3.6-flash'
    ];
    if (cachedModelName) {
        return [cachedModelName, ...defaultFastOrder.filter(m => m !== cachedModelName)];
    }
    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 7000);
        if (res.ok) {
            const data = await res.json();
            const available = (data.models || [])
                .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
                .map(m => m.name.replace('models/', ''))
                .filter(m => !m.includes('2.5') && !m.includes('1.5') && !m.includes('tts') && !m.includes('image') && !m.includes('robotics') && !m.includes('research') && !m.includes('computer-use'));

            const matched = [];
            for (const pref of defaultFastOrder) {
                if (available.includes(pref)) matched.push(pref);
            }
            for (const m of available) {
                if ((m.includes('flash') || m.includes('transcribe')) && !matched.includes(m)) {
                    matched.push(m);
                }
            }
            if (matched.length > 0) {
                cachedModelName = matched[0];
                return matched;
            }
        }
    } catch (e) {
        console.error('[Gemini] Error listing models:', e.message);
    }
    return defaultFastOrder;
}

async function transcribeAudio(audioBase64) {
    const modelsToTry = await getFastGeminiModels();
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים. אם מדובר בתוכן לא ראוי שאינו מתאים לאורח חיים תורני-חרדי (כגון תרבות חילונית, סרטים, ספורט, רכילות או שירים פסולים), החזר את המילה BLOCKED בלבד.";

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 4)) {
        console.log(`[Gemini] Attempting transcription with model: ${model}`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        try {
            const res = await fetchWithTimeout(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inlineData: { mimeType: 'audio/wav', data: audioBase64 } }
                        ]
                    }],
                    generationConfig: {
                        temperature: 0.1,
                        maxOutputTokens: 60
                    }
                })
            }, 12000);

            if (res.ok) {
                cachedModelName = model;
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Gemini] Model ${model} success:`, JSON.stringify(text));
                return text;
            }

            lastErr = await res.text();
            console.warn(`[Gemini] Model ${model} failed (${res.status}):`, lastErr.slice(0, 200));
            if (cachedModelName === model) cachedModelName = null;
        } catch (err) {
            lastErr = err.message;
            console.warn(`[Gemini] Model ${model} timeout/error:`, err.message);
            if (cachedModelName === model) cachedModelName = null;
        }
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// 3. איתור מהיר של כתובות שמע משרתי פרוקסי (ללא קריסת FFmpeg)
async function getProxyAudioUrls(videoId) {
    const urls = [];

    const invidiousHosts = [
        'https://yt.chocolatemoo53.com',
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.jing.rocks',
        'https://invidious.privacyredirect.com',
        'https://iv.ggtyler.dev'
    ];

    try {
        const listRes = await fetchWithTimeout('https://api.invidious.io/instances.json?sort_by=health', {}, 3500);
        if (listRes.ok) {
            const listData = await listRes.json();
            for (const item of listData) {
                if (Array.isArray(item) && item[1] && item[1].type === 'https' && item[1].api === true) {
                    const uri = item[1].uri.replace(/\/+$/, '');
                    if (!invidiousHosts.includes(uri)) invidiousHosts.splice(1, 0, uri);
                }
            }
        }
    } catch (e) {}

    for (const host of invidiousHosts.slice(0, 7)) {
        try {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            }, 4000);
            if (apiRes.ok) {
                const data = await apiRes.json();
                const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
                if (formats.length > 0) {
                    formats.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
                    for (const fmt of formats.slice(0, 2)) {
                        const itag = fmt.itag || 140;
                        urls.push(`${host}/latest_version?id=${videoId}&itag=${itag}&local=true`);
                    }
                    console.log(`[Proxy Audio] Found Invidious stream via ${host} (itag ${formats[0].itag})`);
                    if (urls.length >= 2) break;
                }
            }
        } catch (e) {}
    }

    // הוספת כתובות פרוקסי ישירות לגיבוי
    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=139&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=251&local=true`);
    }

    return [...new Set(urls)];
}

// 4. הורדת השמע באמצעות Node.js (כדי ש-FFmpeg לא ייגש ל-HTTPS ולא יקרוס עם SIGSEGV!)
// מוריד עד 6MB ראשונים של השמע (כ-10-15 דקות של שיעור) תוך שניות בודדות וממיר מקומית ל-WAV
async function downloadViaNodeAndConvertToWav(streamUrl, outputWavPath, maxBytes = 6 * 1024 * 1024) {
    const tmpInput = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.audio`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 14000);

    try {
        const res = await fetch(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Range': `bytes=0-${maxBytes}`
            },
            signal: controller.signal
        });

        if (!res.ok && res.status !== 206) {
            throw new Error(`HTTP ${res.status}`);
        }

        const cType = (res.headers.get('content-type') || '').toLowerCase();
        if (cType.includes('text/html') || cType.includes('application/json')) {
            throw new Error(`Invalid content-type: ${cType}`);
        }

        const fileStream = fs.createWriteStream(tmpInput);
        let downloaded = 0;

        for await (const chunk of res.body) {
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (downloaded >= maxBytes) {
                try { controller.abort(); } catch (e) {}
                break;
            }
        }

        await new Promise(resolve => fileStream.end(resolve));
        clearTimeout(timeoutId);

        if (downloaded < 8000) {
            throw new Error(`Downloaded file too small (${downloaded} bytes)`);
        }

        console.log(`[Node Download] Downloaded ${downloaded} bytes to local disk. Running local FFmpeg...`);

        // כעת FFmpeg קורא קובץ מקומי מהדיסק ולא מהאינטרנט - לעולם לא יקרוס עם SIGSEGV!
        await new Promise((resolve, reject) => {
            const ffTimer = setTimeout(() => reject(new Error('Local FFmpeg timeout')), 12000);
            ffmpeg(tmpInput)
                .format('wav')
                .audioCodec('pcm_s16le')
                .audioChannels(1)
                .audioFrequency(8000)
                .duration(600)
                .on('end', () => {
                    clearTimeout(ffTimer);
                    resolve();
                })
                .on('error', (err) => {
                    clearTimeout(ffTimer);
                    reject(err);
                })
                .save(outputWavPath);
        });

        fs.promises.unlink(tmpInput).catch(() => null);
        return true;

    } catch (err) {
        clearTimeout(timeoutId);
        fs.promises.unlink(tmpInput).catch(() => null);
        throw err;
    }
}

// 5. הורדה, המרה מקומית והעלאה ישירה לימות המשיח
async function downloadAndUploadToYemot(videoId, apiExtension) {
    const tmpWav = path.join(os.tmpdir(), `ym_${videoId}_${Date.now()}.wav`);
    const extFolder = String(apiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const yemotTargetPath = extFolder ? `ivr2:/${extFolder}/100.wav` : `ivr2:/100.wav`;
    const playFileCommand = extFolder ? `f-/${extFolder}/100` : `f-/100`;

    try {
        console.log(`[Step 5 Audio] Fetching proxy URLs for ${videoId}...`);
        const proxyUrls = await getProxyAudioUrls(videoId);
        let converted = false;

        for (const pUrl of proxyUrls.slice(0, 6)) {
            if (converted) break;
            try {
                console.log(`[Step 5 Audio] Downloading via Node from: ${pUrl.slice(0, 85)}...`);
                await downloadViaNodeAndConvertToWav(pUrl, tmpWav);
                if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 5000) {
                    console.log(`[Step 5 Audio] Local WAV created successfully (${fs.statSync(tmpWav).size} bytes)!`);
                    converted = true;
                }
            } catch (pErr) {
                console.warn(`[Step 5 Audio] Attempt failed (${pErr.message})`);
            }
        }

        if (!converted) {
            throw new Error('All proxy download attempts failed');
        }

        const wavBuffer = await fs.promises.readFile(tmpWav);
        console.log(`[Step 5 Upload] Uploading ${wavBuffer.length} bytes to Yemot (${yemotTargetPath})...`);

        const formData = new FormData();
        formData.append('token', TOKEN);
        formData.append('path', yemotTargetPath);
        formData.append('convertAudio', '0');
        formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), '100.wav');

        const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
            method: 'POST',
            body: formData
        }, 20000);

        const upText = await upRes.text();
        console.log('[Step 5 Upload] Yemot response:', upText.slice(0, 200));

        fs.promises.unlink(tmpWav).catch(() => null);
        return playFileCommand;

    } catch (e) {
        fs.promises.unlink(tmpWav).catch(() => null);
        throw e;
    }
}

app.get('/', (req, res) => { res.send('YouTube Line Server v9.0 OK - Node Stream Downloader (No SIGSEGV)'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        // שלב 1: בקשת הקלטה
        if (!q.RecordPath) {
            return res.send('read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=RecordPath,no,record,,,no,7,1');
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(q.RecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח&go_to_folder=/');
        }

        // שלב 3: תמלול מהיר ב-Gemini
        let rawText = '';
        try {
            rawText = await transcribeAudio(audioBuf.toString('base64'));
        } catch (gemErr) {
            console.error('[Step 3 Error]', gemErr.message);
            return res.send('id_list_message=t-שגיאה בתקשורת עם מנוע זיהוי הדיבור&go_to_folder=/');
        }

        if (rawText.includes('BLOCKED')) {
            return res.send('id_list_message=t-המערכת מיועדת לחיפוש שיעורי תורה בלבד&go_to_folder=/');
        }

        const cleanQuery = rawText.replace(/[^א-תa-zA-Z0-9\s]/g, ' ').trim().replace(/\s+/g, ' ');
        console.log('[Step 3 Clean Query]', cleanQuery);

        if (!cleanQuery) {
            return res.send('id_list_message=t-לא הצלחתי לשמוע את הבקשה אנא נסו שנית&go_to_folder=/');
        }

        // שלב 4: חיפוש השיעור
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl, {}, 10000);
        const ytData = await ytRes.json();

        if (!ytRes.ok) {
            console.error('[Step 4 Error]', JSON.stringify(ytData));
            return res.send('id_list_message=t-שגיאה במפתח החיפוש&go_to_folder=/');
        }

        if (!ytData.items || ytData.items.length === 0) {
            return res.send(`id_list_message=t-לא נמצאו תוצאות עבור ${cleanQuery}&go_to_folder=/`);
        }

        const videoId = ytData.items[0].id.videoId;
        const title = (ytData.items[0].snippet.title || '').replace(/[^א-תa-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        console.log(`[Step 4 Match] Video ${videoId}: ${title}`);

        // שלב 5: הורדה דרך Node.js, המרה מקומית ל-WAV והעלאה לימות המשיח
        try {
            const playCmd = await downloadAndUploadToYemot(videoId, q.ApiExtension);
            console.log(`[Step 5 Ready] Sending play command: ${playCmd}`);
            return res.send(`id_list_message=t-משמיע ${title}.${playCmd}&go_to_folder=/`);
        } catch (audioErr) {
            console.error('[Step 5 Error]', audioErr.message);
            return res.send(`id_list_message=t-נמצא השיעור ${title} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
        }

    } catch (e) {
        console.error('[General Error v9.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v9.0 Ready on port ${port} ===`));
