const express = require('express');
const ytDlp = require('yt-dlp-exec');
const ytdl = require('@distube/ytdl-core');
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
            const res = await fetchWithTimeout(url, {}, 12000);
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
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 8000);
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
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.";

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
            }, 14000);

            if (res.ok) {
                cachedModelName = model;
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Gemini] Model ${model} success:`, JSON.stringify(text));
                return text;
            }

            lastErr = await res.text();
            console.warn(`[Gemini] Model ${model} failed (${res.status}):`, lastErr.slice(0, 250));
            if (cachedModelName === model) cachedModelName = null;
        } catch (err) {
            lastErr = err.message;
            console.warn(`[Gemini] Model ${model} timeout/error:`, err.message);
            if (cachedModelName === model) cachedModelName = null;
        }
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// 3. מנוע שליפת שמע עוקף חסימות IP של Render (דינמי: Invidious + Piped + Cobalt)
async function getProxyAudioUrls(videoId) {
    const urls = [];

    // א. שליפה דינמית של שרתי Invidious פעילים ותקינים בזמן אמת
    const invidiousHosts = [
        'https://inv.nadeko.net',
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.jing.rocks',
        'https://invidious.privacyredirect.com',
        'https://iv.ggtyler.dev',
        'https://invidious.lunar.icu'
    ];

    try {
        const listRes = await fetchWithTimeout('https://api.invidious.io/instances.json?sort_by=health', {}, 4000);
        if (listRes.ok) {
            const listData = await listRes.json();
            for (const item of listData) {
                if (Array.isArray(item) && item[1] && item[1].type === 'https' && item[1].api === true) {
                    const uri = item[1].uri.replace(/\/+$/, '');
                    if (!invidiousHosts.includes(uri)) invidiousHosts.unshift(uri);
                }
            }
        }
    } catch (e) {}

    for (const host of invidiousHosts.slice(0, 8)) {
        try {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 4500);
            if (apiRes.ok) {
                const data = await apiRes.json();
                const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
                if (formats.length > 0) {
                    formats.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
                    const itag = formats[0].itag || 140;
                    // שימוש ב-local=true מכריח את שרת ה-Invidious להזרים את השמע דרכו וכך עוקף את חסימת ה-IP של Render!
                    urls.push(`${host}/latest_version?id=${videoId}&itag=${itag}&local=true`);
                    if (formats[0].url) urls.push(formats[0].url);
                    console.log(`[Proxy Audio] Found Invidious stream via ${host} (itag ${itag})`);
                    break;
                }
            }
        } catch (e) {}
    }

    // ב. שרתי Piped פעילים
    const pipedHosts = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.leptons.xyz',
        'https://pipedapi.nosebs.ru',
        'https://api.piped.private.coffee',
        'https://pipedapi.drgns.space'
    ];

    for (const api of pipedHosts) {
        if (urls.length >= 2) break;
        try {
            const res = await fetchWithTimeout(`${api}/streams/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 4500);
            if (res.ok) {
                const data = await res.json();
                const streams = data.audioStreams || [];
                if (streams.length > 0) {
                    streams.sort((a, b) => (a.bitrate || 999999) - (b.bitrate || 999999));
                    if (streams[0].url) {
                        console.log(`[Proxy Audio] Found Piped stream via ${api}`);
                        urls.push(streams[0].url);
                        break;
                    }
                }
            }
        } catch (e) {}
    }

    // ג. גיבוי ישיר דרך פרוקסי Invidious מהיר גם ללא API
    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=251&local=true`);
    }

    return [...new Set(urls)];
}

// 4. המרת זרם שמע או קישור לקובץ WAV תקני של ימות המשיח (8000Hz, Mono, 16-bit PCM)
async function convertSourceToWav(inputSource, outputWavPath, maxDurationSec = 480) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('FFmpeg conversion timed out'));
        }, 18000);

        ffmpeg(inputSource)
            .inputOptions(['-reconnect 1', '-reconnect_streamed 1', '-reconnect_delay_max 4'])
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(8000)
            .duration(maxDurationSec)
            .on('end', () => {
                clearTimeout(timer);
                resolve();
            })
            .on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            })
            .save(outputWavPath);
    });
}

// 5. הורדה חסינת-חסימות והעלאה ישירה לשלוחה בימות המשיח
async function downloadAndUploadToYemot(videoId, apiExtension) {
    const tmpWav = path.join(os.tmpdir(), `ym_${videoId}_${Date.now()}.wav`);
    const extFolder = String(apiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    const yemotTargetPath = extFolder ? `ivr2:/${extFolder}/100.wav` : `ivr2:/100.wav`;
    const playFileCommand = extFolder ? `f-/${extFolder}/100` : `f-/100`;

    try {
        let converted = false;

        // שלב א: ניסיון מהיר דרך @distube/ytdl-core עם לקוח ANDROID_VR / IOS
        try {
            console.log(`[Step 5 Audio] Trying @distube/ytdl-core for ${videoId}...`);
            await new Promise((resolve, reject) => {
                const audioStream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
                    filter: 'audioonly',
                    quality: 'lowestaudio'
                });
                const t = setTimeout(() => {
                    try { audioStream.destroy(); } catch (e) {}
                    reject(new Error('ytdl-core timeout'));
                }, 14000);

                audioStream.on('error', (err) => {
                    clearTimeout(t);
                    reject(err);
                });

                ffmpeg(audioStream)
                    .format('wav')
                    .audioCodec('pcm_s16le')
                    .audioChannels(1)
                    .audioFrequency(8000)
                    .duration(480)
                    .on('end', () => {
                        clearTimeout(t);
                        resolve();
                    })
                    .on('error', (err) => {
                        clearTimeout(t);
                        reject(err);
                    })
                    .save(tmpWav);
            });

            if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 5000) {
                console.log('[Step 5 Audio] Success via @distube/ytdl-core!');
                converted = true;
            }
        } catch (ytdlErr) {
            console.warn('[Step 5 Audio] ytdl-core failed:', ytdlErr.message.slice(0, 180));
        }

        // שלב ב: ניסיון דרך yt-dlp עם לקוח ANDROID_VR (עוקף דרישת Cookies ברוב שרתי הענן)
        if (!converted) {
            const vrProfiles = [
                'youtube:player_client=android_vr',
                'youtube:player_client=android_testsuite',
                'youtube:player_client=mediaconnect'
            ];
            for (const profile of vrProfiles) {
                if (converted) break;
                try {
                    console.log(`[Step 5 Audio] Trying yt-dlp profile ${profile}...`);
                    await new Promise((resolve, reject) => {
                        const subprocess = ytDlp.exec(`https://www.youtube.com/watch?v=${videoId}`, {
                            output: '-',
                            format: 'worstaudio/bestaudio',
                            noWarnings: true,
                            noCheckCertificates: true,
                            extractorArgs: profile
                        }, { stdio: ['ignore', 'pipe', 'pipe'] });

                        let stderrLog = '';
                        subprocess.stderr.on('data', d => { stderrLog += d.toString(); });

                        const timeoutId = setTimeout(() => {
                            try { subprocess.kill(); } catch (e) {}
                            reject(new Error('yt-dlp VR timeout'));
                        }, 14000);

                        ffmpeg(subprocess.stdout)
                            .format('wav')
                            .audioCodec('pcm_s16le')
                            .audioChannels(1)
                            .audioFrequency(8000)
                            .duration(480)
                            .on('end', () => {
                                clearTimeout(timeoutId);
                                try { subprocess.kill(); } catch (e) {}
                                resolve();
                            })
                            .on('error', (err) => {
                                clearTimeout(timeoutId);
                                try { subprocess.kill(); } catch (e) {}
                                reject(new Error(err.message + ' | ' + stderrLog.slice(-150)));
                            })
                            .save(tmpWav);
                    });

                    if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 5000) {
                        console.log(`[Step 5 Audio] Success via ${profile}!`);
                        converted = true;
                    }
                } catch (vrErr) {
                    console.warn(`[Step 5 Audio] ${profile} failed:`, vrErr.message.slice(0, 180));
                }
            }
        }

        // שלב ג: עקיפה מלאה דרך שרתי פרוקסי חיצוניים (Invidious local=true / Piped)
        if (!converted) {
            console.log('[Step 5 Audio] Fetching proxy audio URLs to bypass Render IP block...');
            const proxyUrls = await getProxyAudioUrls(videoId);
            for (const pUrl of proxyUrls.slice(0, 5)) {
                if (converted) break;
                try {
                    console.log(`[Step 5 Audio] Converting from proxy URL: ${pUrl.slice(0, 80)}...`);
                    await convertSourceToWav(pUrl, tmpWav, 480);
                    if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 5000) {
                        console.log('[Step 5 Audio] Success via Proxy URL!');
                        converted = true;
                    }
                } catch (pErr) {
                    console.warn('[Step 5 Audio] Proxy URL attempt failed:', pErr.message.slice(0, 150));
                }
            }
        }

        if (!converted) {
            throw new Error('All extraction and proxy methods failed');
        }

        const wavBuffer = await fs.promises.readFile(tmpWav);
        console.log(`[Step 5 Upload] WAV ready (${wavBuffer.length} bytes). Uploading to ${yemotTargetPath}...`);

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

app.get('/', (req, res) => { res.send('YouTube Line Server v8.0 OK - Anti-Block Proxy Engine'); });

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

        // שלב 5: הורדה עוקפת חסימות והעלאה ישירה לימות המשיח
        try {
            const playCmd = await downloadAndUploadToYemot(videoId, q.ApiExtension);
            console.log(`[Step 5 Ready] Sending play command: ${playCmd}`);
            return res.send(`id_list_message=t-משמיע ${title}.${playCmd}&go_to_folder=/`);
        } catch (audioErr) {
            console.error('[Step 5 Error]', audioErr.message);
            return res.send(`id_list_message=t-נמצא השיעור ${title} אך שרת ההורדה חסום כעת&go_to_folder=/`);
        }

    } catch (e) {
        console.error('[General Error v8.0]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v8.0 Ready on port ${port} ===`));
