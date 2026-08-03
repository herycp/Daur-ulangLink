const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

// ============================================================================
// ⚙️ KONFIGURASI UTAMA
// ============================================================================
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 🔗 Raw URL ke repository Pengepul-link
const INPUT_JSON_URL = process.env.INPUT_JSON_URL || 'https://raw.githubusercontent.com/herycp/Pengepul-link/main/link.json';

// ⚡ Jumlah maksimal URL yang diproses per 1 siklus/run
const BATCH_LIMIT = parseInt(process.env.BATCH_LIMIT, 10) || 50;

// 📁 KONFIGURASI PATH FILE & FOLDER
const STREAMS_DIR = path.join(__dirname, 'streams');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const OUTPUT_FILE = path.join(__dirname, 'output.json');
const PLAYLIST_FILE = path.join(__dirname, 'playlist.m3u');

if (!fs.existsSync(STREAMS_DIR)) {
    fs.mkdirSync(STREAMS_DIR, { recursive: true });
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 🛠️ HELPER FUNCTIONS
// ============================================================================

// 🆔 Ekstraksi / Generate ID Unik dari Item
function extractItemId(item) {
    if (item.id) return String(item.id);

    if (item.embed_url) {
        const parts = item.embed_url.split('/').filter(Boolean);
        const lastPart = parts[parts.length - 1];
        if (lastPart && /^[a-zA-Z0-9_-]+$/.test(lastPart)) {
            return lastPart;
        }
    }

    const titleClean = (item.title || 'video').replace(/[^a-zA-Z0-9]/g, '_');
    return `${titleClean}_s${item.season || 1}e${item.episode || 1}`;
}

// 🔄 Konversi URL M3U8 Relatif Menjadi Absolut
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

// 🔍 Fetch & Validasi Konten File M3U8
async function fetchAndProcessM3u8(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return null;

    console.log(`  ⚡ Testing M3U8 Candidate:\n     👉 ${m3u8Url}`);

    try {
        const result = await page.evaluate(async (targetUrl, ref) => {
            try {
                const res = await fetch(targetUrl, {
                    method: 'GET',
                    headers: { 'Referer': ref, 'Accept': '*/*' }
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
        }, m3u8Url, refererUrl);

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

// 🎬 Trigger Play Video dalam iFrame/Player
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

                const selectors = ['video', '.jw-display-icon-container', '.vjs-big-play-button', '#player', 'div[class*="play"]'];
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

// 📡 Ambil File link.json dari Remote Repository
async function fetchRemoteDatabase() {
    console.log(`📡 Mengambil link.json dari URL:\n   👉 ${INPUT_JSON_URL}`);
    const headers = process.env.REMOTE_GH_TOKEN ? { 'Authorization': `token ${process.env.REMOTE_GH_TOKEN}` } : {};
    
    let res = await fetch(INPUT_JSON_URL, { headers });
    
    // Fallback jika branch default menggunakan 'master' bukan 'main'
    if (!res.ok && INPUT_JSON_URL.includes('/main/')) {
        const masterUrl = INPUT_JSON_URL.replace('/main/', '/master/');
        console.log(`⚠️ Mencoba fallback ke branch master:\n   👉 ${masterUrl}`);
        res = await fetch(masterUrl, { headers });
    }

    if (!res.ok) throw new Error(`Gagal mengambil link.json (HTTP ${res.status})`);
    const data = await res.json();
    return Array.isArray(data) ? data : [data];
}

// ============================================================================
// 🚀 MAIN EXECUTION
// ============================================================================
(async () => {
    // 1. Baca Progres Terakhir & Data Hasil Sebelumnya
    let processedIds = [];
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            processedIds = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        } catch (e) {
            processedIds = [];
        }
    }

    let existingResults = [];
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            existingResults = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
        } catch (e) {
            existingResults = [];
        }
    }

    console.log(`📊 Status Progres: ${processedIds.length} item telah berhasil diproses sebelumnya.`);

    // 2. Fetch Data Remote & Filter
    let allItems = [];
    try {
        allItems = await fetchRemoteDatabase();
    } catch (err) {
        console.error(`❌ Fetch Error: ${err.message}`);
        process.exit(1);
    }

    // STRICT FILTER: Hanya pulvexa.site DAN Belum Pernah Diproses
    const pendingItems = allItems.filter(item => {
        const embedUrl = item.embed_url || item.url || '';
        const itemId = extractItemId(item);
        return embedUrl.includes('pulvexa.site') && !processedIds.includes(itemId);
    });

    console.log(`🔍 Total target pulvexa.site yang belum diproses: ${pendingItems.length}`);

    if (pendingItems.length === 0) {
        console.log(`🎉 Tidak ada target pulvexa.site baru yang perlu diproses.`);
        process.exit(0);
    }

    // 3. Ambil Item Sesuai Batch Limit
    const batchList = pendingItems.slice(0, BATCH_LIMIT);
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
            const embedUrl = item.embed_url || item.url || '';
            const itemId = extractItemId(item);
            const titleSeasonEp = `${item.title || 'Video'}${item.season ? ' S' + item.season : ''}${item.episode ? 'E' + item.episode : ''}`;

            console.log(`\n==================================================`);
            console.log(`🔍 [${i + 1}/${batchList.length}] Processing: ${titleSeasonEp}`);
            console.log(`🔗 EMBED URL: ${embedUrl}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            let initialNavCompleted = false;
            const capturedM3u8Candidates = [];

            // INJEKSI LOCK PREVENT REDIRECT
            await page.evaluateOnNewDocument(() => {
                const dummyFn = () => {};
                window.addEventListener('beforeunload', (e) => {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    return (e.returnValue = '');
                }, true);

                ['log', 'debug', 'info', 'warn', 'error', 'table', 'clear'].forEach(m => {
                    try { window.console[m] = dummyFn; } catch(e) {}
                });

                const nativeFunc = Function;
                window.Function = function(...args) {
                    if (args.some(arg => typeof arg === 'string' && arg.includes('debugger'))) return dummyFn;
                    return nativeFunc.apply(this, args);
                };
                window.Function.prototype = nativeFunc.prototype;
            });

            await page.setRequestInterception(true);
            page.on('request', req => {
                const isMainFrameNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
                if (initialNavCompleted && isMainFrameNav) return req.abort();
                req.continue();
            });

            // TANGKAP SEMUA M3U8 CANDIDATES
            page.on('response', async res => {
                const url = res.url();
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`  🎯 [M3U8 CANDIDATE DETECTED]: ${url}`);
                    if (!capturedM3u8Candidates.includes(url)) {
                        capturedM3u8Candidates.push(url);
                    }
                }
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': 'https://pulvexa.site/'
            });

            let m3u8SuccessSaved = false;

            try {
                console.log(`⏳ Membuka halaman embed...`);
                await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                initialNavCompleted = true;

                await delay(2000);
                await triggerPlayInAllFrames(page);
                await delay(4000);

                const candidatesToTest = [...capturedM3u8Candidates].reverse();

                for (const candidateUrl of candidatesToTest) {
                    const downloadedText = await fetchAndProcessM3u8(page, candidateUrl, embedUrl);

                    if (downloadedText) {
                        const fileName = `${itemId}_stream.m3u8`;
                        const filePath = path.join(STREAMS_DIR, fileName);
                        const relativePath = `streams/${fileName}`;

                        // 1. Simpan File Teks M3U8
                        fs.writeFileSync(filePath, downloadedText);
                        console.log(`\n💾 [M3U8 SUKSES] Saved -> ${relativePath}`);

                        // 2. Tambahkan ke Metadata Results
                        currentResults.push({
                            ...item,
                            stream_id: itemId,
                            m3u8_file: relativePath,
                            original_m3u8_url: candidateUrl,
                            updated_at: new Date().toISOString()
                        });

                        // 3. Masukkan ke ID yang selesai
                        processedIds.push(itemId);

                        // 4. Simpan Progres & Output Real-time
                        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(processedIds, null, 2));
                        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(currentResults, null, 2));

                        m3u8SuccessSaved = true;
                        break; // Langsung berpindah ke URL berikutnya
                    }
                }

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (!m3u8SuccessSaved) {
                console.log(`❌ [GAGAL] Tidak ada M3U8 valid terunduh dari pulvexa.site.`);
            }

            await page.close();
            await delay(1000);
        }

        // REGENERATE PLAYLIST.M3U SECARA KESELURUHAN
        let m3uContent = '#EXTM3U\n\n';
        for (const resItem of currentResults) {
            const titleDisplay = `${resItem.title || 'Video'}${resItem.season ? ' S' + resItem.season : ''}${resItem.episode ? 'E' + resItem.episode : ''}`;
            const logoAttr = resItem.image ? ` tvg-logo="${resItem.image}"` : '';
            
            m3uContent += `#EXTINF:-1 tvg-id="${resItem.stream_id}" tvg-name="${titleDisplay}"${logoAttr}, ${titleDisplay}\n`;
            m3uContent += `#EXTVLCOPT:http-referrer=${resItem.embed_url || resItem.url}\n`;
            m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
            m3uContent += `${resItem.m3u8_file}\n\n`;
        }
        fs.writeFileSync(PLAYLIST_FILE, m3uContent);

        console.log(`\n==================================================`);
        console.log(`🏁 Batch Selesai! (${batchList.length} item diproses dalam siklus ini)`);
        console.log(`📈 Sisa target pulvexa.site belum diproses: ${pendingItems.length - batchList.length}`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
