const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const TARGET_HOST = 'https://pulvexa.space';
const FIXED_TOKEN = '5dfbc9b04e576fc6ad1dbe1daf7a';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normalizeInputItem(item) {
    let rawStr = typeof item === 'string' ? item.trim() : (item.url || item.id || '').trim();
    if (!rawStr) return null;

    if (rawStr.startsWith('http://') || rawStr.startsWith('https://')) {
        try {
            const parsedUrl = new URL(rawStr);
            const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
            const embedIndex = pathSegments.indexOf('embed');
            const extractedId = (embedIndex !== -1 && pathSegments[embedIndex + 1]) 
                ? pathSegments[embedIndex + 1] 
                : (pathSegments[pathSegments.length - 1] || 'stream');

            return {
                id: extractedId,
                embedUrl: rawStr,
                title: typeof item === 'object' && item.title ? item.title : `Video_${extractedId}`
            };
        } catch (e) {
            console.error(`⚠️ URL tidak valid: ${rawStr}`);
            return null;
        }
    } else {
        return {
            id: rawStr,
            embedUrl: `${TARGET_HOST}/embed/${rawStr}?token=${FIXED_TOKEN}`,
            title: typeof item === 'object' && item.title ? item.title : `Video_${rawStr}`
        };
    }
}

// 🔍 FUNGSIONALITAS VALIDASI M3U8 ASLI VS PALSU
async function checkValidM3u8Content(page, m3u8Url) {
    if (!m3u8Url) return false;

    // Filter awal: Abaikan URL yang jelas-jelas link iklan/preview/dummy
    const lower = m3u8Url.toLowerCase();
    if (lower.includes('preview') || lower.includes('dummy') || lower.includes('ad_') || lower.includes('1x1')) {
        console.log(`  ⚠️ URL diabaikan karena terindikasi Iklan/Preview: ${m3u8Url}`);
        return false;
    }

    // Pengecekan Mendalam: Fetch isi file di context browser untuk memastikan header #EXTM3U
    try {
        const isRealStream = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url, { method: 'GET', headers: { 'Range': 'bytes=0-300' } });
                const text = await res.text();
                // Valid M3U8 harus memiliki tag #EXTM3U
                return text.includes('#EXTM3U');
            } catch (e) {
                return false;
            }
        }, m3u8Url);

        return isRealStream;
    } catch (err) {
        // Fallback jika terjadi CORS restriction
        return m3u8Url.includes('.m3u8') || m3u8Url.includes('/hls/');
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [VALIDATED SCRAPER MODE] Input Manual Diterima`);
        console.log(`==================================================`);
        const rawItems = manualInput.split(',').map(s => s.trim()).filter(Boolean);
        targetList = rawItems.map(normalizeInputItem).filter(Boolean);
    } else {
        console.log('\n📄 [BATCH MODE] Membaca dari database.json...');
        if (!fs.existsSync('database.json')) {
            console.error('❌ File database.json tidak ditemukan!');
            process.exit(1);
        }
        const rawDatabase = fs.readFileSync('database.json', 'utf8');
        const parsedDb = JSON.parse(rawDatabase);
        targetList = parsedDb.map(normalizeInputItem).filter(Boolean);
    }

    if (targetList.length === 0) {
        console.error('❌ Tidak ada link/ID valid untuk diproses.');
        process.exit(1);
    }

    let browser = null;
    const results = [];
    let m3uContent = '#EXTM3U\n\n';

    try {
        console.log('🚀 Membuka Browser Puppeteer...');
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,720'
            ]
        });

        for (let i = 0; i < targetList.length; i++) {
            const item = targetList[i];
            console.log(`\n--------------------------------------------------`);
            console.log(`🔍 [${i + 1}/${targetList.length}] TARGET: ${item.embedUrl}`);
            console.log(`--------------------------------------------------`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // Bypass Anti-DevTools & location.reload()
            await page.evaluateOnNewDocument(() => {
                try {
                    Object.defineProperty(window.location, 'reload', { value: () => {}, writable: false });
                } catch (e) {
                    window.location.reload = () => {};
                }
                window.devtoolsDetector = {
                    launch: () => {},
                    addListener: (cb) => { if (typeof cb === 'function') cb(false); },
                    removeListener: () => {},
                    stop: () => {},
                    isOpen: false
                };
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;
            const interceptedCandidates = [];

            // Penangkap Respons Jaringan (Network Response Listener)
            page.on('response', (response) => {
                const url = response.url();
                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    console.log(`  🌐 [MENCERAT REQUEST M3U8] ${url}`);
                    interceptedCandidates.push(url);
                }
            });

            try {
                console.log(`⏳ Memuat halaman...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(2000);

                // 1. CEK KANDIDAT M3U8 AWAL (JIKA AUTOPLAY BERJALAN)
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url)) {
                        validM3u8Url = url;
                        console.log(`  ✅ [VERIFIKASI AWAL BERHASIL] M3U8 Asli Terkonfirmasi!`);
                        break;
                    }
                }

                // 2. JIKA BELUM DAPAT, MICU PLAY DENGAN MULTI-TRIGGER
                if (!validM3u8Url) {
                    console.log(`⚡ M3U8 belum ditemukan/valid. Memicu aksi PLAY pada player...`);

                    // Trigger A: Panggil API Player internal (JWPlayer / VideoJS)
                    await page.evaluate(() => {
                        try {
                            if (window.jwplayer && typeof window.jwplayer === 'function') {
                                const player = window.jwplayer('player') || window.jwplayer();
                                player.play();
                            }
                        } catch (e) {}

                        try {
                            const video = document.querySelector('video');
                            if (video) video.play();
                        } catch (e) {}
                    });

                    // Trigger B: Klik Elemen Selector Player
                    const playSelectors = [
                        '.jw-display-icon-container',
                        '.jw-icon-display',
                        '.vjs-big-play-button',
                        '#player',
                        'video',
                        '.play-button'
                    ];

                    for (const selector of playSelectors) {
                        try {
                            const element = await page.$(selector);
                            if (element) {
                                console.log(`  🖱️ Mengklik elemen selector: ${selector}`);
                                await element.click();
                                await delay(500);
                            }
                        } catch (e) {}
                    }

                    // Trigger C: Klik Koordinat Tengah Layar
                    try {
                        console.log(`  🖱️ Mengklik titik tengah layar (640, 360)...`);
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    // 3. LOOP MENUNGGU HINGGA M3U8 VALID TERCEGAT (Maksimal 12 Detik)
                    console.log(`⏳ Menunggu respons M3U8 asli pasca trigger play...`);
                    const maxWaitTime = 12000;
                    const startTime = Date.now();

                    while (!validM3u8Url && (Date.now() - startTime) < maxWaitTime) {
                        await delay(1000);

                        for (const url of interceptedCandidates) {
                            if (await checkValidM3u8Content(page, url)) {
                                validM3u8Url = url;
                                console.log(`  🎉 [SUKSES TERVERIFIKASI] M3U8 Asli Ditemukan Pasca Play!`);
                                break;
                            }
                        }
                    }
                }

            } catch (err) {
                console.error(`💥 Error Navigasi: ${err.message}`);
            }

            // SIMPAN HASIL
            if (validM3u8Url) {
                console.log(`✅ [BERHASIL] ID: ${item.id} -> ${validM3u8Url}`);
                results.push({
                    id: item.id,
                    title: item.title,
                    embed_url: item.embedUrl,
                    stream_url: validM3u8Url,
                    status: 'active',
                    updated_at: new Date().toISOString()
                });

                m3uContent += `#EXTINF:-1 tvg-id="${item.id}" tvg-name="${item.title}", ${item.title}\n`;
                m3uContent += `#EXTVLCOPT:http-referrer=${item.embedUrl}\n`;
                m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
                m3uContent += `${validM3u8Url}\n\n`;
            } else {
                console.log(`❌ [GAGAL] Tidak dapat menemukan URL M3U8 yang valid untuk ${item.embedUrl}`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Selesai! Hasil akhir ditulis ke output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
