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

// 🔍 VALIDASI KETAT DENGAN CEK HTTP STATUS 200 & HASIL EXTM3U ASLI
async function checkValidM3u8Content(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return false;

    console.log(`    🔍 [TEST STREAM] Memeriksa: ${m3u8Url}`);

    try {
        const result = await page.evaluate(async (targetUrl, ref) => {
            try {
                const res = await fetch(targetUrl, {
                    method: 'GET',
                    headers: {
                        'Referer': ref,
                        'Accept': '*/*'
                    }
                });
                const text = await res.text();
                return {
                    status: res.status,
                    ok: res.ok,
                    hasExtM3u: text.includes('#EXTM3U')
                };
            } catch (err) {
                return { status: 0, ok: false, error: err.message, hasExtM3u: false };
            }
        }, m3u8Url, refererUrl);

        console.log(`    📊 [HTTP STATUS]: ${result.status} | Has #EXTM3U: ${result.hasExtM3u}`);

        // STRICT VALIDATION: Wajib HTTP 200 OK dan Mengandung #EXTM3U
        if (result.status === 200 && result.hasExtM3u) {
            console.log(`    ✅ [ASLI & VALID] Stream terverifikasi aktif!`);
            return true;
        } else {
            console.log(`    ❌ [PALSU/EXPIRED] Server merespons HTTP ${result.status} (Bukan 200 OK / Tanpa #EXTM3U).`);
            return false; // TIDAK ADA FALLBACK PALSU KELUAR DI SINI
        }
    } catch (err) {
        console.log(`    ❌ [ERROR FETCH]: ${err.message}`);
        return false;
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [STRICT CHECKING] Input Manual Diterima`);
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

            // Bypass Anti-DevTools
            await page.evaluateOnNewDocument(() => {
                const fakeDetector = {
                    launch: () => {},
                    addListener: (cb) => { if (typeof cb === 'function') cb(false); },
                    removeListener: () => {},
                    stop: () => {},
                    isOpen: false
                };
                window.devtoolsDetector = fakeDetector;
                try {
                    window.location.reload = () => {};
                    window.location.replace = () => {};
                } catch (e) {}
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;
            const interceptedCandidates = [];

            page.on('response', (response) => {
                const url = response.url();
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    interceptedCandidates.push(url);
                }
            });

            try {
                console.log(`⏳ Mengunjungi ${item.embedUrl}...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await delay(3000);

                // Cek kandidat awal
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url, item.embedUrl)) {
                        validM3u8Url = url;
                        break;
                    }
                }

                // Jika belum dapat, pemicu play
                if (!validM3u8Url) {
                    console.log(`⚡ Memicu aksi PLAY pada player...`);

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

                    try {
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    console.log(`⏳ Menunggu dan memvalidasi respons stream baru...`);
                    const startWait = Date.now();
                    while (!validM3u8Url && (Date.now() - startWait) < 12000) {
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
                console.error(`💥 Error Navigasi: ${err.message}`);
            }

            if (validM3u8Url) {
                console.log(`✅ [BERHASIL VITAL] Stream Aktif Terkonfirmasi: ${validM3u8Url}`);
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
                console.log(`❌ [GAGAL] Tidak ada URL stream yang lolos validasi HTTP 200 + #EXTM3U.`);
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
