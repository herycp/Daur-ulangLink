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

    console.log(`    🔍 [DEBUG VALIDASI] Memeriksa URL: ${m3u8Url}`);

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
                    ok: res.ok,
                    snippet: text.substring(0, 150),
                    hasExtM3u: text.includes('#EXTM3U')
                };
            } catch (fetchErr) {
                return { error: fetchErr.message };
            }
        }, m3u8Url);

        console.log(`    📊 [DEBUG FETCH RESULT]:`, JSON.stringify(fetchResult));

        if (fetchResult.hasExtM3u) {
            console.log(`    ✅ [VALID] Ditemukan tag #EXTM3U di dalam isi file!`);
            return true;
        } else {
            console.log(`    ❌ [DITOLAK] Tidak ditemukan tag #EXTM3U.`);
            // Fallback jika url mengandung format m3u8 murni walau fetch diblokir CORS
            return m3u8Url.includes('.m3u8');
        }
    } catch (err) {
        console.log(`    ⚠️ [DEBUG VALIDASI ERROR]: ${err.message}`);
        return m3u8Url.includes('.m3u8');
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [DEBUG MODE] Input Manual Diterima`);
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
        console.log('🚀 Membuka Browser Puppeteer (Debug Mode)...');
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

            // Tangkap console log dari browser target untuk diagnosa
            page.on('console', msg => {
                const type = msg.type();
                if (['error', 'warning'].includes(type)) {
                    console.log(`  🖥️ [BROWSER ${type.toUpperCase()}] ${msg.text()}`);
                }
            });

            // Tangkap error halaman
            page.on('pageerror', err => {
                console.log(`  ❌ [BROWSER PAGE ERROR] ${err.message}`);
            });

            // Bypass Anti-DevTools
            await page.evaluateOnNewDocument(() => {
                try {
                    Object.defineProperty(window.location, 'reload', { value: () => console.log('🛡️ [BYPASS] location.reload diblokir!'), writable: false });
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
            let allNetworkUrls = [];
            const interceptedCandidates = [];

            // 🌐 PENCATAT JARINGAN SUPER DETAIL
            page.on('response', async (response) => {
                const url = response.url();
                const status = response.status();
                const resourceType = response.request().resourceType();

                allNetworkUrls.push({ url, status, type: resourceType });

                // Catat semua yang berpotensi stream/api/xhr
                if (url.includes('.m3u8') || url.includes('/hls/') || url.includes('manifest') || url.includes('playlist')) {
                    console.log(`  🌐 [POTENSI STREAM] (${status}) [${resourceType}] -> ${url}`);
                    interceptedCandidates.push(url);
                }
            });

            try {
                console.log(`⏳ Mengunjungi halaman ${item.embedUrl}...`);
                const pageRes = await page.goto(item.embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                console.log(`📄 Main HTTP Status: ${pageRes ? pageRes.status() : 'N/A'}`);

                await delay(3000);

                // Cek apakah ada Iframe di halaman ini
                const frames = page.frames();
                console.log(`  🖼️ Jumlah Frames di halaman: ${frames.length}`);
                for (const frame of frames) {
                    if (frame.url() !== page.url()) {
                        console.log(`  🔎 Sub-iframe terdeteksi: ${frame.url()}`);
                    }
                }

                // Cek kandidat awal
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url)) {
                        validM3u8Url = url;
                        console.log(`  🎉 M3U8 Valid Ditemukan pada Pemeriksaan Awal!`);
                        break;
                    }
                }

                // JIKA BELUM DAPAT, LAKUKAN TRIGGER PLAY & CEK ULANG
                if (!validM3u8Url) {
                    console.log(`⚡ M3U8 belum ditemukan. Menjalankan Multi-Trigger Play...`);

                    // 1. Eksekusi Script Play di Browser DOM
                    await page.evaluate(() => {
                        console.log('⚡ [DOM EVAL] Mencoba trigger pemutar video...');
                        try {
                            if (window.jwplayer && typeof window.jwplayer === 'function') {
                                const p = window.jwplayer('player') || window.jwplayer();
                                if (p && typeof p.play === 'function') {
                                    p.play();
                                    console.log('⚡ [DOM EVAL] jwplayer().play() sukses dipanggil');
                                }
                            }
                        } catch (e) { console.log('err jw:', e.message); }

                        try {
                            const videos = document.querySelectorAll('video');
                            videos.forEach(v => {
                                v.play().catch(err => console.log('err HTML5 video play:', err.message));
                            });
                        } catch (e) {}
                    });

                    // 2. Klik Elemen Tombol Play Umum
                    const clickSelectors = [
                        '.jw-display-icon-container',
                        '.jw-icon-display',
                        '.vjs-big-play-button',
                        '#player',
                        'video',
                        '.play-btn',
                        'button'
                    ];

                    for (const sel of clickSelectors) {
                        try {
                            const el = await page.$(sel);
                            if (el) {
                                console.log(`  🖱️ Mengklik elemen: ${sel}`);
                                await el.click();
                                await delay(800);
                            }
                        } catch (e) {}
                    }

                    // 3. Klik Titik Tengah Layar
                    try {
                        console.log(`  🖱️ Mengklik koordinat tengah (640, 360)...`);
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    // Polling menunggu network request m3u8 baru
                    console.log(`⏳ Menunggu respons stream baru selama 15 detik...`);
                    const startWait = Date.now();
                    while (!validM3u8Url && (Date.now() - startWait) < 15000) {
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

            // Jika masih gagal, cetak ringkasan 20 URL terakhir yang diakses jaringan untuk dianalisis
            if (!validM3u8Url) {
                console.log(`\n❌ [GAGAL] M3U8 valid tidak ditemukan.`);
                console.log(`📋 [DIAGNOSTIC] Daftar 25 Request Jaringan Terakhir yang Tercatat:`);
                const sampleUrls = allNetworkUrls.slice(-25);
                sampleUrls.forEach((req, idx) => {
                    console.log(`   [${idx+1}] [${req.status}] [${req.type}] ${req.url}`);
                });
                console.log(`--------------------------------------------------\n`);
            } else {
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
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Proses Selesai! Cek output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
