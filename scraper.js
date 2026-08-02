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

// 🔍 VALIDASI DEEP-CHECK ISI M3U8 (Harus berisi varian stream atau segmen .ts)
async function validateStreamM3u8(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return false;

    console.log(`\n⚡ [CHECK M3U8] Verifikasi isi stream ke:\n   👉 ${m3u8Url}`);

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
                    preview: text.substring(0, 150).replace(/\r?\n|\r/g, ' ')
                };
            } catch (err) {
                return { status: 0, isValid: false, error: err.message, preview: '' };
            }
        }, m3u8Url, refererUrl);

        console.log(`   📊 Status: ${result.status} | MasterVariant: ${result.hasMasterVariant} | Segments: ${result.hasSegments}`);
        console.log(`   📝 Snippet: "${result.preview}"`);

        if (result.isValid) {
            console.log(`   ✅ [VALID STREAM] M3U8 ini berisi playlist video aktif!`);
            return true;
        } else {
            console.log(`   ❌ [DITOLAK] M3U8 pancingan / tidak berisi segmen video.`);
            return false;
        }
    } catch (err) {
        console.log(`   ❌ [ERROR CHECK]: ${err.message}`);
        return false;
    }
}

// 🎬 SIMULASI PLAY VIDEO DI SELURUH FRAME & IFRAME
async function triggerPlayInAllFrames(page) {
    const frames = page.frames();
    console.log(`\n🎬 [PLAYBACK SIMULATION] Mencoba memutar video di ${frames.length} frame(s)...`);

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
            await frame.evaluate(() => {
                // 1. Mute semua elemen video agar lolos autoplay policy
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    v.muted = true;
                    v.volume = 0;
                    v.play().catch(() => {});
                });

                // 2. Play via JWPlayer API jika ada
                if (window.jwplayer && typeof window.jwplayer === 'function') {
                    try {
                        const player = window.jwplayer('player') || window.jwplayer();
                        if (player && typeof player.play === 'function') player.play();
                    } catch (e) {}
                }

                // 3. Klik elemen-elemen tombol Play umum
                const selectors = [
                    'video',
                    '.jw-display-icon-container',
                    '.jw-icon-play',
                    '.vjs-big-play-button',
                    '.play-button',
                    '#player',
                    '.plyr__control--overlaid',
                    'div[class*="play"]',
                    'div[id*="play"]'
                ];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        try { el.click(); } catch (e) {}
                    });
                });
            });
        } catch (e) {
            // Abaikan error jika cross-origin frame membatasi akses evaluasi langsung
        }
    }

    // Klik fisik mouse di area tengah layar (pemutar video biasanya di tengah)
    try {
        console.log(`  🖱️ Mengirimkan klik mouse fisik ke (640, 360)...`);
        await page.mouse.click(640, 360);
    } catch (e) {}
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`⚡ [VIDEO CAPTURE MODE] Input Manual Diterima`);
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
                '--autoplay-policy=no-user-gesture-required', // Izinkan autoplay video
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
            const capturedM3u8Candidates = [];
            let segmentDetected = false;

            // 🛡️ 1. PENCEGATAN JARINGAN (TOLAK RELOAD OTOMATIS)
            await page.setRequestInterception(true);
            page.on('request', req => {
                const isMainFrameNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
                if (initialNavCompleted && isMainFrameNav) {
                    return req.abort();
                }
                req.continue();
            });

            // 🛡️ 2. ANULIR ANTI-DEVTOOLS & RELOAD PROTOTYPE
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

            // 🎥 LISTEN REQUEST REALTIME (TANGKAP M3U8 & TS SEGMENTS)
            page.on('response', async res => {
                const url = res.url();
                const status = res.status();
                const type = res.request().resourceType();

                // Log aktivitas XHR/Fetch/Media
                if (['xhr', 'fetch', 'media'].includes(type)) {
                    console.log(`  ⬅️ [RES ${status}] [${type}] ${url.substring(0, 110)}`);
                }

                // Tangkap jika ada segmen video berputar (.ts / .m4s)
                if (url.includes('.ts') || url.includes('.m4s') || url.includes('/segment')) {
                    if (!segmentDetected) {
                        console.log(`\n  🔥 [STREAMING ACTIVE] Terdeteksi segmen video diputar secara realtime!`);
                        segmentDetected = true;
                    }
                }

                // Tangkap kandidat M3U8
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`     🎯 [CANDIDATE M3U8 CAPTURED]: ${url}`);
                    if (!capturedM3u8Candidates.includes(url)) {
                        capturedM3u8Candidates.push(url);
                    }
                }
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
                    console.log(`⚡ Mengulangi pemicu play tahap 2...`);
                    await triggerPlayInAllFrames(page);
                    await delay(4000);
                }

                // VERIFIKASI SEMUA KANDIDAT M3U8 YANG DITANGKAP
                console.log(`\n🔍 Memeriksa ${capturedM3u8Candidates.length} kandidat M3U8 yang tertangkap...`);
                
                // Urutkan dari yang terbaru tertangkap (reverse)
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
