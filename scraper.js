const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ============================================================================
// ⚙️ KONFIGURASI UTAMA
// ============================================================================
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 🌐 REFERER UTAMA (WAJIB 9tsu.in agar server Pulvexa mau melepas M3U8)
const PARENT_REFERER = process.env.PARENT_REFERER || 'https://9tsu.in/';
const PARENT_ORIGIN = 'https://9tsu.in';

const INPUT_JSON_URL = process.env.INPUT_JSON_URL || 'https://github.com/herycp/Pengepul-link/raw/refs/heads/main/links.json';
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT, 10) || 50;

const STREAMS_DIR = path.join(__dirname, 'streams');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const OUTPUT_FILE = path.join(__dirname, 'output.json');
const PLAYLIST_FILE = path.join(__dirname, 'playlist.m3u');

if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });
if (!fs.existsSync(PROGRESS_FILE)) fs.writeFileSync(PROGRESS_FILE, '[]');
if (!fs.existsSync(OUTPUT_FILE)) fs.writeFileSync(OUTPUT_FILE, '[]');
if (!fs.existsSync(PLAYLIST_FILE)) fs.writeFileSync(PLAYLIST_FILE, '#EXTM3U\n\n');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 🛠️ HELPER FUNCTIONS
// ============================================================================

function extractPulvexaTargets(data, parentContext = {}) {
    let results = [];
    if (!data) return results;

    if (typeof data === 'string') {
        const trimmed = data.trim();
        if ((trimmed.startsWith('http://') || trimmed.startsWith('https://')) && trimmed.toLowerCase().includes('pulvexa')) {
            results.push({
                title: parentContext.title || 'Video',
                season: parentContext.season,
                episode: parentContext.episode,
                image: parentContext.image,
                embed_url: trimmed
            });
        }
        return results;
    }

    if (Array.isArray(data)) {
        for (let i = 0; i < data.length; i++) {
            results = results.concat(extractPulvexaTargets(data[i], parentContext));
        }
    } else if (typeof data === 'object') {
        const context = {
            title: data.title || data.name || parentContext.title || 'Video',
            season: data.season || parentContext.season,
            episode: data.episode || parentContext.episode,
            image: data.image || data.poster || data.thumbnail || parentContext.image
        };

        const objectUrls = [];
        for (const [key, val] of Object.entries(data)) {
            if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
                objectUrls.push(val.trim());
            }
        }

        const pulvexaUrl = objectUrls.find(u => u.toLowerCase().includes('pulvexa'));

        if (pulvexaUrl) {
            results.push({
                ...data,
                title: context.title,
                season: context.season,
                episode: context.episode,
                image: context.image,
                embed_url: pulvexaUrl
            });
        }

        for (const [key, val] of Object.entries(data)) {
            if (typeof val === 'object' && val !== null) {
                results = results.concat(extractPulvexaTargets(val, context));
            }
        }
    }

    return results;
}

function extractItemId(item, index = 0) {
    if (item.id) return String(item.id);

    if (item.embed_url) {
        try {
            const urlHash = Buffer.from(item.embed_url).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-12);
            const titleClean = (item.title || 'video').replace(/[^a-zA-Z0-9]/g, '_');
            return `${titleClean}_${urlHash}`;
        } catch (e) {}
    }

    const titleClean = (item.title || 'video').replace(/[^a-zA-Z0-9]/g, '_');
    return `${titleClean}_s${item.season || 1}e${item.episode || 1}_idx${index}`;
}

function convertM3u8ToAbsolute(m3u8Content, sourceM3u8Url) {
    const baseUrl = new URL(sourceM3u8Url);
    return m3u8Content.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        try {
            return new URL(trimmed, baseUrl.href).href;
        } catch (e) {
            return line;
        }
    }).join('\n');
}

async function fetchAndProcessM3u8(page, m3u8Url) {
    if (!m3u8Url) return null;

    console.log(`  ⚡ Testing M3U8 Candidate:\n     👉 ${m3u8Url}`);

    try {
        const result = await page.evaluate(async (targetUrl, ref, orig) => {
            try {
                const res = await fetch(targetUrl, {
                    method: 'GET',
                    headers: { 
                        'Referer': ref, 
                        'Origin': orig,
                        'Accept': '*/*' 
                    }
                });
                const text = await res.text();
                return {
                    status: res.status,
                    rawText: text,
                    isExtM3u: text.includes('#EXTM3U')
                };
            } catch (err) {
                return { status: 0, rawText: '', isExtM3u: false, error: err.message };
            }
        }, m3u8Url, PARENT_REFERER, PARENT_ORIGIN);

        if (result.status === 200 && result.isExtM3u) {
            console.log(`   ✅ [VALID M3U8] Berhasil mengunduh isi file.`);
            return convertM3u8ToAbsolute(result.rawText, m3u8Url);
        } else {
            console.log(`   ❌ [INVALID] Status: ${result.status} / Bukan Format EXTM3U`);
            return null;
        }
    } catch (err) {
        console.log(`   ❌ [FETCH ERROR]: ${err.message}`);
        return null;
    }
}

