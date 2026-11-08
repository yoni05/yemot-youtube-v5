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
const ARCHIVE_EXT = '8'; // שלוחה 8 לשמירת כל ההקלטות וההשמעות לתמיד

let cachedModelName = null;

// זיכרון לשמירת ההורדה הקודמת של כל מתקשר (וגם ההורדה האחרונה הכללית בקו)
const lastDownloadByPhone = new Map();
let globalLastDownload = null;

// מונים מקומיים לכל תיקייה כדי להבטיח שאפילו שני קבצים שעולים באותה שנייה בדיוק יקבלו מספר עוקב שונה ולעולם לא ידרסו זה את זה!
const folderCounters = {};

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

// פונקציה שבודקת מול ימות המשיח מהו מספר הקובץ הגבוה ביותר בתיקייה ומחזירה את המספר הפנוי הבא (למשל "000", "001", "002"...)
// כך שאנו נותנים לכל קובץ שם מפורש וייחודי בעצמנו, ואף קובץ לעולם לא נדרס!
async function getNextFileNumberStr(folder, reserveCount = 1) {
    const cleanFolder = String(folder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    let maxExisting = -1;

    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 8000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            for (const f of files) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.wav$/i);
                if (m) {
                    const num = parseInt(m[1], 10);
                    // מתעלמים מקובצי 900+ אם היו קובצי מערכת זמניים ישנים
                    if (!isNaN(num) && num < 900 && num > maxExisting) {
                        maxExisting = num;
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[GetIVR2Dir] Warning checking ${folderPath}:`, e.message);
    }

    const currentMem = (folderCounters[cleanFolder] !== undefined) ? folderCounters[cleanFolder] : -1;
    const baseNum = Math.max(maxExisting, currentMem);
    const startNum = baseNum + 1;
    folderCounters[cleanFolder] = baseNum + reserveCount;

    const result = [];
    for (let i = 0; i < reserveCount; i++) {
        result.push(String(startNum + i).padStart(3, '0'));
    }
    return reserveCount === 1 ? result[0] : result;
}

// בירור הקובץ האחרון שקיים בשלוחה בימות המשיח (עבור הקשה על 2 - האזנה להורדה הקודמת)
async function getExtensionLatestAudioFile(extFolder) {
    const cleanFolder = String(extFolder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 8000);
        if (res.ok) {
            const data = await res.json();
            const nums = [];
            for (const f of (data.files || [])) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.wav$/i);
                if (m) {
                    const n = parseInt(m[1], 10);
                    if (!isNaN(n) && n < 900) nums.push(n);
                }
            }
            if (nums.length > 0) {
                nums.sort((a, b) => b - a);
                const latestNum = String(nums[0]).padStart(3, '0');
                return cleanFolder ? `f-/${cleanFolder}/${latestNum}` : `f-/${latestNum}`;
            }
        }
    } catch (e) {
        console.warn('[Yemot Dir Check] Could not list directory:', e.message);
    }
    return null;
}

// פונקציית העלאת קובץ WAV לנתיב מדויק בימות המשיח (למשל ivr2:/9/005.wav או ivr2:/8/012.wav)
async function uploadWavBufferToExactPath(wavBuffer, exactTargetPath, fileNameLabel = 'audio.wav', timeoutMs = 35000) {
    const formData = new FormData();
    formData.append('token', TOKEN);
    formData.append('path', exactTargetPath);
    formData.append('convertAudio', '0');
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), fileNameLabel);

    const upRes = await fetchWithTimeout(`${YM}UploadFile`, {
        method: 'POST',
        body: formData
    }, timeoutMs);

    const upText = await upRes.text();
    console.log(`[Yemot Upload -> ${exactTargetPath}] Response:`, upText.slice(0, 220));
    return upText;
}

// 1. הורדת הקלטת הבקשה מימות המשיח (ללא מחיקה! + העתקה לשלוחה 8 כדי שכל ההקלטות יישמרו לתמיד בשלוחה 8!)
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
                // איננו מוחקים שום הקלטה לעולם!
                // בנוסף, אנו שומרים מיד עותק של הקלטת הבקשה בשלוחה 8 עם מספר סידורי חדש כדי שתישמר שם לתמיד:
                (async () => {
                    try {
                        const nextArchNum = await getNextFileNumberStr(ARCHIVE_EXT, 1);
                        const archRecPath = `ivr2:/${ARCHIVE_EXT}/${nextArchNum}.wav`;
                        await uploadWavBufferToExactPath(buf, archRecPath, `${nextArchNum}.wav`, 20000);
                        console.log(`[Archive Ext 8] Saved user request recording permanently to ${archRecPath}`);
                    } catch (archErr) {
                        console.warn('[Archive Ext 8] Failed saving user recording to ext 8:', archErr.message);
                    }
                })();
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

// 6. הורדה, המרה מקומית והעלאה לימות המשיח בשם ממוספר עולה מפורש (000.wav, 001.wav, 002.wav...)
// גם לשלוחה הנוכחית וגם לשלוחה 8 – כך שאף קובץ לעולם לא נדרס!
async function downloadAndUploadToYemot(videoId, apiExtension, title, phone) {
    const tmpWav = path.join(os.tmpdir(), `ym_${videoId}_${Date.now()}.wav`);
    const extFolder = String(apiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');

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

        // קבלת המספר הפנוי הבא בשלוחה הנוכחית (למשל 000, 001, 002...)
        const nextExtNum = await getNextFileNumberStr(extFolder, 1);
        const yemotTargetPath = extFolder ? `ivr2:/${extFolder}/${nextExtNum}.wav` : `ivr2:/${nextExtNum}.wav`;
        const playFileCommand = extFolder ? `f-/${extFolder}/${nextExtNum}` : `f-/${nextExtNum}`;

        console.log(`[Step 5 Upload] Uploading ${wavBuffer.length} bytes to ${yemotTargetPath} (never overwrites!)...`);
        await uploadWavBufferToExactPath(wavBuffer, yemotTargetPath, `${nextExtNum}.wav`, 35000);

        // העלאה מקבילה גם לשלוחה 8 (ארכיון קבוע של כל ההשמעות וההקלטות)
        if (extFolder !== ARCHIVE_EXT) {
            (async () => {
                try {
                    const nextArchNum = await getNextFileNumberStr(ARCHIVE_EXT, 1);
                    const archAudioPath = `ivr2:/${ARCHIVE_EXT}/${nextArchNum}.wav`;
                    await uploadWavBufferToExactPath(wavBuffer, archAudioPath, `${nextArchNum}.wav`, 35000);
                    console.log(`[Archive Ext 8] Saved downloaded audio permanently to ${archAudioPath}`);
                } catch (archErr) {
                    console.warn('[Archive Ext 8] Failed saving audio to ext 8:', archErr.message);
                }
            })();
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

app.get('/', (req, res) => { res.send('YouTube Line Server v10.5 OK - Permanent Numbered Files + Ext 8 Archive'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const extFolder = String(q.ApiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
        const callerPhone = String(q.ApiPhone || '').trim();

        // שלב 0: תפריט פתיחה
        if (!q.MenuChoice && !q.RecordPath) {
            return res.send('read=t-לחיפוש חדש הקישו 1 להאזנה להורדה הקודמת הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // אם המשתמש הקיש 2 -> השמעת ההורדה הקודמת מיד
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
                // אם אין עדיין הורדה קודמת, מבקשים הקלטה חדשה עם מספר קובץ ייחודי שלא דורס כלום
                const recNum = await getNextFileNumberStr(extFolder, 1);
                const recFolder = extFolder ? `/${extFolder}` : '';
                return res.send(`id_list_message=t-עדיין לא קיימת הורדה קודמת בקו&read=t-אנא אמרו את שם השיעור או השיר המבוקש ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
            }
        }

        // שלב 1: המשתמש בחר 1 -> מבקשים הקלטה של החיפוש החדש
        // כל הקלטת בקשה מקבלת מספר קובץ עולה חדש משלה (למשל 000, 001, 002...) וכך גם ההקלטות נשמרות בשלוחה ולא נדרסות!
        if (!q.RecordPath) {
            const recNum = await getNextFileNumberStr(extFolder, 1);
            const recFolder = extFolder ? `/${extFolder}` : '';
            return res.send(`read=t-אנא אמרו את שם השיעור או השיר המבוקש ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
        }

        // שלב 2: הורדת ההקלטה מימות המשיח (ללא מחיקה + העתקה לשלוחה 8)
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

        // שלב 5: הורדה מלאה, המרה מקומית ל-WAV והעלאה לימות המשיח במספר סידורי חדש (גם לשלוחה הנוכחית וגם לשלוחה 8!)
        try {
            const playCmd = await downloadAndUploadToYemot(videoId, q.ApiExtension, title, callerPhone);
            console.log(`[Step 5 Ready] Sending play command: ${playCmd}`);
            return res.send(`id_list_message=t-משמיע ${title}.${playCmd}&go_to_folder=/`);
        } catch (audioErr) {
            console.error('[Step 5 Error]', audioErr.message);
            return res.send(`id_list_message=t-נמצא ${title} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
        }

    } catch (e) {
        console.error('[General Error v10.5]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v10.5 Ready on port ${port} ===`));
