const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Aktifkan Stealth Plugin untuk menyamarkan Puppeteer sebagai Browser Manusia biasa
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
        console.log(`🧪 [STEALTH DEBUG MODE] Input Manual Diterima`);
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
        console.log('🚀 Membuka Browser dengan Mode Stealth...');
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

            // 1. INJEKSI ANTI-ANTI-DEVTOOLS (Lakukan sebelum dokumen dimuat)
            await page.evaluateOnNewDocument(() => {
                // Sembunyikan flag webdriver
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

                // Netralkan jebakan `debugger` loop
                const noop = () => {};
                window.console.clear = noop;

                // Hijack Function constructor untuk melumpuhkan evaluasi `debugger;`
                const NativeFunction = window.Function;
                window.Function = function (...args) {
                    if (args.length > 0 && typeof args[args.length - 1] === 'string') {
                        if (args[args.length - 1].includes('debugger')) {
                            return noop;
                        }
                    }
                    return NativeFunction(...args);
                };
                window.Function.prototype = NativeFunction.prototype;
            });

            // Set referer resmi
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let extractedUrl = null;

            // 2. PASSIVE RESPONSE LISTENING (Tanpa setRequestInterception agar tidak terdeteksi)
            page.on('response', (response) => {
                const url = response.url();
                const status = response.status();
                const resourceType = response.request().resourceType();

                if (['xhr', 'fetch', 'script', 'media'].includes(resourceType)) {
                    console.log(`  🌐 [${status}] [${resourceType.toUpperCase()}] ${url.substring(0, 95)}`);
                }

                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    console.log(`\n  🎯 >>> [M3U8 TERDETEKSI] <<<`);
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
                
                // Beri jeda sejenak untuk membiarkan skrip player memanggil M3U8
                await delay(3000);

                // Simulasi klik acak di tengah area player jika video butuh pemicu autoplay
                if (!extractedUrl) {
                    console.log(`🖱️ Mencoba trigger interaksi klik pada player...`);
                    try {
                        await page.mouse.click(640, 360);
                        await delay(2000);
                    } catch (e) {
                        // Abaikan jika gagal klik
                    }
                }

                // Cek variabel JWPlayer di DOM Utama jika belum ter-intercept
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

            // Output Hasil
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
