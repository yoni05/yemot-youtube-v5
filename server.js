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
const TEXT_ARCHIVE_EXT = '8'; // שלוחה 8 לשמירת קובצי הטקסט וכל הקבצים שיורדים

let cachedModelName = null;
const lastDownloadByPhone = new Map();
let globalLastDownload = null;
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

// איתור המספר הפנוי הבא בתיקייה בימות המשיח (תומך בשריון מספר קבצים עוקבים עבור חלקי השיעור!)
async function getNextFileNumberStr(folder, reserveCount = 1) {
    const cleanFolder = String(folder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    let maxExisting = -1;

    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 7000);
        if (res.ok) {
            const data = await res.json();
            const files = data.files || [];
            for (const f of files) {
                const fname = (typeof f === 'string') ? f : (f && (f.name || f.fileName || ''));
                const m = String(fname).match(/^(\d+)\.(wav|tts|txt|mp3)$/i);
                if (m) {
                    const num = parseInt(m[1], 10);
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

async function getExtensionLatestAudioFile(extFolder) {
    const cleanFolder = String(extFolder || '').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    const folderPath = cleanFolder ? `ivr2:/${cleanFolder}` : `ivr2:/`;
    try {
        const url = `${YM}GetIVR2Dir?token=${encodeURIComponent(TOKEN)}&path=${encodeURIComponent(folderPath)}`;
        const res = await fetchWithTimeout(url, {}, 7000);
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
    } catch (e) {}
    return null;
}

// העלאת קובץ WAV מוכן לימות המשיח
async function uploadWavBufferToExactPath(wavBuffer, exactTargetPath, fileNameLabel = 'audio.wav', timeoutMs = 45000) {
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
    console.log(`[Yemot Upload -> ${exactTargetPath}] (${wavBuffer.length} bytes) Response:`, upText.slice(0, 180));
    return upText;
}

// שמירת קובץ הטקסט של זיהוי הדיבור (.tts + .txt) בשלוחה 8
async function saveTranscriptionTextToExt8(transcribedText, callerPhone, recFilePath) {
    try {
        const nextNum = await getNextFileNumberStr(TEXT_ARCHIVE_EXT, 1);
        const nowStr = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
        
        const ttsTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.tts`;
        const ttsForm = new FormData();
        ttsForm.append('token', TOKEN);
        ttsForm.append('path', ttsTargetPath);
        ttsForm.append('convertAudio', '0');
        ttsForm.append('file', new Blob([Buffer.from(transcribedText, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.tts`);

        await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: ttsForm }, 12000);
        console.log(`[Text Archive Ext 8] Saved TTS text file to ${ttsTargetPath}: "${transcribedText}"`);

        const txtDetails = `טקסט זיהוי דיבור: ${transcribedText}\r\nטלפון מחפש: ${callerPhone || 'לא ידוע'}\r\nזמן חיפוש: ${nowStr}\r\nקובץ הקלטה בשלוחה 9: ${recFilePath || ''}\r\n`;
        const txtTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${nextNum}.txt`;
        const txtForm = new FormData();
        txtForm.append('token', TOKEN);
        txtForm.append('path', txtTargetPath);
        txtForm.append('convertAudio', '0');
        txtForm.append('file', new Blob([Buffer.from(txtDetails, 'utf8')], { type: 'text/plain; charset=utf-8' }), `${nextNum}.txt`);

        await fetchWithTimeout(`${YM}UploadFile`, { method: 'POST', body: txtForm }, 12000);
    } catch (err) {
        console.warn('[Text Archive Ext 8] Error saving transcription text:', err.message);
    }
}

// 1. הורדת ההקלטה משלוחה 9 (ההקלטה נשמרת בשלוחה 9)
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

// 2. בחירת מודל Gemini מהיר לתמלול
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
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`, {}, 6000);
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
    } catch (e) {}
    return defaultFastOrder;
}

async function transcribeAudio(audioBase64) {
    const modelsToTry = await getFastGeminiModels();
    const prompt = "תמלל את ההקלטה לעברית. החזר אך ורק את המילים שנאמרו בהקלטה ללא שום תוספת, ללא סימני פיסוק וללא הסברים.";

    let lastErr = '';
    for (const model of modelsToTry.slice(0, 4)) {
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
            }, 10000);

            if (res.ok) {
                cachedModelName = model;
                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                console.log(`[Gemini] Model ${model} success:`, JSON.stringify(text));
                return text;
            }

            lastErr = await res.text();
            if (cachedModelName === model) cachedModelName = null;
        } catch (err) {
            lastErr = err.message;
            if (cachedModelName === model) cachedModelName = null;
        }
    }
    throw new Error('GEMINI_ERR: ' + lastErr);
}

