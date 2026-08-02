const puppeteer = require('puppeteer');
const fs = require('fs');

const TARGET_HOST = 'https://pulvexa.space';
const FIXED_TOKEN = '5dfbc9b04e576fc6ad1dbe1daf7a';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Normalisasi input (Mendukung Full Embed URL maupun Kode ID Saja)
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

    // 1. OPSI INPUT MANUAL (CLI / GitHub Actions Input)
    if (manualInput && manualInput.trim() !== '') {
        console.log(`🧪 [TESTING MODE] Input Manual Diterima:`);
        const rawItems = manualInput.split(',').map(s => s.trim()).filter(Boolean);
        targetList = rawItems.map(normalizeInputItem).filter(Boolean);
    } else {
        // 2. OPSI BATCH MODE DARI database.json
        console.log('📄 [BATCH MODE] Membaca dari database.json...');
        if (!fs.existsSync('database.json')) {
            console.error('❌ File database.json tidak ditemukan!');
            process.exit(1);
        }
        const rawDatabase = fs.readFileSync('database.json', 'utf8');
        const parsedDb = JSON.parse(rawDatabase);
        targetList = parsedDb.map(normalizeInputItem).filter(Boolean);
    }

    if (targetList.length === 0) {
        console.error('❌ Tidak ada link/ID valid yang bisa diproses.');
        process.exit(1);
    }

    console.log(`📋 Total ${targetList.length} item siap diproses.\n`);

    let browser = null;
    const results = [];
    let m3uContent = '#EXTM3U\n\n';

    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        for (let i = 0; i < targetList.length; i++) {
            const item = targetList[i];
            console.log(`🔍 [${i + 1}/${targetList.length}] Scraping Link: ${item.embedUrl}`);

            const page = await browser.newPage();
            await page.setUserAgent(USER_AGENT);

            let extractedUrl = null;

            // Intercept Network Request
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const url = req.url();
                if (url.includes('.m3u8') || url.includes('/hls/')) {
                    extractedUrl = url;
                }
                req.continue();
            });

            try {
                await page.goto(item.embedUrl, { waitUntil: 'networkidle2', timeout: 25000 });

                // Backup ekstraksi langsung dari instance JWPlayer
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
                console.error(`⚠️ Error saat membuka link (${item.id}):`, err.message);
            }

            if (extractedUrl) {
                console.log(`✅ [SUCCESS] M3U8 URL: ${extractedUrl}\n`);
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
                console.log(`❌ [FAILED] Gagal mencegat M3U8 untuk link ini.\n`);
            }

            await page.close();
            await delay(1500);
        }

        // Simpan Hasil ke Output File JSON & M3U
        fs.writeFileSync('output.json', JSON.stringify(results, null, 2));
        fs.writeFileSync('playlist.m3u', m3uContent);

        console.log('🎉 Selesai! Hasil disimpan ke output.json & playlist.m3u.');

    } catch (error) {
        console.error('❌ Scraper Error:', error.message);
        process.exit(1);
    } finally {
        if (browser) await browser.close();
    }
})();
