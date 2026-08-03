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

// 🔍 EKSTRAKSI HANYA DARI PROPERTY embed_url
function extractPulvexaTargets(dataArray) {
    let results = [];
    if (!Array.isArray(dataArray)) return results;

    for (let i = 0; i < dataArray.length; i++) {
        const item = dataArray[i];
        if (item && typeof item.embed_url === 'string') {
            const embedUrl = item.embed_url.trim();
            if (embedUrl.toLowerCase().includes('pulvexa')) {
                results.push({
                    ...item,
                    embed_url: embedUrl
                });
            }
        }
    }
    return results;
}

// 🆔 GENERATE ID UNIK MURNI BERDASARKAN embed_url
function extractItemId(embedUrl) {
    if (!embedUrl) return `id_${Math.random()}`;
    const cleanUrl = embedUrl.trim().toLowerCase();
    // Mengubah URL menjadi hash unik berbasis Base64
    const urlHash = Buffer.from(cleanUrl).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(-28);
    return `px_${urlHash}`;
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

// ⚡ UJI M3U8 LANGSUNG LEWAT NODE.JS (Cepat & Tanpa Error Context Browser)
async function testAndDownloadM3u8Directly(m3u8Url) {
    if (!m3u8Url) return null;
    try {
        const res = await fetch(m3u8Url, {
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': PARENT_REFERER,
                'Origin': PARENT_ORIGIN,
                'Accept': '*/*'
            }
        });

        if (res.ok) {
            const text = await res.text();
            if (text.includes('#EXTM3U')) {
                return convertM3u8ToAbsolute(text, m3u8Url);
            }
        }
    } catch (err) {}
    return null;
}