// 3. חיתוך והמרה מהירה של מקטע ספציפי (startSec עד startSec + durationSec) לקובץ WAV תקני לימות המשיח (8000Hz Mono PCM)
async function convertSegmentToWavFast(inputPath, outputWavPath, startSec = 0, durationSec = 900) {
    await new Promise((resolve, reject) => {
        const ffTimer = setTimeout(() => reject(new Error('Local FFmpeg segment timeout')), 25000);
        let cmd = ffmpeg(inputPath);
        if (startSec > 0) {
            cmd = cmd.setStartTime(startSec);
        }
        cmd.duration(durationSec)
            .format('wav')
            .audioCodec('pcm_s16le')
            .audioChannels(1)
            .audioFrequency(8000)
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

// 4. איתור קישורי פרוקסי מהירים (itag=139/249 ששוקלים ~350KB לדקה בלבד!)
async function getFastStreamUrls(videoId) {
    const urls = [];

    const invidiousHosts = [
        'https://yt.chocolatemoo53.com',
        'https://invidious.nerdvpn.de',
        'https://inv.tux.pizza',
        'https://invidious.privacyredirect.com',
        'https://inv.nadeko.net'
    ];

    for (const host of invidiousHosts) {
        try {
            const apiRes = await fetchWithTimeout(`${host}/api/v1/videos/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 3500);
            if (apiRes.ok) {
                const data = await apiRes.json();
                const formats = (data.adaptiveFormats || []).filter(f => (f.type || '').startsWith('audio/'));
                if (formats.length > 0) {
                    formats.sort((a, b) => (parseInt(a.bitrate) || 999999) - (parseInt(b.bitrate) || 999999));
                    for (const fmt of formats.slice(0, 2)) {
                        const itag = fmt.itag || 139;
                        urls.push(`${host}/latest_version?id=${videoId}&itag=${itag}&local=true`);
                    }
                    console.log(`[Fast Audio] Found stream via ${host} (itag ${formats[0].itag})`);
                    if (urls.length >= 2) break;
                }
            }
        } catch (e) {}
    }

    for (const host of invidiousHosts.slice(0, 4)) {
        urls.push(`${host}/latest_version?id=${videoId}&itag=139&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=249&local=true`);
        urls.push(`${host}/latest_version?id=${videoId}&itag=140&local=true`);
    }

    return [...new Set(urls)];
}

// 5. הורדה מואצת במקטעים (Chunked Range Download)
async function downloadStreamFastToLocalFile(streamUrl, targetFilePath, maxBytes, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let downloaded = 0;

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

        const fileStream = fs.createWriteStream(targetFilePath);
        for await (const chunk of res.body) {
            downloaded += chunk.length;
            fileStream.write(chunk);
            if (downloaded >= maxBytes) {
                try { controller.abort(); } catch (e) {}
                break;
            }
        }

        await new Promise(r => fileStream.end(r));
        clearTimeout(timer);

        if (downloaded < 30000) {
            throw new Error(`Downloaded too small (${downloaded} bytes)`);
        }
        return downloaded;
    } catch (e) {
        clearTimeout(timer);
        if (downloaded >= 250000 && fs.existsSync(targetFilePath)) {
            return downloaded;
        }
        throw e;
    }
}

// 6. הורדה והשמעה רציפה ללא עצירה לאחר 15 דקות + העברה לשלוחה 8 בסדר הפוך (החלק האחרון נכנס ראשון והחלק הראשון נכנס אחרון)!
async function downloadAndUploadChainedParts(videoId, apiExtension, title, phone) {
    const extFolder = String(apiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
    
    // שריון 4 מספרי קבצים עוקבים עבור 4 חלקי השיעור בשלוחת החיפוש (4 x 15 דקות = 60 דקות רצופות)
    const partNums = await getNextFileNumberStr(extFolder, 4);
    const partPaths = partNums.map(num => extFolder ? `ivr2:/${extFolder}/${num}.wav` : `ivr2:/${num}.wav`);
    const partCmds = partNums.map(num => extFolder ? `f-/${extFolder}/${num}` : `f-/${num}`);
    
    // שרשור כל 4 החלקים בפקודת ההשמעה של ימות המשיח
    const chainedPlayCommand = partCmds.join('.');

    const streamUrls = await getFastStreamUrls(videoId);
    let workingUrl = null;
    const tmpQuickInput = path.join(os.tmpdir(), `quick_in_${videoId}_${Date.now()}.audio`);
    const tmpQuickWav = path.join(os.tmpdir(), `quick_out_${videoId}_${Date.now()}.wav`);

    try {
        // שלב א' (מיידי): הורדת 5.5MB ראשונים (חלק 1: דקות 0 עד 15) תוך שניות בודדות
        for (const sUrl of streamUrls.slice(0, 6)) {
            try {
                console.log(`[Part 1 Fast Start] Downloading initial 5.5MB from: ${sUrl.slice(0, 80)}...`);
                const bytes = await downloadStreamFastToLocalFile(sUrl, tmpQuickInput, 5.5 * 1024 * 1024, 9000);
                console.log(`[Part 1 Fast Start] Got ${bytes} bytes. Converting Part 1 (0-15m) to WAV...`);
                await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
                if (fs.existsSync(tmpQuickWav) && fs.statSync(tmpQuickWav).size > 20000) {
                    workingUrl = sUrl;
                    break;
                }
            } catch (err) {
                console.warn(`[Part 1 Fast Start] URL attempt failed: ${err.message}`);
            }
        }

        // גיבוי דרך ytdl-core אם הפרוקסי התעכב
        if (!workingUrl) {
            console.log('[Part 1 Fast Start] Trying ytdl-core fast 5.5MB...');
            await new Promise((resolve, reject) => {
                let dl = 0;
                const ws = fs.createWriteStream(tmpQuickInput);
                const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 8500);
                st.on('data', c => {
                    dl += c.length;
                    ws.write(c);
                    if (dl >= 5 * 1024 * 1024) {
                        clearTimeout(tm);
                        try { st.destroy(); } catch (e) {}
                        ws.end(resolve);
                    }
                });
                st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
            });
            await convertSegmentToWavFast(tmpQuickInput, tmpQuickWav, 0, 900);
        }

        // העלאת חלק 1 (0-15 דקות) לקובץ הראשון בשלוחה 9 (partPaths[0])
        const quickWavBuf = await fs.promises.readFile(tmpQuickWav);
        await uploadWavBufferToExactPath(quickWavBuf, partPaths[0], `${partNums[0]}.wav`, 20000);

        const savedInfo = { playCmd: chainedPlayCommand, title: title || 'השיעור הקודם', time: Date.now() };
        if (phone) lastDownloadByPhone.set(phone, savedInfo);
        globalLastDownload = savedInfo;

        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);

        // שלב ב' (ברקע בזמן שהמאזין מקשיב לחלק 1):
        // מוריד את הקובץ המלא, מייצר את חלקים 2, 3 ו-4 לשלוחה 9,
        // ולאחר מכן מעביר את כל החלקים לשלוחה 8 מהסוף להתחלה (החלק האחרון נכנס ראשון והחלק הראשון נכנס אחרון)!
        (async () => {
            const tmpFullIn = path.join(os.tmpdir(), `full_in_${videoId}_${Date.now()}.audio`);
            // מערך לשמירת כל החלקים של ההורדה הנוכחית לפי הסדר (חלק 1 כבר בפנים)
            const allPartsForExt8 = [
                { partNumber: 1, buffer: quickWavBuf }
            ];

            try {
                console.log(`[Background Parts 2-4] Downloading full audio stream for parts ${partNums.slice(1).join(', ')}...`);
                let fullBytes = 0;

                if (workingUrl) {
                    fullBytes = await downloadStreamFastToLocalFile(workingUrl, tmpFullIn, 26 * 1024 * 1024, 55000);
                } else {
                    await new Promise((resolve, reject) => {
                        const ws = fs.createWriteStream(tmpFullIn);
                        const st = ytdl(`https://www.youtube.com/watch?v=${videoId}`, { filter: 'audioonly', quality: 'lowestaudio' });
                        const tm = setTimeout(() => { try { st.destroy(); } catch (e) {} ws.end(resolve); }, 55000);
                        st.on('data', c => {
                            fullBytes += c.length;
                            ws.write(c);
                            if (fullBytes >= 26 * 1024 * 1024) {
                                clearTimeout(tm);
                                try { st.destroy(); } catch (e) {}
                                ws.end(resolve);
                            }
                        });
                        st.on('end', () => { clearTimeout(tm); ws.end(resolve); });
                        st.on('error', e => { clearTimeout(tm); ws.end(() => reject(e)); });
                    });
                }

                console.log(`[Background Parts 2-4] Full stream downloaded (${fullBytes} bytes). Splitting into sequential 15-min parts...`);

                // חיתוך והעלאה של חלקים 2, 3 ו-4 (דקות 15-30, 30-45, 45-60)
                const segments = [
                    { index: 1, start: 900, duration: 900, label: 'Part 2 (15m-30m)' },
                    { index: 2, start: 1800, duration: 900, label: 'Part 3 (30m-45m)' },
                    { index: 3, start: 2700, duration: 900, label: 'Part 4 (45m-60m)' }
                ];

                for (const seg of segments) {
                    const tmpPartWav = path.join(os.tmpdir(), `part_${seg.index}_${videoId}_${Date.now()}.wav`);
                    try {
                        await convertSegmentToWavFast(tmpFullIn, tmpPartWav, seg.start, seg.duration);
                        if (fs.existsSync(tmpPartWav)) {
                            const stat = fs.statSync(tmpPartWav);
                            // אם החלק מכיל תוכן ממשי (מעל 5 שניות שמע = ~80KB), נעלה אותו לשלוחה 9 ונוסיף לרשימת ההעברה לשלוחה 8
                            if (stat.size > 80000) {
                                const partBuf = await fs.promises.readFile(tmpPartWav);
                                await uploadWavBufferToExactPath(partBuf, partPaths[seg.index], `${partNums[seg.index]}.wav`, 40000);
                                console.log(`[Background ${seg.label}] Uploaded successfully to ${partPaths[seg.index]} (${partBuf.length} bytes)!`);
                                allPartsForExt8.push({ partNumber: seg.index + 1, buffer: partBuf });
                            } else {
                                console.log(`[Background ${seg.label}] Lesson ended before ${seg.start}s, skipping remaining parts.`);
                                fs.promises.unlink(tmpPartWav).catch(() => null);
                                break;
                            }
                        }
                    } catch (segErr) {
                        console.log(`[Background ${seg.label}] Reached end of audio or error:`, segErr.message);
                        fs.promises.unlink(tmpPartWav).catch(() => null);
                        break;
                    }
                    fs.promises.unlink(tmpPartWav).catch(() => null);
                }
            } catch (bgErr) {
                console.warn('[Background Parts 2-4] Warning:', bgErr.message);
            } finally {
                fs.promises.unlink(tmpFullIn).catch(() => null);
            }

            // העברת כל הקבצים שירדו לשלוחה 8 בסדר הפוך:
            // החלק האחרון נכנס ראשון לשלוחה 8 (מקבל את המספר הנמוך יותר) והחלק הראשון נכנס אחרון (מקבל את המספר הגבוה ביותר),
            // כך שכשנכנסים לשלוחה 8 (שמשמיעה קבצים מהחדש לישן), הקובץ יושמע בדיוק לפי הסדר המקורי שלו (חלק 1 -> חלק 2 -> חלק 3 -> חלק 4)!
            if (extFolder !== TEXT_ARCHIVE_EXT && allPartsForExt8.length > 0) {
                try {
                    const rawArchNums = await getNextFileNumberStr(TEXT_ARCHIVE_EXT, allPartsForExt8.length);
                    const archNums = Array.isArray(rawArchNums) ? rawArchNums : [rawArchNums];
                    const reversedParts = [...allPartsForExt8].reverse();

                    console.log(`[Archive Ext 8] Uploading ${reversedParts.length} part(s) in reverse order (last part first, first part last)...`);
                    for (let i = 0; i < reversedParts.length; i++) {
                        const partObj = reversedParts[i];
                        const archNum = archNums[i];
                        const archTargetPath = `ivr2:/${TEXT_ARCHIVE_EXT}/${archNum}.wav`;
                        await uploadWavBufferToExactPath(partObj.buffer, archTargetPath, `${archNum}.wav`, 40000);
                        console.log(`[Archive Ext 8] Uploaded Part ${partObj.partNumber} -> ${archTargetPath}`);
                    }
                } catch (archErr) {
                    console.warn('[Archive Ext 8] Error uploading audio parts to ext 8:', archErr.message);
                }
            }
        })();

        return chainedPlayCommand;

    } catch (e) {
        fs.promises.unlink(tmpQuickInput).catch(() => null);
        fs.promises.unlink(tmpQuickWav).catch(() => null);
        throw e;
    }
}

