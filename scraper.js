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

// 🔍 VALIDASI KETAT M3U8 REALTIME (Pastikan Berisi Varian/Segmen Aktif)
async function validateStreamM3u8(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return false;

    console.log(`\n⚡ [REALTIME TEST] Menguji isi M3U8 ke:\n   👉 ${m3u8Url}`);

    try {
        const result = await page.evaluate(async (targetUrl, ref) => {
            try {
                const res = await fetch(targetUrl, {
                    method: 'GET',
                    headers: { 'Referer': ref, 'Accept': '*/*' }
                });
                const text = await res.text();
                
                const isExtM3u = text.includes('#EXTM3U');
                const hasMasterVariant = text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA');
                const hasSegments = text.includes('#EXTINF') || text.includes('.ts') || text.includes('.m4s');

                return {
                    status: res.status,
                    isValid: isExtM3u && (hasMasterVariant || hasSegments),
                    hasMasterVariant,
                    hasSegments,
                    preview: text.substring(0, 120).replace(/\r?\n|\r/g, ' ')
                };
            } catch (err) {
                return { status: 0, isValid: false, error: err.message, preview: '' };
            }
        }, m3u8Url, refererUrl);

        console.log(`   📊 Status: ${result.status} | MasterVariant: ${result.hasMasterVariant} | Segments: ${result.hasSegments}`);
        console.log(`   📝 Snippet: "${result.preview}"`);

        if (result.isValid) {
            console.log(`   ✅ [VALID] M3U8 ini berisi playlist video aktif!`);
            return true;
        } else {
            console.log(`   ❌ [INVALID] M3U8 pancingan / tidak berisi segmen video.`);
            return false;
        }
    } catch (err) {
        console.log(`   ❌ [ERROR TEST]: ${err.message}`);
        return false;
    }
}

