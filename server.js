const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ytdl = require('@distube/ytdl-core');

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const TOKEN = (process.env.YEMOT_TOKEN || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const YM = 'https://www.call2all.co.il/ym/api/';

let cachedModelName = null;

// זיכרון לשמירת ההורדה הקודמת של כל מתקשר (וגם ההורדה האחרונה הכללית בקו)
const lastDownloadByPhone = new Map();
let globalLastDownload = null;

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

// בירור הקובץ האחרון שקיים בשלוחה בימות המשיח (כדי שלא נדרוס הורדות קודמות וגם נדע מה ההורדה האחרונה אחרי הפעלה מחדש)
async function getExtensionLatestAudioFile(extFolder) {
    const folderPath = extFolder ? `ivr2:/${extFolder}` : `ivr2:/`;
    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 8000);
        if (res.ok) {
            const data = await res.json();
            const files = (data.files || [])
                .filter(f => f && f.name && /^\d{3,}\.wav$/i.test(f.name))
                .map(f => parseInt(f.name.replace(/\D/g, ''), 10))
                .filter(n => !isNaN(n) && n >= 100 && n < 900);
            if (files.length > 0) {
                files.sort((a, b) => b - a);
                const latestNum = String(files[0]).padStart(3, '0');
                return extFolder ? `f-/${extFolder}/${latestNum}` : `f-/${latestNum}`;
            }
        }
    } catch (e) {
        console.warn('[Yemot Dir Check] Could not list directory:', e.message);
    }
    return null;
}

// 1. הורדת ההקלטה מימות המשיח (מוחק רק את הקלטת הדיבור הקצרה של המשתמש ולא את השירים/השיעורים שהורדו!)
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
                // מוחקים רק את קובץ הקלטת הבקשה הזמני (כדי שלא יתפוס מספר קובץ של הורדה)
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

// 3. המרת קובץ שמע מקומי ל-WAV תקני לימות המשיח (ללא קריסת FFmpeg)
async function convertLocalFileToWav(inputPath, outputWavPath) {
    await new Promise((resolve, reject) => {
        const ffTimer = setTimeout(() => reject(new Error('Local FFmpeg timeout')), 25000);
        ffmpeg(inputPath)
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(8000)
            .duration(1800)
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
}

// 4. שיטה א' (ראשית): הורדה ישירה דרך @distube/ytdl-core בתוך Node.js
async function downloadViaYtdlAndConvert(videoId, outputWavPath, maxBytes = 15 * 1024 * 1024) {
    const tmpInput = path.join(os.tmpdir(), `ytdl_${Date.now()}_${Math.random().toString(36).slice(2)}.audio`);
    return new Promise((resolve, reject) => {
        let downloaded = 0;
        let finished = false;
        const fileStream = fs.createWriteStream(tmpInput);

        const cleanup = () => {
            fs.promises.unlink(tmpInput).catch(() => null);
        };

        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                try { stream.destroy(); } catch (e) {}
                fileStream.end(() => {
                    if (downloaded > 500000) {
                        console.log(`[ytdl-core] Timeout reached but got ${downloaded} bytes, converting...`);
                        convertLocalFileToWav(tmpInput, outputWavPath).then(() => { cleanup(); resolve(true); }).catch(err => { cleanup(); reject(err); });
                    } else {
                        cleanup();
                        reject(new Error(`ytdl-core timeout (${downloaded} bytes)`));
                    }
                });
            }
        }, 45000);

        const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
            filter: 'audioonly',
            quality: 'lowestaudio',
            highWaterMark: 1 << 20
        });

        stream.on('data', (chunk) => {
            if (finished) return;
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (downloaded >= maxBytes) {
                finished = true;
                clearTimeout(timer);
                try { stream.destroy(); } catch (e) {}
                fileStream.end(async () => {
                    try {
                        console.log(`[ytdl-core] Downloaded ${downloaded} bytes to disk. Running local FFmpeg...`);
                        await convertLocalFileToWav(tmpInput, outputWavPath);
                        cleanup();
                        resolve(true);
                    } catch (e) {
                        cleanup();
                        reject(e);
                    }
                });
            }
        });

        stream.on('end', () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            fileStream.end(async () => {
                try {
                    if (downloaded < 50000) throw new Error(`ytdl-core file too small (${downloaded} bytes)`);
                    console.log(`[ytdl-core] Stream ended (${downloaded} bytes). Running local FFmpeg...`);
                    await convertLocalFileToWav(tmpInput, outputWavPath);
                    cleanup();
                    resolve(true);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            });
        });

        stream.on('error', (err) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            fileStream.end(() => {
                cleanup();
                reject(err);
            });
        });
    });
}