app.get('/', (req, res) => { res.send('YouTube Line Server v12.2 OK - Seamless Multi-Part Chained Playback & Ext 8 Reverse Upload'); });

app.all(['/yemot', '/yemot/:e'], async (req, res) => {
    const q = { ...req.query, ...req.body };
    res.type('text/plain; charset=utf-8');

    console.log('[Yemot Request]', JSON.stringify(q));

    try {
        if (q.hangup === 'yes') return res.send('noop');

        const extFolder = String(q.ApiExtension || '9').replace(/^ivr2:\/*/, '').replace(/^\/*/, '').replace(/\/*$/, '');
        const callerPhone = String(q.ApiPhone || '').trim();

        // שלב 0: תפריט פתיחה בשלוחה 9
        if (!q.MenuChoice && !q.RecordPath) {
            return res.send('read=t-לחיפוש חדש הקישו 1 להאזנה להורדה הקודמת הקישו 2=MenuChoice,no,1,1,7,Digits,no');
        }

        // הקשה על 2 -> השמעת ההורדה הקודמת (כולל כל החלקים המשורשרים שלה ברצף!)
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
                const recNum = await getNextFileNumberStr(extFolder, 1);
                const recFolder = extFolder ? `/${extFolder}` : '';
                return res.send(`id_list_message=t-עדיין לא קיימת הורדה קודמת בקו&read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
            }
        }

        // שלב 1: הקלטת החיפוש בקולו של המשתמש בשלוחה 9
        if (!q.RecordPath) {
            const recNum = await getNextFileNumberStr(extFolder, 1);
            const recFolder = extFolder ? `/${extFolder}` : '';
            return res.send(`read=t-אנא אמרו את שם השיעור המבוקש ובסיום הקישו סולמית=RecordPath,no,record,${recFolder},${recNum},no,7,1`);
        }

        // שלב 2: הורדת ההקלטה משלוחה 9
        let audioBuf;
        try {
            audioBuf = await downloadRecordingFromYemot(q.RecordPath, q.ApiExtension);
        } catch (dlErr) {
            console.error('[Step 2 Error]', dlErr.message);
            return res.send('id_list_message=t-שגיאה בהורדת ההקלטה מימות המשיח&go_to_folder=/');
        }

        // שלב 3: זיהוי דיבור מהיר ב-Gemini
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

        // שמירת קובץ הטקסט של זיהוי הדיבור (.tts + .txt) בשלוחה 8
        saveTranscriptionTextToExt8(cleanQuery, callerPhone, q.RecordPath);

        // שלב 4: חיפוש התוצאה
        const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(cleanQuery)}&type=video&maxResults=1&key=${YT_KEY}`;
        const ytRes = await fetchWithTimeout(ytUrl, {}, 8000);
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

        // שלב 5: הורדת חלק 1 תוך שניות + שרשור אוטומטי של חלקים 2, 3 ו-4 שיורדים ברקע + העברה לשלוחה 8 בסדר הפוך!
        try {
            const chainedPlayCmd = await downloadAndUploadChainedParts(videoId, q.ApiExtension, title, callerPhone);
            console.log(`[Step 5 Ready] Sending chained play command: ${chainedPlayCmd}`);
            return res.send(`id_list_message=t-משמיע ${title}.${chainedPlayCmd}&go_to_folder=/`);
        } catch (audioErr) {
            console.error('[Step 5 Error]', audioErr.message);
            return res.send(`id_list_message=t-נמצא ${title} אך אירעה שגיאה בטעינת הקובץ&go_to_folder=/`);
        }

    } catch (e) {
        console.error('[General Error v12.2]', e.message);
        if (!res.headersSent) {
            return res.send('id_list_message=t-אירעה תקלה כללית בשרת&go_to_folder=/');
        }
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Server v12.2 Ready on port ${port} ===`));
