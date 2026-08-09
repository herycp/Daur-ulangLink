const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STREAMS_DIR = path.join(__dirname, 'streams');
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const OUTPUT_FILE = path.join(__dirname, 'output.json');
const PLAYLIST_FILE = path.join(__dirname, 'playlist.m3u');

const PARENT_REFERER = process.env.PARENT_REFERER || 'https://9tsu.in/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 🆔 HELPER HASH MD5 LAMA (FULL URL)
function extractOldItemId(embedUrl) {
    if (!embedUrl) return null;
    const cleanUrl = embedUrl.trim().toLowerCase();
    return `px_${crypto.createHash('md5').update(cleanUrl).digest('hex')}`;
}

// 🆔 HELPER HASH MD5 BARU (HANYA /embed/*)
function extractNewItemId(embedUrl) {
    if (!embedUrl) return null;
    const cleanUrl = embedUrl.trim().toLowerCase();
    
    // Ambil path mulai dari /embed/ ke belakang
    const embedIdx = cleanUrl.indexOf('/embed/');
    const embedPath = embedIdx !== -1 ? cleanUrl.substring(embedIdx) : cleanUrl;
    
    const md5Hash = crypto.createHash('md5').update(embedPath).digest('hex');
    return `px_${md5Hash}`;
}

(async () => {
    console.log('🔄 Memulai proses migrasi progress...');

    if (!fs.existsSync(OUTPUT_FILE)) {
        console.log('⚠️ File output.json tidak ditemukan. Tidak ada data untuk dimigrasi.');
        process.exit(0);
    }

    const outputData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    const oldProgress = fs.existsSync(PROGRESS_FILE) ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')) : [];

    const newProgress = [];
    const newOutputData = [];
    let migratedCount = 0;
    let renamedFilesCount = 0;

    for (const item of outputData) {
        const embedUrl = item.embed_url;
        if (!embedUrl) continue;

        const oldId = item.stream_id || extractOldItemId(embedUrl);
        const newId = extractNewItemId(embedUrl);

        // Rename file M3U8 di folder streams jika ada
        const oldFileName = `${oldId}_stream.m3u8`;
        const newFileName = `${newId}_stream.m3u8`;
        const oldFilePath = path.join(STREAMS_DIR, oldFileName);
        const newFilePath = path.join(STREAMS_DIR, newFileName);

        if (fs.existsSync(oldFilePath)) {
            fs.renameSync(oldFilePath, newFilePath);
            renamedFilesCount++;
        }

        // Update struktur item
        const updatedItem = {
            ...item,
            stream_id: newId,
            m3u8_file: `streams/${newFileName}`,
            updated_at: new Date().toISOString()
        };

        newOutputData.push(updatedItem);
        if (!newProgress.includes(newId)) {
            newProgress.push(newId);
        }

        migratedCount++;
    }

    // Simpan file hasil migrasi
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(newProgress, null, 2));
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(newOutputData, null, 2));

    // Regenerate playlist.m3u
    let m3uContent = '#EXTM3U\n\n';
    for (const resItem of newOutputData) {
        const titleDisplay = `${resItem.title || 'Video'}${resItem.season ? ' S' + resItem.season : ''}${resItem.episode ? ' E' + resItem.episode : ''}`;
        const logoAttr = resItem.image ? ` tvg-logo="${resItem.image}"` : '';
        
        m3uContent += `#EXTINF:-1 tvg-id="${resItem.stream_id}" tvg-name="${titleDisplay}"${logoAttr}, ${titleDisplay}\n`;
        m3uContent += `#EXTVLCOPT:http-referrer=${PARENT_REFERER}\n`;
        m3uContent += `#EXTVLCOPT:http-user-agent=${USER_AGENT}\n`;
        m3uContent += `${resItem.m3u8_file}\n\n`;
    }
    fs.writeFileSync(PLAYLIST_FILE, m3uContent);

    console.log(`\n=================== 📊 HASIL MIGRASI ===================`);
    console.log(`✅ Total Item Dimigrasi   : ${migratedCount}`);
    console.log(`📁 File M3U8 Di-rename    : ${renamedFilesCount}`);
    console.log(`🔑 ID Progress Baru Saved : ${newProgress.length}`);
    console.log(`=======================================================\n`);
})();
