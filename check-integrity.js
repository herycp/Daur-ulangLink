const fs = require('fs');
const path = require('path');

// ============================================================================
// ⚙️ KONFIGURASI FILE & URL
// ============================================================================
const INPUT_JSON_URL = process.env.INPUT_JSON_URL || 'https://github.com/herycp/Pengepul-link/raw/refs/heads/main/links.json';
const PROGRESS_FILE = path.join(__dirname, 'progress.json');
const README_FILE = path.join(__dirname, 'README.md');

// 🔍 Fungsi Ekstraksi Rekursif
function extractAllLinks(data) {
    let results = [];
    if (!data) return results;

    if (Array.isArray(data)) {
        for (const item of data) {
            results = results.concat(extractAllLinks(item));
        }
    } else if (typeof data === 'object') {
        if (typeof data.embed_url === 'string') {
            results.push({
                ...data,
                embed_url: data.embed_url.trim()
            });
        } else {
            for (const key of Object.keys(data)) {
                if (data[key] && typeof data[key] === 'object') {
                    results = results.concat(extractAllLinks(data[key]));
                }
            }
        }
    }
    return results;
}

async function main() {
    console.log('📡 Mengambil database link dari remote URL...');
    let rawData = null;
    try {
        const headers = process.env.REMOTE_GH_TOKEN ? { 'Authorization': `token ${process.env.REMOTE_GH_TOKEN}` } : {};
        const res = await fetch(INPUT_JSON_URL, { headers });
        if (!res.ok) throw new Error(`HTTP Status ${res.status}`);
        rawData = await res.json();
    } catch (err) {
        console.error(`❌ Gagal mengambil database: ${err.message}`);
        process.exit(1);
    }

    const allItems = extractAllLinks(rawData);
    const totalLinks = allItems.length;

    // 📊 Hitung Kemunculan URL (Cari Duplikat)
    const urlCounts = {};
    allItems.forEach(item => {
        const url = item.embed_url;
        urlCounts[url] = (urlCounts[url] || 0) + 1;
    });

    const duplicatesList = Object.entries(urlCounts)
        .filter(([url, count]) => count > 1)
        .map(([url, count]) => ({ url, count }));

    const totalDuplicates = duplicatesList.reduce((acc, curr) => acc + (curr.count - 1), 0);
    const totalUniqueLinks = Object.keys(urlCounts).length;

    // 📖 Baca Progres dari progress.json
    let processedIds = [];
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            processedIds = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
        } catch (e) {
            processedIds = [];
        }
    }

    const totalProcessed = processedIds.length;
    const totalUnprocessed = Math.max(0, totalUniqueLinks - totalProcessed);
    const progressPercent = totalUniqueLinks > 0 ? ((totalProcessed / totalUniqueLinks) * 100).toFixed(2) : '0.00';

    // 🕒 Waktu Update (WIB / UTC+7)
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    // 📝 Format Output Tabel Markdown untuk README (Tabel Lebar Penuh)
    let dupMarkdownTable = '';
    if (duplicatesList.length > 0) {
        dupMarkdownTable = `| No | URL Duplikat Lengkap | Jumlah |\n|---|---|---|\n`;
        duplicatesList.forEach((dup, idx) => {
            // Menggunakan <pre> atau backticks tanpa wrap agar URL utuh bisa dicopy-paste
            dupMarkdownTable += `| ${idx + 1} | \`${dup.url}\` | ${dup.count}x |\n`;
        });
    } else {
        dupMarkdownTable = `*Tidak ditemukan link duplikat di database.*\n`;
    }

    const reportMarkdown = `<!-- INTEGRITY_REPORT_START -->
## 📊 Laporan Integritas Database

> 🕒 **Terakhir Diperbarui:** \`${now} WIB\`

| Parameter | Jumlah | Persentase |
|---|---|---|
| 🔗 **Total Seluruh Link** | **${totalLinks}** | 100% |
| 🎯 **Total Link Unik** | **${totalUniqueLinks}** | - |
| ⚠️ **Total Link Duplikat** | **${totalDuplicates}** | - |
| ✅ **Jumlah Sudah Diproses** | **${totalProcessed}** | ${progressPercent}% |
| ⏳ **Jumlah Belum Diproses** | **${totalUnprocessed}** | ${(100 - parseFloat(progressPercent)).toFixed(2)}% |

<details>
<summary>🔍 <b>Klik di sini untuk melihat list link duplikat (${duplicatesList.length} URL unik)</b></summary>

<br>

${dupMarkdownTable}

</details>
<!-- INTEGRITY_REPORT_END -->`;

    // 📄 Sisipkan atau Perbarui ke README.md
    let readmeContent = '';
    if (fs.existsSync(README_FILE)) {
        readmeContent = fs.readFileSync(README_FILE, 'utf8');
    } else {
        readmeContent = `# Daur Ular Database\n\n<!-- INTEGRITY_REPORT_START -->\n<!-- INTEGRITY_REPORT_END -->`;
    }

    if (readmeContent.includes('<!-- INTEGRITY_REPORT_START -->')) {
        readmeContent = readmeContent.replace(
            /<!-- INTEGRITY_REPORT_START -->[\s\S]*<!-- INTEGRITY_REPORT_END -->/,
            reportMarkdown
        );
    } else {
        readmeContent += `\n\n${reportMarkdown}`;
    }

    fs.writeFileSync(README_FILE, readmeContent);
    console.log('✅ Laporan integritas (dengan URL duplikat utuh) berhasil di-generate dan ditulis ke README.md!');
}

main();
