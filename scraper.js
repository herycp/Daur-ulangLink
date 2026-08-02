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

// 🔍 VALIDASI KETAT STREAM M3U8 DENGAN LOGGING MENDALAM
async function checkValidM3u8Content(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return false;

    console.log(`\n    🔍 [DIAGNOSTIC TEST] Menguji Kandidat: ${m3u8Url}`);

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
                    snippet: text.substring(0, 150).replace(/\n/g, ' '),
                    hasExtM3u: text.includes('#EXTM3U')
                };
            } catch (err) {
                return { status: 0, ok: false, error: err.message, hasExtM3u: false, snippet: '' };
            }
        }, m3u8Url, refererUrl);

        console.log(`    📊 Status: ${result.status} | Has #EXTM3U: ${result.hasExtM3u}`);
        if (result.snippet) {
            console.log(`    📄 Snippet Isi (150 char): "${result.snippet}"`);
        }

        if (result.status === 200 && result.hasExtM3u) {
            console.log(`    ✅ [VALIDATION SUCCESS] M3U8 Valid & Aktif!`);
            return true;
        } else {
            console.log(`    ❌ [VALIDATION FAILED] Ditolak (HTTP Status ${result.status} / Tidak ada #EXTM3U).`);
            return false;
        }
    } catch (err) {
        console.log(`    ❌ [VALIDATION ERROR]: ${err.message}`);
        return false;
    }
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`🧪 [DEEP DEBUG MODE] Input Manual Diterima`);
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
        console.log('🚀 Membuka Browser Puppeteer (Verbose Debug)...');
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
            console.log(`🔍 [${i + 1}/${targetList.length}] MEMPROSES TARGET: ${item.embedUrl}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            // LOG CONSOLE BROWSER
            page.on('console', msg => {
                const text = msg.text();
                if (text.includes('BYPASS') || msg.type() === 'error') {
                    console.log(`  🖥️ [BROWSER CONSOLE ${msg.type().toUpperCase()}] ${text}`);
                }
            });

            // LOG REQUEST GAGAL / CANCELED
            page.on('requestfailed', req => {
                console.log(`  ⚠️ [REQUEST FAILED] (${req.failure() ? req.failure().errorText : 'failed'}) -> ${req.url()}`);
            });

            // BYPASS ANTI-DEVTOOLS & ANTI-RELOAD
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
                    window.location.reload = () => console.log('🛡️ [BYPASS] location.reload() diblokir');
                    window.location.replace = () => console.log('🛡️ [BYPASS] location.replace() diblokir');
                } catch (e) {}
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;
            const interceptedCandidates = [];
            const allLoggedRequests = [];

            // 🌐 PENCATAT RESPONS JARINGAN SUPER DETAIL
            page.on('response', async (response) => {
                const url = response.url();
                const status = response.status();
                const req = response.request();
                const resType = req.resourceType();
                const headers = response.headers();
                const contentType = headers['content-type'] || '';

                allLoggedRequests.push({ url, status, type: resType });

                // Catat jika ada potensi file M3U8 / Playlist / API Stream
                const isStreamCandidate = url.includes('.m3u8') || 
                                          url.includes('/playlist/') || 
                                          url.includes('/hls/') || 
                                          contentType.includes('mpegurl');

                const isApiCandidate = url.includes('ajax') || 
                                       url.includes('source') || 
                                       url.includes('get') || 
                                       contentType.includes('json');

                if (isStreamCandidate) {
                    console.log(`  🌐 [KANDIDAT STREAM] (${status}) [${resType}] -> ${url}`);
                    interceptedCandidates.push(url);
                } else if (isApiCandidate && resType !== 'image' && resType !== 'stylesheet') {
                    console.log(`  📡 [API/XHR CALL] (${status}) [${resType}] -> ${url}`);
                    try {
                        const bodyText = await response.text();
                        console.log(`     📦 [API BODY PREVIEW]: ${bodyText.substring(0, 200)}`);
                    } catch (e) {}
                }
            });

            try {
                console.log(`⏳ Navigasi ke ${item.embedUrl}...`);
                const navRes = await page.goto(item.embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                console.log(`📄 Main Document HTTP Status: ${navRes ? navRes.status() : 'N/A'}`);

                await delay(2000);

                // Cek Frame / Iframe
                const frames = page.frames();
                console.log(`🖼️ Detected Frames Total: ${frames.length}`);
                frames.forEach((f, idx) => {
                    if (idx > 0) console.log(`   └─ Frame [${idx}]: ${f.url()}`);
                });

                // Cek Status Video Player DOM awal
                const videoDomInfo = await page.evaluate(() => {
                    const vids = Array.from(document.querySelectorAll('video'));
                    return vids.map(v => ({
                        src: v.src,
                        currentSrc: v.currentSrc,
                        paused: v.paused,
                        readyState: v.readyState
                    }));
                });
                console.log(`📹 [DOM Video Elements Status]:`, JSON.stringify(videoDomInfo));

                // 1. Cek Kandidat Awal
                for (const url of interceptedCandidates) {
                    if (await checkValidM3u8Content(page, url, item.embedUrl)) {
                        validM3u8Url = url;
                        break;
                    }
                }

                // 2. Jika belum dapat, jalankan pemicu Play
                if (!validM3u8Url) {
                    console.log(`\n⚡ Stream M3U8 belum ditemukan. Memicu interaksi Play pada player...`);

                    await page.evaluate(() => {
                        console.log('⚡ [EVAL] Mencoba trigger play via JavaScript API...');
                        try {
                            if (window.jwplayer && typeof window.jwplayer === 'function') {
                                const p = window.jwplayer('player') || window.jwplayer();
                                if (p && typeof p.play === 'function') {
                                    p.play();
                                    console.log('⚡ [EVAL] jwplayer().play() dipanggil.');
                                }
                            }
                        } catch (e) {}

                        try {
                            const vids = document.querySelectorAll('video');
                            vids.forEach(v => v.play().catch(err => console.log('err video play:', err.message)));
                        } catch (e) {}
                    });

                    // Klik fisik pusat layar
                    try {
                        console.log(`  🖱️ Mengklik koordinat tengah player (640, 360)...`);
                        await page.mouse.click(640, 360);
                    } catch (e) {}

                    await delay(1000);

                    // Klik selector tombol play jika ada
                    const playSelectors = ['.jw-display-icon-container', '.vjs-big-play-button', '#player', 'video'];
                    for (const sel of playSelectors) {
                        try {
                            const el = await page.$(sel);
                            if (el) {
                                console.log(`  🖱️ Mengklik selector: ${sel}`);
                                await el.click();
                                await delay(500);
                            }
                        } catch (e) {}
                    }

                    console.log(`⏳ Menunggu respons stream baru (12 detik)...`);
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
                console.error(`💥 Error Navigasi Target: ${err.message}`);
            }

            // HASIL AKHIR & REKAP
            if (validM3u8Url) {
                console.log(`\n✅ [HASIL SUKSES] ID: ${item.id} -> ${validM3u8Url}`);
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
                console.log(`\n❌ [HASIL GAGAL] Tidak ditemukan URL M3U8 valid.`);
                console.log(`📋 [REKAP REKAPITULASI JARINGAN 15 REQUEST TERAKHIR]:`);
                const sampleReqs = allLoggedRequests.slice(-15);
                sampleReqs.forEach((r, idx) => {
                    console.log(`   [${idx + 1}] [${r.status}] [${r.type}] ${r.url}`);
                });
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Proses Selesai! Cek file output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