// 🎬 Pemicu Play Agresif
async function triggerPlayInAllFrames(page) {
    const frames = page.frames();
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
            await frame.evaluate(() => {
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    v.muted = true;
                    v.volume = 0;
                    v.play().catch(() => {});
                });

                if (window.jwplayer && typeof window.jwplayer === 'function') {
                    try {
                        const player = window.jwplayer('player') || window.jwplayer();
                        if (player && typeof player.play === 'function') player.play();
                    } catch (e) {}
                }

                const selectors = [
                    'video', '.jw-display-icon-container', '.vjs-big-play-button', 
                    '#player', 'div[class*="play"]', 'button[class*="play"]',
                    '.play-button', '#play', '#play-btn', '.plyr__control--overlaid'
                ];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        try { el.click(); } catch (e) {}
                    });
                });
            });
        } catch (e) {}
    }

    try {
        await page.mouse.click(640, 360);
    } catch (e) {}
}

async function fetchRemoteDatabase() {
    console.log(`📡 Mengambil links.json dari:\n   👉 ${INPUT_JSON_URL}`);
    const headers = process.env.REMOTE_GH_TOKEN ? { 'Authorization': `token ${process.env.REMOTE_GH_TOKEN}` } : {};

    const res = await fetch(INPUT_JSON_URL, { headers });
    if (!res.ok) {
        throw new Error(`HTTP Error Status: ${res.status} saat mengakses URL.`);
    }

    console.log(`   ✅ BERHASIL terhubung dan mendownload file!`);
    return await res.json();
}