// 5. שיטה ב' + ג' (גיבוי): חילוץ כתובות שמע מ-Piped API ו-Invidious
async function getFallbackAudioUrls(videoId) {
    const urls = [];

    // גיבוי 1: Piped APIs (ללא כתובות googlevideo.com ישירות שנחסמות ב-403)
    const pipedHosts = [
        'https://pipedapi.kavin.rocks',
        'https://pipedapi.tokhmi.xyz',
        'https://pipedapi.moomoo.me',
        'https://pipedapi.syncpundit.io',
        'https://api.piped.projectsegfau.lt',
        'https://pipedapi.smnz.de'
    ];

    for (const host of pipedHosts) {
        try {
            const res = await fetchWithTimeout(`${host}/streams/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            }, 4000);
            if (res.ok) {
                const data = await res.json();
                const streams = (data.audioStreams || []).filter(s => s.url && !s.url.includes('googlevideo.com'));
                if (streams.length > 0) {
                    streams.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
                    for (const st of streams.slice(0, 2)) {
                        urls.push(st.url);
                    }
                    console.log(`[Fallback Audio] Found Piped stream via ${host}`);
                    if (urls.length >= 2) break;
                }
            }
        } catch (e) {}
    }

    // גיבוי 2: Invidious API (שימוש ב-local=true עם העדפה ל-itag=140/251 המהירים ולא ל-139 האיטי)
    const invidiousHosts = [
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.privacyredirect.com',
        'https://yt.chocolatemoo53.com',
        'https://inv.nadeko.net'
    ];

    for (const host of invidiousHosts) {
        try {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            }, 4000);
            if (apiRes.ok) {
                const data = await apiRes.json();
                const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
                if (formats.length > 0) {
                    formats.sort((a, b) => {
                        const aIs140 = String(a.itag) === '140' ? 0 : (String(a.itag) === '251' ? 1 : 2);
                        const bIs140 = String(b.itag) === '140' ? 0 : (String(b.itag) === '251' ? 1 : 2);
                        if (aIs140 !== bIs140) return aIs140 - bIs140;
                        return (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999);
                    });
                    for (const fmt of formats.slice(0, 3)) {
                        const itag = fmt.itag || 140;
                        urls.push(`${host}/latest_version?id=${videoId}&itag=${itag}&local=true`);
                    }
                    console.log(`[Fallback Audio] Found Invidious stream via ${host} (itag ${formats[0].itag})`);
                    if (urls.length >= 4) break;
                }
            }
        } catch (e) {}
    }

    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=251&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=139&local=true`);
    }

    return [...new Set(urls)];
}

async function downloadViaNodeAndConvertToWav(streamUrl, outputWavPath, maxBytes = 15 * 1024 * 1024) {
    const tmpInput = path.join(os.tmpdir(), `dl_${Date.now()}_${Math.random().toString(36).slice(2)}.audio`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    let downloaded = 0;
    try {
        const res = await fetch(streamUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': '*/*'
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
        const reader = res.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                downloaded += value.length;
                fileStream.write(Buffer.from(value));
                if (downloaded >= maxBytes) {
                    await reader.cancel().catch(() => null);
                    break;
                }
            }
        } catch (readErr) {
            if (downloaded < 600000) throw readErr;
        }

        await new Promise(resolve => fileStream.end(resolve));
        clearTimeout(timeoutId);

        if (downloaded < 250000) {
            throw new Error(`Downloaded file too partial/small (${downloaded} bytes)`);
        }

        console.log(`[Node Download] Downloaded ${downloaded} bytes to local disk. Running local FFmpeg...`);
        await convertLocalFileToWav(tmpInput, outputWavPath);
        fs.promises.unlink(tmpInput).catch(() => null);
        return true;

    } catch (err) {
        clearTimeout(timeoutId);
        fs.promises.unlink(tmpInput).catch(() => null);
        throw err;
    }
}

// 6. הורדה, המרה מקומית והעלאה לימות המשיח תוך שמירת כל ההורדות הקודמות בשלוחה!
// שימוש ב-autoNumbering של ימות המשיח (path=ivr2:/9/ ללא שם קובץ קבוע) או מספור עולה,
// כך שכל הורדה נשמרת כקובץ חדש בשלוחה (000.wav, 001.wav, 002.wav...) ולא דורסת את ההורדה הקודמת!
async function downloadAndUploadToYemot(videoId, apiExtension, title, phone) {
    const tmpWav = path.join(os.tmpdir(), `ym_${videoId}_${Date.now()}.wav`);
    const extFolder = String(apiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    // שליחת נתיב התיקייה עם סלאש בסוף גורמת לימות המשיח לתת לקובץ מספר סידורי חדש אוטומטית (ולא לדרוס את הקובץ הקודם!)
    const yemotTargetDir = extFolder ? `ivr2:/${extFolder}/` : `ivr2:/`;

    try {
        let converted = false;

        // ניסיון 1: הורדה ישירה ומהירה דרך @distube/ytdl-core
        try {
            console.log(`[Step 5 Audio] Trying primary engine (@distube/ytdl-core) for ${videoId}...`);
            await downloadViaYtdlAndConvert(videoId, tmpWav);
            if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 50000) {
                console.log(`[Step 5 Audio] Primary engine succeeded (${fs.statSync(tmpWav).size} bytes)!`);
                converted = true;
            }
        } catch (ytdlErr) {
            console.warn(`[Step 5 Audio] Primary engine failed (${ytdlErr.message}), falling back to Piped/Invidious...`);
        }

        // ניסיון 2: שרתי גיבוי (Piped / Invidious)
        if (!converted) {
            const proxyUrls = await getFallbackAudioUrls(videoId);
            for (const pUrl of proxyUrls.slice(0, 8)) {
                if (converted) break;
                try {
                    console.log(`[Step 5 Audio] Downloading via Node from: ${pUrl.slice(0, 85)}...`);
                    await downloadViaNodeAndConvertToWav(pUrl, tmpWav);
                    if (fs.existsSync(tmpWav) && fs.statSync(tmpWav).size > 50000) {
                        console.log(`[Step 5 Audio] Local WAV created successfully (${fs.statSync(tmpWav).size} bytes)!`);
                        converted = true;
                    }
                } catch (pErr) {
                    console.warn(`[Step 5 Audio] Attempt failed (${pErr.message})`);
                }
            }
        }

        if (!converted) {
            throw new Error('All download engines failed');
        }

        const wavBuffer = await fs.promises.readFile(tmpWav);
        console.log(`[Step 5 Upload] Uploading ${wavBuffer.length} bytes to Yemot directory (${yemotTargetDir}) with auto-numbering...`);

        const formData = new FormData();
        formData.append('token', TOKEN);
        formData.append('path', yemotTargetDir);
        formData.append('convertAudio', '0');
        formData.append('autoNumbering', 'true');
        formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');

        const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
            method: 'POST',
            body: formData
        }, 35000);

        const upText = await upRes.text();
        console.log('[Step 5 Upload] Yemot response:', upText.slice(0, 250));

        // פענוח שם הקובץ החדש שימות המשיח יצר (למשל "ivr/9/005.wav" -> פקודת השמעה "f-/9/005")
        let playFileCommand = extFolder ? `f-/${extFolder}/100` : `f-/100`;
        try {
            const upJson = JSON.parse(upText);
            if (upJson && upJson.path) {
                const cleaned = String(upJson.path)
                    .replace(/^ivr2?:\/*/i, '')
                    .replace(/^\/*/, '')
                    .replace(/\.wav$/i, '');
                playFileCommand = `f-/${cleaned}`;
            }
        } catch (parseErr) {}

        // גיבוי: אם מסיבה כלשהי ימות המשיח לא החזיר path ב-JSON, נשמור גם ב-100.wav
        if (playFileCommand.endsWith('/100') && !upText.includes('00') && !upText.includes('100')) {
            const fallbackPath = extFolder ? `ivr2:/${extFolder}/100.wav` : `ivr2:/100.wav`;
            const fbForm = new FormData();
            fbForm.append('token', TOKEN);
            fbForm.append('path', fallbackPath);
            fbForm.append('convertAudio', '0');
            fbForm.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), '100.wav');
            await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: fbForm }, 25000).catch(() => null);
        }

        // שמירת ההורדה בזיכרון עבור המתקשר הנוכחי ועבור הקו כולו
        const savedInfo = { playCmd: playFileCommand, title: title || 'ההורדה הקודמת', time: Date.now() };
        if (phone) lastDownloadByPhone.set(phone, savedInfo);
        globalLastDownload = savedInfo;

        fs.promises.unlink(tmpWav).catch(() => null);
        return playFileCommand;

    } catch (e) {
        fs.promises.unlink(tmpWav).catch(() => null);
        throw e;
    }
}

app.get('/', (req, res) => { res.send('YouTube Line Server v10.4 OK - Saved Previous Downloads Support'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const extFolder = String(q.ApiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
        const callerPhone = String(q.ApiPhone || '').trim();

        // שלב 0: אם המשתמש עוד לא בחר בתפריט ועדיין לא הקליט
        if (!q.MenuChoice && !q.RecordPath) {
            return res.send('read=t-לחיפוש חדש הקישו 1 להאזנה להורדה הקודמת הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // אם המשתמש הקיש 2 -> השמעת ההורדה הקודמת מיד ללא צורך בהורדה מחדש!
        if (q.MenuChoice === '2' && !q.RecordPath) {
            let prev = (callerPhone && lastDownloadByPhone.get(callerPhone)) || globalLastDownload;
            if (!prev) {
                const latestCmd = await getExtensionLatestAudioFile(extFolder);
                if (latestCmd) {
                    prev = { playCmd: latestCmd, title: 'ההורדה האחרונה בקו' };
                }
            }
            if (prev && prev.playCmd) {
                console.log(`[Replay Previous] Playing ${prev.playCmd} (${prev.title}) for ${callerPhone}`);
                return res.send(`id_list_message=t-משמיע את ${prev.title}.${prev.playCmd}&go_to_folder=/`);
            } else {
                // אם אין עדיין שום הורדה קודמת בשלוחה, מעבירים אותו להקלטת חיפוש חדש
                return res.send('id_list_message=t-עדיין לא קיימת הורדה קודמת בקו&read=t-אנא אמרו את שם השיעור או השיר המבוקש ובסיום הקישו סולמית=RecordPath,no,record,,,no,7,1');
            }
        }

        // שלב 1: המשתמש בחר 1 (או כל מקש אחר) -> מבקשים הקלטה של החיפוש החדש
        // אנו שומרים את ההקלטה הזמנית בתור קובץ שממוספר גבוה (999.wav) כדי שלא תתערבב עם קובצי השירים שנשמרים בשלוחה!
        if (!q.RecordPath) {
            const tempRecFolder = extFolder ? `/${extFolder}` : '';
            return res.send(`read=t-אנא אמרו את שם השיעור או השיר המבוקש ובסיום הקישו סולמית=RecordPath,no,record,${tempRecFolder},999,no,7,1`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(q.RecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח&go_to_folder=/');
        }

        // שלב 3: תמלול מהיר ב-Gemini (ללא סינון)
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

        // שלב 4: חיפוש ביוטיוב
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

        // שלב 5: הורדה מלאה, המרה מקומית ל-WAV והעלאה לימות המשיח (ללא דריסת קבצים קודמים!)
        try {
            const playCmd = await downloadAndUploadToYemot(videoId, q.ApiExtension, title, callerPhone);
            console.log(`[Step 5 Ready] Sending play command: ${playCmd}`);
            return res.send(`id_list_message=t-משמיע ${title}.${playCmd}&go_to_folder=/`);
        } catch (audioErr) {
            console.error('[Step 5 Error]', audioErr.message);
            return res.send(`id_list_message=t-נמצא ${title} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
        }

    } catch (e) {
        console.error('[General Error v10.4]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v10.4 Ready on port ${port} ===`));
