const puppeteer = require('puppeteer');
const fs = require('fs');

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
        console.log(`🧪 [MODE DEBUG] Input Manual Diterima`);
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
                '--disable-blink-features=AutomationControlled', // Sembunyikan tanda automation bot
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

            // 1. Set Header Referer Utama
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
                'Referer': TARGET_HOST + '/'
            });

            let extractedUrl = null;

            // 2. LOG CONSOLE Halaman Web Target (Untuk cek error JS internal)
            page.on('console', msg => {
                const type = msg.type();
                if (['error', 'warning'].includes(type)) {
                    console.log(`  [PAGE CONSOLE ${type.toUpperCase()}]: ${msg.text()}`);
                }
            });

            page.on('pageerror', err => {
                console.log(`  [PAGE JS ERROR]: ${err.message}`);
            });

            // 3. LOG RESPONS NETWORK (Untuk mendeteksi HTTP Status & URL)
            page.on('response', async (response) => {
                const url = response.url();
                const status = response.status();
                const resourceType = response.request().resourceType();

                // Log request bertipe fetch, xhr, script, atau media
                if (['xhr', 'fetch', 'script', 'media'].includes(resourceType)) {
                    console.log(`  🌐 [${status}] [${resourceType.toUpperCase()}] ${url.substring(0, 90)}...`);
                }

                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    console.log(`\n  🎯 >>> [INTERCEPTED SUCCESS] M3U8 DITEMUKAN! <<<`);
                    console.log(`  🔗 ${url}\n`);
                    extractedUrl = url;
                }
            });

            // Intercept Network untuk memodifikasi Referer jika dibutuhkan
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                req.continue();
            });

            try {
                // Navigasi ke halaman embed
                console.log(`⏳ Memuat halaman embed...`);
                const mainResponse = await page.goto(item.embedUrl, { 
                    waitUntil: 'networkidle2', 
                    timeout: 30000 
                });

                const mainStatus = mainResponse ? mainResponse.status() : 'N/A';
                console.log(`📄 Main Page HTTP Status: ${mainStatus}`);

                // Cek apakah judul halaman menunjukkan proteksi Cloudflare / Bot Block
                const pageTitle = await page.title();
                console.log(`📌 Judul Halaman: "${pageTitle}"`);

                if (pageTitle.includes('Just a moment') || pageTitle.includes('Attention Required') || mainStatus === 403) {
                    console.log(`❌ [BLOCKED] Halaman terdeteksi diblokir oleh Cloudflare/Bot Protection!`);
                }

                // 4. Jika M3U8 Belum Ter-intercept, Cek Instance JWPlayer di Halaman Utama
                if (!extractedUrl) {
                    console.log(`⚙️ Menguji pencarian variabel player di DOM Utama...`);
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
                    if (extractedUrl) console.log(`✅ Ditemukan dari window.jwplayer!`);
                }

                // 5. Jika Masih Belum Ditemukan, Cek Apakah Player Berada di Dalam iFrame
                if (!extractedUrl) {
                    console.log(`🖼️ Memeriksa seluruh iFrame yang ada di halaman...`);
                    const frames = page.frames();
                    console.log(`  Ditemukan ${frames.length} frame di halaman.`);

                    for (let f = 0; f < frames.length; f++) {
                        const frame = frames[f];
                        console.log(`  🔎 Memeriksa Frame #${f}: ${frame.url()}`);
                        try {
                            const framePlaylist = await frame.evaluate(() => {
                                if (window.jwplayer && typeof window.jwplayer === 'function') {
                                    const p = window.jwplayer('player') || window.jwplayer();
                                    if (p && p.getPlaylist) {
                                        const pl = p.getPlaylist();
                                        return (pl && pl[0]) ? pl[0].file : null;
                                    }
                                }
                                return null;
                            });
                            if (framePlaylist) {
                                extractedUrl = framePlaylist;
                                console.log(`✅ Ditemukan M3U8 dari Frame #${f}!`);
                                break;
                            }
                        } catch (e) {
                            // Abaikan error cross-origin iframe
                        }
                    }
                }

            } catch (err) {
                console.error(`💥 Error Navigasi: ${err.message}`);
            }

            // Output Hasil Per Item
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
                console.log(`❌ [GAGAL] Tidak dapat mengekstrak M3U8 dari ${item.embedUrl}`);
            }

            await page.close();
            await delay(1000);
        }

        // Simpan Hasil Akhir
        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);
        console.log(`\n==================================================`);
        console.log(`🎉 Proses Selesai. Hasil ditulis ke output.json & playlist.m3u`);
        console.log(`==================================================\n`);

    } catch (error) {
        console.error('❌ Fatal Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
