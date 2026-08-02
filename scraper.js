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

// 🔍 VALIDASI M3U8 DENGAN LOG DETAIL
async function checkValidM3u8Content(page, m3u8Url) {
    if (!m3u8Url) return false;

    console.log(`    🔍 [VALIDASI] Memeriksa URL: ${m3u8Url}`);
    const lower = m3u8Url.toLowerCase();
    if (lower.includes('preview') || lower.includes('dummy') || lower.includes('ad_') || lower.includes('1x1') || lower.includes('poster')) {
        console.log(`    ❌ [DITOLAK] Mengandung keyword terlarang (ads/preview/dummy).`);
        return false;
    }

    try {
        const fetchResult = await page.evaluate(async (url) => {
            try {
                const res = await fetch(url, { method: 'GET', headers: { 'Range': 'bytes=0-400' } });
                const text = await res.text();
                return {
                    status: res.status,
                    hasExtM3u: text.includes('#EXTM3U')
                };
            } catch (fetchErr) {
                return { error: fetchErr.message };
            }
        }, m3u8Url);

        if (fetchResult.hasExtM3u) {
            console.log(`    ✅ [VALID] Terkonfirmasi header #EXTM3U!`);
            return true;
        } else {
            return m3u8Url.includes('.m3u8');
        }
    } catch (err) {
        return m3u8Url.includes('.m3u8');
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [STRICT ANTI-RELOAD MODE] Input Manual Diterima`);
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
            console.log(`🔍 [${i + 1}/${targetList.length}] MEMPROSES: ${item.embedUrl}`);
            console.log(`--------------------------------------------------`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // 🛡️ LAPIS 1: EKSPLISIT INJEKSI ANTI-DEVTOOL & TOTAL RELOAD BLOCKER (DOM)
            await page.evaluateOnNewDocument(() => {
                const fakeDetector = {
                    launch: () => console.log('🛡️ [BYPASS] devtoolsDetector.launch() dipanggil'),
                    addListener: (cb) => {
                        console.log('🛡️ [BYPASS] devtoolsDetector.addListener() dipanggil');
                        if (typeof cb === 'function') {
                            try { cb(false); } catch (e) {}
                        }
                    },
                    removeListener: () => {},
                    stop: () => {},
                    isUnlocked: true,
                    isOpen: false
                };

                // Pastikan typeof devtoolsDetector TIDAK PERNAH "undefined"
                window.devtoolsDetector = fakeDetector;
                try {
                    Object.defineProperty(window, 'devtoolsDetector', {
                        get: () => fakeDetector,
                        set: () => {},
                        configurable: false
                    });
                } catch (e) {}

                // Block location.reload, location.replace, location.assign
                const logBlock = (method) => console.log(`🛡️ [BYPASS DOM] Percobaan ${method} BERHASIL DIBLOKIR!`);
                
                try {
                    window.location.reload = () => logBlock('location.reload()');
                    window.location.replace = () => logBlock('location.replace()');
                    window.location.assign = () => logBlock('location.assign()');
                } catch (e) {}

                try {
                    window.history.go = () => logBlock('history.go()');
                } catch (e) {}
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;
            const interceptedCandidates = [];
            let initialLoaded = false;

            // 🛡️ LAPIS 2: PENCEGATAN JARINGAN (NETWORK REFRESH BLOCKER)
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const reqUrl = request.url();
                const isNav = request.isNavigationRequest() && request.frame() === page.mainFrame();

                // Jika halaman mencoba navigasi ulang ke URL yang sama setelah load pertama -> ABORT!
                if (initialLoaded && isNav && reqUrl.includes(item.id)) {
                    console.log(`🛡️ [BYPASS NETWORK] Mencegah refresh otomatis ke: ${reqUrl}`);
                    return request.abort();
                }

                request.continue();
            });

            page.on('response', (response) => {
                const url = response.url();
                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    console.log(`  🌐 [POTENSI STREAM M3U8] -> ${url}`);
                    interceptedCandidates.push(url);
                }
            });

            try {
                console.log(`⏳ Mengunjungi halaman ${item.embedUrl}...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                initialLoaded = true; // Tandai bahwa navigasi awal sudah selesai

                await delay(3000);

                // Cek kandidat awal
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url)) {
                        validM3u8Url = url;
                        console.log(`  🎉 M3U8 Valid Ditemukan pada Pemeriksaan Awal!`);
                        break;
                    }
                }

                // JIKA BELUM DAPAT, MICU PLAY VIA DOM & MOUSE CLICK
                if (!validM3u8Url) {
                    console.log(`⚡ M3U8 belum ditemukan. Memicu aksi PLAY pada player...`);

                    await page.evaluate(() => {
                        try {
                            if (window.jwplayer && typeof window.jwplayer === 'function') {
                                const p = window.jwplayer('player') || window.jwplayer();
                                if (p && typeof p.play === 'function') p.play();
                            }
                        } catch (e) {}

                        try {
                            const videos = document.querySelectorAll('video');
                            videos.forEach(v => v.play().catch(() => {}));
                        } catch (e) {}
                    });

                    // Klik area player
                    try {
                        console.log(`  🖱️ Mengklik koordinat tengah player (640, 360)...`);
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    // Tunggu M3U8 baru terdeteksi
                    console.log(`⏳ Menunggu respons stream...`);
                    const startWait = Date.now();
                    while (!validM3u8Url && (Date.now() - startWait) < 12000) {
                        await delay(1000);
                        for (const url of interceptedCandidates) {
                            if (await checkValidM3u8Content(page, url)) {
                                validM3u8Url = url;
                                break;
                            }
                        }
                    }
                }

            } catch (err) {
                console.error(`💥 Error Navigasi Target: ${err.message}`);
            }

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
                console.log(`❌ [GAGAL] M3U8 valid tidak ditemukan.`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Selesai! Cek file output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