// 🎬 PEMICU PLAY PLAYER
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

    console.log(`📊 Status Progres File: ${processedIds.length} item telah selesai diproses sebelumnya.`);

    let rawJsonData = null;
    try {
        rawJsonData = await fetchRemoteDatabase();
    } catch (err) {
        console.error(`❌ Fetch Error: ${err.message}`);
        process.exit(1);
    }

    const allPulvexaItems = extractPulvexaTargets(rawJsonData);
    
    const uniqueTargets = [];
    const seenEmbedUrls = new Set();

    // DEDUPLIKASI MURNI BERDASARKAN embed_url
    for (let i = 0; i < allPulvexaItems.length; i++) {
        const item = allPulvexaItems[i];
        const embedUrl = item.embed_url;
        const itemId = extractItemId(embedUrl);

        if (!seenEmbedUrls.has(embedUrl) && !processedIds.includes(itemId)) {
            seenEmbedUrls.add(embedUrl);
            uniqueTargets.push({
                ...item,
                stream_id: itemId
            });
        }
    }

    console.log(`\n=================== 📊 DIAGNOSTIK DATABASE ===================`);
    console.log(`🔗 Total seluruh item di links.json   : ${Array.isArray(rawJsonData) ? rawJsonData.length : 'Bukan Array'}`);
    console.log(`🎯 Total embed_url berdomain Pulvexa   : ${allPulvexaItems.length}`);
    console.log(`⚡ Pulvexa Baru Siap Diproses (Unik)  : ${uniqueTargets.length}`);
    console.log(`===============================================================\n`);

    if (uniqueTargets.length === 0) {
        console.log(`🎉 Tidak ada target baru yang perlu diproses.`);
        process.exit(0);
    }

    const batchList = uniqueTargets.slice(0, BATCH_LIMIT);
    console.log(`⚡ Memproses batch saat ini (${batchList.length} item, Limit: ${BATCH_LIMIT}).`);

    let browser = null;
    const currentResults = [...existingResults];

    try {
        console.log('\n🚀 Membuka Puppeteer Browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--autoplay-policy=no-user-gesture-required',
                '--window-size=1280,720'
            ]
        });

        for (let i = 0; i < batchList.length; i++) {
            const item = batchList[i];
            const embedUrl = item.embed_url;
            const itemId = item.stream_id;
            const titleSeasonEp = `${item.title || 'Video'}${item.season ? ' S' + item.season : ''}${item.episode ? ' E' + item.episode : ''}`;

            console.log(`\n==================================================`);
            console.log(`🔍 [${i + 1}/${batchList.length}] Processing: ${titleSeasonEp}`);
            console.log(`🔗 EMBED URL: ${embedUrl}`);
            console.log(`🆔 ID UNIK  : ${itemId}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // 🛡️ ANTI-DEVTOOL & ANTI-BOT BYPASS
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'id'] });
                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

                const nativeFunction = Function;
                window.Function = function (...args) {
                    if (args.some(arg => typeof arg === 'string' && arg.includes('debugger'))) {
                        return () => {};
                    }
                    return nativeFunction.apply(this, args);
                };
                window.Function.prototype = nativeFunction.prototype;

                const dummy = () => {};
                ['log', 'debug', 'info', 'warn', 'error', 'table', 'clear'].forEach(m => {
                    try { window.console[m] = dummy; } catch (e) {}
                });

                window.addEventListener('beforeunload', (e) => {
                    e.stopImmediatePropagation();
                }, true);
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': PARENT_REFERER,
                'Origin': PARENT_ORIGIN
            });

            let m3u8SuccessSaved = false;
            const testedCandidates = new Set();
            let pageDoneResolve;
            const pageDonePromise = new Promise(r => pageDoneResolve = r);

            // 📡 PENANGKAP NETWORK & UJI REALTME DENGAN NODE FETCH
            page.on('response', async res => {
                if (m3u8SuccessSaved) return;

                const rawUrl = res.url();
                let candidateUrls = [];

                if ((rawUrl.includes('.m3u8') || rawUrl.includes('/playlist/') || rawUrl.includes('/hls/')) && !rawUrl.includes('jwpltx.com')) {
                    candidateUrls.push(rawUrl);
                }

                if (rawUrl.includes('jwpltx.com') && rawUrl.includes('.m3u8')) {
                    try {
                        const parsed = new URL(rawUrl);
                        const mu = parsed.searchParams.get('mu');
                        if (mu && mu.includes('.m3u8')) candidateUrls.push(decodeURIComponent(mu));
                    } catch (e) {}
                }

                for (const candidateUrl of candidateUrls) {
                    if (m3u8SuccessSaved || testedCandidates.has(candidateUrl)) continue;
                    testedCandidates.add(candidateUrl);

                    console.log(`  🎯 [M3U8 DETECTED]: ${candidateUrl}`);
                    console.log(`  ⚡ Testing M3U8 Candidate via Direct Node Fetch...`);

                    const downloadedText = await testAndDownloadM3u8Directly(candidateUrl);

                    if (downloadedText && !m3u8SuccessSaved) {
                        m3u8SuccessSaved = true;

                        const fileName = `${itemId}_stream.m3u8`;
                        const filePath = path.join(STREAMS_DIR, fileName);
                        const relativePath = `streams/${fileName}`;

                        fs.writeFileSync(filePath, downloadedText);
                        console.log(`   ✅ [VALID M3U8] Berhasil mengunduh isi file.`);
                        console.log(`💾 [M3U8 SUKSES DITEMUKAN] Saved -> ${relativePath}`);

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

                        pageDoneResolve();
                        break;
                    } else {
                        console.log(`   ❌ [INVALID] Bukan format EXTM3U valid.`);
                    }
                }
            });

            try {
                console.log(`⏳ Membuka halaman embed dengan Referer (${PARENT_REFERER})...`);
                
                const processPage = async () => {
                    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    if (m3u8SuccessSaved) return;
                    await delay(1500);
                    if (m3u8SuccessSaved) return;
                    await triggerPlayInAllFrames(page);
                    await delay(2500);
                    if (m3u8SuccessSaved) return;
                    await triggerPlayInAllFrames(page);
                    await delay(2500);
                };

                await Promise.race([
                    processPage(),
                    pageDonePromise,
                    delay(30000)
                ]);

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (!m3u8SuccessSaved) {
                console.log(`❌ [GAGAL] Tidak ada M3U8 valid terunduh dari halaman embed.`);
            }

            await page.close();
            await delay(500);
        }

        // REGENERATE PLAYLIST.M3U
        let m3uContent = '#EXTM3U\n\n';
        for (const resItem of currentResults) {
            const titleDisplay = `${resItem.title || 'Video'}${resItem.season ? ' S' + resItem.season : ''}${resItem.episode ? ' E' + resItem.episode : ''}`;
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
