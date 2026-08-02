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

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [ANTI-DEVTOOLS BYPASS] Input Manual Diterima`);
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
        console.log('🚀 Membuka Browser Puppeteer (Stealth Mode)...');
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
            console.log(`🔍 [${i + 1}/${targetList.length}] MEMBUKA TARGET: ${item.embedUrl}`);
            console.log(`--------------------------------------------------`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // ⚡ 1. INJEKSI PENETRALISASI ANTI-DEVTOOLS BERDASARKAN GAMBAR
            await page.evaluateOnNewDocument(() => {
                // A. Lumpuhkan location.reload() agar tidak bisa merefresh halaman secara berulang
                try {
                    const noopReload = () => console.log('🛡️ [BYPASS] location.reload() berhasil dicegat & diblokir!');
                    Object.defineProperty(window.location, 'reload', {
                        value: noopReload,
                        writable: false,
                        configurable: true
                    });
                } catch (e) {
                    window.location.reload = () => console.log('🛡️ [BYPASS] location.reload() berhasil dicegat!');
                }

                // B. Buat mock object devtoolsDetector palsu
                const fakeDetector = {
                    launch: function() {
                        console.log('🛡️ [BYPASS] devtoolsDetector.launch() dipanggil (Dummy)');
                    },
                    addListener: function(callback) {
                        console.log('🛡️ [BYPASS] devtoolsDetector.addListener() dipanggil');
                        // Kirimkan status isOpen = false agar tidak pernah memicu reload
                        if (typeof callback === 'function') {
                            try { callback(false); } catch(err) {}
                        }
                    },
                    removeListener: function() {},
                    stop: function() {},
                    isUnlocked: true,
                    isOpen: false
                };

                // C. Kunci window.devtoolsDetector agar skrip halaman tidak bisa menimpa/memeriksanya
                try {
                    Object.defineProperty(window, 'devtoolsDetector', {
                        get: () => fakeDetector,
                        set: () => {
                            console.log('🛡️ [BYPASS] Mencegah halaman menimpa devtoolsDetector');
                        },
                        configurable: false
                    });
                } catch (e) {
                    window.devtoolsDetector = fakeDetector;
                }
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let extractedUrl = null;

            // 2. CEGAT URL STREAMING (.M3U8)
            page.on('response', (response) => {
                const url = response.url();
                const status = response.status();
                const resourceType = response.request().resourceType();

                if (['xhr', 'fetch', 'script', 'media'].includes(resourceType)) {
                    console.log(`  🌐 [${status}] [${resourceType.toUpperCase()}] ${url.substring(0, 95)}`);
                }

                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    console.log(`\n  🎯 >>> [M3U8 TERDETEKSI SUKSES] <<<`);
                    console.log(`  🔗 ${url}\n`);
                    extractedUrl = url;
                }
            });

            try {
                console.log(`⏳ Memuat halaman embed...`);
                const response = await page.goto(item.embedUrl, { 
                    waitUntil: 'domcontentloaded', 
                    timeout: 30000 
                });

                console.log(`📄 Main HTTP Status: ${response ? response.status() : 'N/A'}`);
                
                // Beri waktu bagi player untuk memanggil M3U8 setelah bypass
                await delay(3000);

                // Cadangan: Ambil dari instance JWPlayer jika belum ter-intercept
                if (!extractedUrl) {
                    extractedUrl = await page.evaluate(() => {
                        if (window.jwplayer && typeof window.jwplayer === 'function') {
                            const p = window.jwplayer('player') || window.jwplayer();
                            if (p && p.getPlaylist) {
                                const pl = p.getPlaylist();
                                return (pl && pl[0]) ? pl[0].file : null;
                            }
                        }
                        return null;
                    });
                }

            } catch (err) {
                console.error(`💥 Error Navigasi: ${err.message}`);
            }

            if (extractedUrl) {
                console.log(`✅ [BERHASIL] ID: ${item.id} -> ${extractedUrl}`);
                results.push({
                    id: item.id,
                    title: item.title,
                    embed_url: item.embedUrl,
                    stream_url: extractedUrl,
                    status: 'active',
                    updated_at: new Date().toISOString()
                });

                m3uContent += `#EXTINF:-1 tvg-id="${item.id}" tvg-name="${item.title}", ${item.title}\n`;
                m3uContent += `#EXTVLCOPT:http-referrer=${item.embedUrl}\n`;
                m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
                m3uContent += `${extractedUrl}\n\n`;
            } else {
                console.log(`❌ [GAGAL] M3U8 tidak ditemukan di halaman ini.`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Selesai! Hasil diperbarui di output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
