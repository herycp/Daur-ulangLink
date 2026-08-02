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

// 🔍 CHECK CONTENT REALTIME
async function checkValidM3u8Content(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return false;

    console.log(`\n⚡ [REALTIME TEST] Menguji fetch ke: ${m3u8Url}`);

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
                    hasExtM3u: text.includes('#EXTM3U'),
                    preview: text.substring(0, 100).replace(/\r?\n|\r/g, ' ')
                };
            } catch (err) {
                return { status: 0, hasExtM3u: false, error: err.message, preview: '' };
            }
        }, m3u8Url, refererUrl);

        console.log(`   📊 Status: ${result.status} | ExtM3u: ${result.hasExtM3u} | Snippet: "${result.preview}"`);

        if (result.status === 200 && result.hasExtM3u) {
            console.log(`   ✅ [VALID] M3U8 Asli & Aktif!`);
            return true;
        } else {
            console.log(`   ❌ [INVALID] Ditolak (HTTP ${result.status} / Tanpa #EXTM3U)`);
            return false;
        }
    } catch (err) {
        console.log(`   ❌ [ERROR]: ${err.message}`);
        return false;
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`⚡ [NO-RELOAD + REALTIME LOG] Input Manual Diterima`);
        console.log(`==================================================`);
        const rawItems = manualInput.split(',').map(s => s.trim()).filter(Boolean);
        targetList = rawItems.map(normalizeInputItem).filter(Boolean);
    } else {
        console.log('\n📄 Membaca database.json...');
        if (!fs.existsSync('database.json')) {
            console.error('❌ File database.json tidak ditemukan!');
            process.exit(1);
        }
        const rawDatabase = fs.readFileSync('database.json', 'utf8');
        const parsedDb = JSON.parse(rawDatabase);
        targetList = parsedDb.map(normalizeInputItem).filter(Boolean);
    }

    if (targetList.length === 0) {
        console.error('❌ Tidak ada link/ID valid.');
        process.exit(1);
    }

    let browser = null;
    const results = [];
    let m3uContent = '#EXTM3U\n\n';

    try {
        console.log('🚀 Membuka Puppeteer...');
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
            console.log(`\n==================================================`);
            console.log(`🔍 [${i + 1}/${targetList.length}] MEMPROSES: ${item.embedUrl}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            let initialNavCompleted = false;
            const interceptedCandidates = [];

            // 🛡️ 1. PENCEGATAN JARINGAN (TOLAK NAVIGASI REFRESH/RELOAD DARI JARINGAN)
            await page.setRequestInterception(true);

            page.on('request', req => {
                const isMainFrameNav = req.isNavigationRequest() && req.frame() === page.mainFrame();

                // Jika halaman awal sudah terbuka dan skrip mencoba merefresh halaman -> BENDUNG/ABORT!
                if (initialNavCompleted && isMainFrameNav) {
                    console.log(`  🛡️ [BYPASS JARINGAN] Memblokir percobaan reload ke: ${req.url()}`);
                    return req.abort();
                }

                req.continue();
            });

            // 🛡️ 2. INJEKSI ANTI-DEVTOOLS & ANTI-RELOAD TOTAL DI TINGKAT DOM / PROTOTYPE
            await page.evaluateOnNewDocument(() => {
                // A. Netralkan 'debugger' timing detection
                const nativeFunction = window.Function;
                window.Function = function (...args) {
                    if (args.length > 0 && typeof args[args.length - 1] === 'string' && args[args.length - 1].includes('debugger')) {
                        return function () {};
                    }
                    return nativeFunction.apply(this, args);
                };
                window.Function.prototype = nativeFunction.prototype;

                // B. Override Location Prototype (Kunci reload, replace, assign di semua frame)
                try {
                    Location.prototype.reload = function() { console.log('🛡️ [BYPASS DOM] Location.prototype.reload diblokir'); };
                    Location.prototype.replace = function() { console.log('🛡️ [BYPASS DOM] Location.prototype.replace diblokir'); };
                    Location.prototype.assign = function() { console.log('🛡️ [BYPASS DOM] Location.prototype.assign diblokir'); };
                } catch(e) {}

                // C. Palsukan devtoolsDetector
                const fakeDetector = {
                    launch: () => {},
                    addListener: (cb) => { if (typeof cb === 'function') cb(false); },
                    removeListener: () => {},
                    stop: () => {},
                    isOpen: false,
                    isUnlocked: true
                };
                window.devtoolsDetector = fakeDetector;
                try {
                    Object.defineProperty(window, 'devtoolsDetector', {
                        get: () => fakeDetector,
                        set: () => {},
                        configurable: false
                    });
                } catch (e) {}
            });

            // LOG CONSOLE BROWSER REALTIME
            page.on('console', msg => {
                console.log(`  🖥️ [BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`);
            });

            // LOG RESPONS REALTIME & DETEKSI M3U8
            page.on('response', async res => {
                const url = res.url();
                const status = res.status();
                const type = res.request().resourceType();

                if (['document', 'script', 'xhr', 'fetch', 'media'].includes(type)) {
                    console.log(`  ⬅️ [RES ${status}] [${type}] ${url}`);
                }

                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`     🎯 [STREAM DETECTED]: ${url}`);
                    interceptedCandidates.push(url);
                }

                if ((type === 'xhr' || type === 'fetch') && !url.endsWith('.js') && !url.endsWith('.css')) {
                    try {
                        const text = await res.text();
                        if (text && text.length > 0) {
                            console.log(`     📦 [XHR PAYLOAD]: ${text.substring(0, 150).replace(/\r?\n|\r/g, ' ')}`);
                        }
                    } catch (e) {}
                }
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;

            try {
                console.log(`⏳ Membuka halaman target...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                initialNavCompleted = true; // Kunci jaringan aktif! Reload otomatis setelah ini akan diblokir.
                
                await delay(2000);

                // Cek kandidat awal
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url, item.embedUrl)) {
                        validM3u8Url = url;
                        break;
                    }
                }

                // Jika belum dapat, pemicu play
                if (!validM3u8Url) {
                    console.log(`\n⚡ Memicu interaksi Play pada player...`);

                    await page.evaluate(() => {
                        try {
                            if (window.jwplayer && typeof window.jwplayer === 'function') {
                                const p = window.jwplayer('player') || window.jwplayer();
                                if (p && typeof p.play === 'function') p.play();
                            }
                        } catch (e) {}

                        try {
                            const vids = document.querySelectorAll('video');
                            vids.forEach(v => v.play().catch(() => {}));
                        } catch (e) {}
                    });

                    try {
                        console.log(`  🖱️ Mengklik titik tengah player (640, 360)...`);
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    console.log(`⏳ Menunggu respons stream baru (10 detik)...`);
                    const startWait = Date.now();
                    while (!validM3u8Url && (Date.now() - startWait) < 10000) {
                        await delay(1000);
                        for (const url of interceptedCandidates) {
                            if (await checkValidM3u8Content(page, url, item.embedUrl)) {
                                validM3u8Url = url;
                                break;
                            }
                        }
                    }
                }

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (validM3u8Url) {
                console.log(`\n🎉 [SUKSES] M3U8 Valid Ditemukan: ${validM3u8Url}`);
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
                console.log(`\n❌ [GAGAL] M3U8 valid tidak ditemukan untuk ${item.id}`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🏁 Selesai! Hasil disimpan di output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