// 🎬 TRIGGER PLAY DI SELURUH FRAME & IFRAME
async function triggerPlayInAllFrames(page) {
    const frames = page.frames();
    console.log(`\n🎬 [REALTIME PLAYBACK SIMULATION] Memicu Play di ${frames.length} frame(s)...`);

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
            await frame.evaluate(() => {
                // Mute & Play HTML5 Videos
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    v.muted = true;
                    v.volume = 0;
                    v.play().catch(() => {});
                });

                // Play JWPlayer API
                if (window.jwplayer && typeof window.jwplayer === 'function') {
                    try {
                        const player = window.jwplayer('player') || window.jwplayer();
                        if (player && typeof player.play === 'function') player.play();
                    } catch (e) {}
                }

                // Klik Tombol Play
                const selectors = [
                    'video',
                    '.jw-display-icon-container',
                    '.jw-icon-play',
                    '.vjs-big-play-button',
                    '.play-button',
                    '#player',
                    'div[class*="play"]'
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
        console.log(`  🖱️ Klik mouse fisik ke koordinat tengah (640, 360)...`);
        await page.mouse.click(640, 360);
    } catch (e) {}
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`⚡ [FULL REALTIME STREAM CAPTURE] Input Manual Diterima`);
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
        console.log('🚀 Membuka Puppeteer Browser...');
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

        for (let i = 0; i < targetList.length; i++) {
            const item = targetList[i];
            console.log(`\n==================================================`);
            console.log(`🔍 [${i + 1}/${targetList.length}] MEMPROSES TARGET: ${item.embedUrl}`);
            console.log(`==================================================`);

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 720 });
            await page.setUserAgent(USER_AGENT);

            let initialNavCompleted = false;
            const capturedM3u8Candidates = [];
            let segmentDetected = false;

            // 1. REALTIME LOG: OUTGOING REQUEST
            await page.setRequestInterception(true);
            page.on('request', req => {
                const type = req.resourceType();
                const isMainFrameNav = req.isNavigationRequest() && req.frame() === page.mainFrame();

                if (initialNavCompleted && isMainFrameNav) {
                    console.log(`  🛡️ [BYPASS JARINGAN] Memblokir reload otomatis ke: ${req.url()}`);
                    return req.abort();
                }

                if (['document', 'script', 'xhr', 'fetch', 'media'].includes(type)) {
                    console.log(`  ➡️ [REQ] [${req.method()}] [${type}] ${req.url().substring(0, 110)}`);
                }

                req.continue();
            });

            // 2. REALTIME LOG: INCOMING RESPONSE & CANDIDATE CAPTURE
            page.on('response', async res => {
                const url = res.url();
                const status = res.status();
                const type = res.request().resourceType();

                if (['document', 'script', 'xhr', 'fetch', 'media'].includes(type)) {
                    console.log(`  ⬅️ [RES ${status}] [${type}] ${url.substring(0, 110)}`);
                }

                // DETEKSI SEGMEN VIDEO DIPUTAR REALTIME
                if (url.includes('.ts') || url.includes('.m4s') || url.includes('/segment')) {
                    if (!segmentDetected) {
                        console.log(`\n  🔥 [STREAMING ACTIVE] Terdeteksi segmen .ts diputar secara realtime!`);
                        segmentDetected = true;
                    }
                }

                // DETEKSI KANDIDAT M3U8
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`     🎯 [CANDIDATE M3U8 DETECTED]: ${url}`);
                    if (!capturedM3u8Candidates.includes(url)) {
                        capturedM3u8Candidates.push(url);
                    }
                }

                // CETAK ISI PAYLOAD XHR/FETCH REALTIME
                if ((type === 'xhr' || type === 'fetch') && !url.endsWith('.js') && !url.endsWith('.css')) {
                    try {
                        const text = await res.text();
                        if (text && text.length > 0) {
                            console.log(`     📦 [XHR PAYLOAD]: ${text.substring(0, 130).replace(/\r?\n|\r/g, ' ')}`);
                        }
                    } catch (e) {}
                }
            });

            // 3. REALTIME LOG: BROWSER CONSOLE
            page.on('console', msg => {
                console.log(`  🖥️ [BROWSER ${msg.type().toUpperCase()}] ${msg.text()}`);
            });

            // 4. REALTIME LOG: FAILED REQUESTS
            page.on('requestfailed', req => {
                const type = req.resourceType();
                if (['document', 'script', 'xhr', 'fetch', 'media'].includes(type)) {
                    console.log(`  💥 [FAIL] [${req.failure() ? req.failure().errorText : 'UNKNOWN'}] ${req.url().substring(0, 110)}`);
                }
            });

            // ANTI-DEVTOOLS & ANTI-RELOAD INJECTION
            await page.evaluateOnNewDocument(() => {
                const nativeFunction = window.Function;
                window.Function = function (...args) {
                    if (args.length > 0 && typeof args[args.length - 1] === 'string' && args[args.length - 1].includes('debugger')) {
                        return function () {};
                    }
                    return nativeFunction.apply(this, args);
                };
                window.Function.prototype = nativeFunction.prototype;

                try {
                    Location.prototype.reload = function() {};
                    Location.prototype.replace = function() {};
                    Location.prototype.assign = function() {};
                } catch(e) {}
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let validM3u8Url = null;

            try {
                console.log(`⏳ Membuka halaman embed...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                initialNavCompleted = true;

                await delay(2000);

                // SIMULASI PLAY TAHAP 1
                await triggerPlayInAllFrames(page);
                await delay(3000);

                // SIMULASI PLAY TAHAP 2 (Jika belum berputar)
                if (!segmentDetected) {
                    console.log(`⚡ Mengulangi trigger play tahap 2...`);
                    await triggerPlayInAllFrames(page);
                    await delay(4000);
                }

                // VERIFIKASI SEMUA KANDIDAT M3U8 TERLATEST DULU
                console.log(`\n🔍 Melakukan verifikasi realtime pada ${capturedM3u8Candidates.length} kandidat M3U8...`);
                const candidatesToTest = [...capturedM3u8Candidates].reverse();

                for (const candidateUrl of candidatesToTest) {
                    if (await validateStreamM3u8(page, candidateUrl, item.embedUrl)) {
                        validM3u8Url = candidateUrl;
                        break;
                    }
                }

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (validM3u8Url) {
                console.log(`\n🎉 [SUKSES HASIL AKHIR] M3U8 Video Asli: ${validM3u8Url}`);
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
                console.log(`\n❌ [GAGAL] Tidak ada M3U8 asli yang valid untuk ${item.id}`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🏁 Selesai! Output tersimpan di output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
