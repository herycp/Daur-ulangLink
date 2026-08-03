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

// 🔄 FUNGSI MENGONVERSI URL RELATIF MENJADI ABSOLUT
function convertM3u8ToAbsolute(m3u8Content, sourceM3u8Url) {
    const baseUrl = new URL(sourceM3u8Url);
    
    return m3u8Content.split('\n').map(line => {
        const trimmed = line.trim();
        // Biarkan baris kosong dan tag metadata (#EXT...)
        if (!trimmed || trimmed.startsWith('#')) {
            return line;
        }

        // Jika baris adalah URL segmen/playlist turunan
        try {
            return new URL(trimmed, baseUrl.href).href;
        } catch (e) {
            return line;
        }
    }).join('\n');
}

// 🔍 DOWNLOAD & VALIDASI ISI M3U8
async function fetchAndProcessM3u8(page, m3u8Url, refererUrl) {
    if (!m3u8Url) return null;

    console.log(`\n⚡ [REALTIME FETCH] Mengunduh file M3U8 dari:\n   👉 ${m3u8Url}`);

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
                    rawText: text,
                    isExtM3u: text.includes('#EXTM3U')
                };
            } catch (err) {
                return { status: 0, rawText: '', isExtM3u: false, error: err.message };
            }
        }, m3u8Url, refererUrl);

        if (result.status === 200 && result.isExtM3u) {
            console.log(`   ✅ [DOWNLOAD SUKSES] Berhasil mengambil isi file M3U8.`);
            // Ubah semua URL relatif segmen menjadi URL Absolut
            const absoluteM3u8 = convertM3u8ToAbsolute(result.rawText, m3u8Url);
            return absoluteM3u8;
        } else {
            console.log(`   ❌ [DOWNLOAD GAGAL] HTTP Status: ${result.status}`);
            return null;
        }
    } catch (err) {
        console.log(`   ❌ [FETCH ERROR]: ${err.message}`);
        return null;
    }
}

// 🎬 SIMULASI PLAY VIDEO
async function triggerPlayInAllFrames(page) {
    const frames = page.frames();
    console.log(`\n🎬 [PLAY SIMULATION] Memicu interaksi pemutar video...`);

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
            await frame.evaluate(() => {
                const videos = document.querySelectorAll('video');
                videos.forEach(v => {
                    v.muted = true;
                    v.volume = 0;
                    v.play().catch(() => {});
                });

                if (window.jwplayer && typeof window.jwplayer === 'function') {
                    try {
                        const player = window.jwplayer('player') || window.jwplayer();
                        if (player && typeof player.play === 'function') player.play();
                    } catch (e) {}
                }

                const selectors = ['video', '.jw-display-icon-container', '.vjs-big-play-button', '#player', 'div[class*="play"]'];
                selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        try { el.click(); } catch (e) {}
                    });
                });
            });
        } catch (e) {}
    }

    try {
        await page.mouse.click(640, 360);
    } catch (e) {}
}

(async () => {
    let targetList = [];
    const manualInput = process.argv[2];

    if (manualInput && manualInput.trim() !== '') {
        console.log(`\n==================================================`);
        console.log(`⚡ [DOWNLOAD M3U8 MODE] Input Manual Diterima`);
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
        console.log('🚀 Membuka Browser...');
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

            // INJEKSI SUPER LOCK
            await page.evaluateOnNewDocument(() => {
                const dummyFn = () => {};
                window.addEventListener('beforeunload', (e) => {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    return (e.returnValue = '');
                }, true);

                ['log', 'debug', 'info', 'warn', 'error', 'table', 'clear'].forEach(m => {
                    try { window.console[m] = dummyFn; } catch(e) {}
                });

                try {
                    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
                    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
                } catch(e) {}

                const nativeFunc = Function;
                window.Function = function(...args) {
                    if (args.some(arg => typeof arg === 'string' && arg.includes('debugger'))) return dummyFn;
                    return nativeFunc.apply(this, args);
                };
                window.Function.prototype = nativeFunc.prototype;

                try {
                    const loc = window.location;
                    Object.defineProperties(loc, {
                        reload: { value: dummyFn, writable: false },
                        replace: { value: dummyFn, writable: false },
                        assign: { value: dummyFn, writable: false }
                    });
                } catch(e) {}
            });

            await page.setRequestInterception(true);
            page.on('request', req => {
                const isMainFrameNav = req.isNavigationRequest() && req.frame() === page.mainFrame();
                if (initialNavCompleted && isMainFrameNav) return req.abort();
                req.continue();
            });

            page.on('response', async res => {
                const url = res.url();
                if (url.includes('.m3u8') || url.includes('/playlist/') || url.includes('/hls/')) {
                    console.log(`  🎯 [M3U8 CANDIDATE DETECTED]: ${url}`);
                    if (!capturedM3u8Candidates.includes(url)) {
                        capturedM3u8Candidates.push(url);
                    }
                }
            });

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let finalProcessedM3u8Text = null;
            let originalM3u8Url = null;

            try {
                console.log(`⏳ Membuka halaman embed...`);
                await page.goto(item.embedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                initialNavCompleted = true;

                await delay(2000);
                await triggerPlayInAllFrames(page);
                await delay(4000);

                // Dapatkan kandidat M3U8 dan unduh isinya
                const candidatesToTest = [...capturedM3u8Candidates].reverse();

                for (const candidateUrl of candidatesToTest) {
                    const downloadedText = await fetchAndProcessM3u8(page, candidateUrl, item.embedUrl);
                    if (downloadedText) {
                        finalProcessedM3u8Text = downloadedText;
                        originalM3u8Url = candidateUrl;
                        break;
                    }
                }

            } catch (err) {
                console.error(`💥 Navigation Error: ${err.message}`);
            }

            if (finalProcessedM3u8Text) {
                const standaloneFileName = `${item.id}_stream.m3u8`;
                fs.writeFileSync(standaloneFileName, finalProcessedM3u8Text);
                console.log(`\n💾 [FILE DISIMPAN] Berhasil menyimpan teks M3U8 ke: ${standaloneFileName}`);

                results.push({
                    id: item.id,
                    title: item.title,
                    embed_url: item.embedUrl,
                    m3u8_file: standaloneFileName,
                    original_url: originalM3u8Url,
                    updated_at: new Date().toISOString()
                });

                m3uContent += `#EXTINF:-1 tvg-id="${item.id}" tvg-name="${item.title}", ${item.title}\n`;
                m3uContent += `#EXTVLCOPT:http-referrer=${item.embedUrl}\n`;
                m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
                m3uContent += `${standaloneFileName}\n\n`;
            } else {
                console.log(`\n❌ [GAGAL] Tidak berhasil mengunduh teks M3U8 untuk ${item.id}`);
            }

            await page.close();
            await delay(1000);
        }

        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🏁 Selesai! File .m3u8 terunduh disiapkan untuk diunggah ke GitHub.`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