// ============================================================================
// 🚀 MAIN EXECUTION
// ============================================================================
(async () => {
    let processedIds = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    let existingResults = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));

    console.log(`📊 Status Progres: ${processedIds.length} item telah selesai diproses sebelumnya.`);

    let rawJsonData = null;
    try {
        rawJsonData = await fetchRemoteDatabase();
    } catch (err) {
        console.error(`❌ Fetch Error: ${err.message}`);
        process.exit(1);
    }

    const allPulvexaItems = extractPulvexaTargets(rawJsonData);
    
    const uniqueTargets = [];
    const seenIds = new Set();

    for (let i = 0; i < allPulvexaItems.length; i++) {
        const item = allPulvexaItems[i];
        const itemId = extractItemId(item, i);
        if (!seenIds.has(itemId) && !processedIds.includes(itemId)) {
            seenIds.add(itemId);
            uniqueTargets.push(item);
        }
    }

    console.log(`🔍 Total target pulvexa baru ditemukan: ${uniqueTargets.length}`);

    if (uniqueTargets.length === 0) {
        console.log(`🎉 Tidak ada target baru yang perlu diproses.`);
        process.exit(0);
    }

    const batchList = uniqueTargets.slice(0, BATCH_LIMIT);
    console.log(`⚡ Memproses batch saat ini (${batchList.length} item, Limit: ${BATCH_LIMIT}).`);

    let browser = null;
    const currentResults = [...existingResults];

    try {
        console.log('\n🚀 Membuka Puppeteer Browser (Dengan Stealth & Anti-DevTool Bypass)...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process,DisableThirdPartySessionStoragePartitioning',
                '--disable-blink-features=AutomationControlled',
                '--autoplay-policy=no-user-gesture-required',
                '--window-size=1280,720'
            ]
        });

        for (let i = 0; i < batchList.length; i++) {
            const item = batchList[i];
            const embedUrl = item.embed_url;
            const itemId = extractItemId(item, i);
            const titleSeasonEp = `${item.title || 'Video'}${item.season ? ' S' + item.season : ''}${item.episode ? 'E' + item.episode : ''}`;

            console.log(`\n==================================================`);
            console.log(`🔍 [${i + 1}/${batchList.length}] Processing: ${titleSeasonEp}`);
            console.log(`🔗 EMBED URL: ${embedUrl}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // 🛡️ INJEKSI ANTI-DEVTOOL & ANTI-HEADLESS DARI SEBELUMNYA
            await page.evaluateOnNewDocument(() => {
                // 1. Samarkan Navigator
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'id'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

                // 2. Bypass Anti-Debugging & Loop Debugger
                const nativeFunction = Function;
                window.Function = function (...args) {
                    if (args.some(arg => typeof arg === 'string' && arg.includes('debugger'))) {
                        return () => {};
                    }
                    return nativeFunction.apply(this, args);
                };
                window.Function.prototype = nativeFunction.prototype;

                // 3. Netralkan Console Trap
                const dummy = () => {};
                ['log', 'debug', 'info', 'warn', 'error', 'table', 'clear'].forEach(m => {
                    try { window.console[m] = dummy; } catch (e) {}
                });

                // 4. Cegah Sebelum Unload Trap
                window.addEventListener('beforeunload', (e) => {
                    e.stopImmediatePropagation();
                }, true);
            });

            const capturedM3u8Candidates = [];

            // 📡 PENANGKAP M3U8 DARI RESPONSE NETWORK & XHR
            page.on('response', async res => {
                const url = res.url();
                
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`  🎯 [M3U8 DETECTED]: ${url}`);
                    if (!capturedM3u8Candidates.includes(url)) {
                        capturedM3u8Candidates.push(url);
                    }
                } else if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
                    try {
                        const contentType = res.headers()['content-type'] || '';
                        if (contentType.includes('json') || contentType.includes('javascript') || contentType.includes('text')) {
                            const text = await res.text();
                            const matches = text.match(/https?:\/\/[^\s"',]+\.m3u8[^\s"',]*/g);
                            if (matches) {
                                matches.forEach(mUrl => {
                                    console.log(`  🎯 [M3U8 IN PAYLOAD]: ${mUrl}`);
                                    if (!capturedM3u8Candidates.includes(mUrl)) {
                                        capturedM3u8Candidates.push(mUrl);
                                    }
                                });
                            }
                        }
                    } catch (e) {}
                }
            });

            // 🌐 SET REFERER KUNCI PERMANEN KE 9tsu.in
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': PARENT_REFERER,
                'Origin': PARENT_ORIGIN
            });

            let m3u8SuccessSaved = false;

            try {
                console.log(`⏳ Membuka halaman embed dengan Referer (${PARENT_REFERER})...`);
                await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

                await delay(2000);
                await triggerPlayInAllFrames(page);
                await delay(3000);
                await triggerPlayInAllFrames(page);
                await delay(3000);

                const candidatesToTest = [...capturedM3u8Candidates].reverse();

                for (const candidateUrl of candidatesToTest) {
                    const downloadedText = await fetchAndProcessM3u8(page, candidateUrl);

                    if (downloadedText) {
                        const fileName = `${itemId}_stream.m3u8`;
                        const filePath = path.join(STREAMS_DIR, fileName);
                        const relativePath = `streams/${fileName}`;

                        fs.writeFileSync(filePath, downloadedText);
                        console.log(`\n💾 [M3U8 SUKSES] Saved -> ${relativePath}`);

                        currentResults.push({
                            ...item,
                            stream_id: itemId,
                            m3u8_file: relativePath,
                            original_m3u8_url: candidateUrl,
                            updated_at: new Date().toISOString()
                        });

                        processedIds.push(itemId);

                        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(processedIds, null, 2));
                        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(currentResults, null, 2));

                        m3u8SuccessSaved = true;
                        break;
                    }
                }

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (!m3u8SuccessSaved) {
                console.log(`❌ [GAGAL] Tidak ada M3U8 valid terunduh dari halaman embed.`);
            }

            await page.close();
            await delay(1000);
        }

        // REGENERATE PLAYLIST.M3U
        let m3uContent = '#EXTM3U\n\n';
        for (const resItem of currentResults) {
            const titleDisplay = `${resItem.title || 'Video'}${resItem.season ? ' S' + resItem.season : ''}${resItem.episode ? 'E' + resItem.episode : ''}`;
            const logoAttr = resItem.image ? ` tvg-logo="${resItem.image}"` : '';
            
            m3uContent += `#EXTINF:-1 tvg-id="${resItem.stream_id}" tvg-name="${titleDisplay}"${logoAttr}, ${titleDisplay}\n`;
            m3uContent += `#EXTVLCOPT:http-referrer=${PARENT_REFERER}\n`;
            m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
            m3uContent += `${resItem.m3u8_file}\n\n`;
        }
        fs.writeFileSync(PLAYLIST_FILE, m3uContent);

        console.log(`\n==================================================`);
        console.log(`🏁 Batch Selesai! (${batchList.length} item diproses)`);
        console.log(`📈 Sisa target belum diproses: ${uniqueTargets.length - batchList.length}`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
