const puppeteer = require('puppeteer');
const fs = require('fs');

// Baca URL dari file atau environment variable
let urls = [];
if (fs.existsSync('urls.txt')) {
  urls = fs.readFileSync('urls.txt', 'utf8')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}
if (process.env.INPUT_URLS) {
  urls = process.env.INPUT_URLS.split(',').map(s => s.trim()).filter(Boolean);
}

if (urls.length === 0) {
  console.error('Tidak ada URL yang diberikan.');
  process.exit(1);
}

const REFERER = process.env.REFERER || 'https://9tsu.vip/';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.devtoolsDetector = { launch: () => {}, addListener: () => {} };
  });
  await page.setExtraHTTPHeaders({ Referer: REFERER });

  const m3u8Links = [];

  for (const url of urls) {
    console.log(`\n🔄 Memproses: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForFunction(
        () => typeof window.getPlaylist === 'function',
        { timeout: 30000 }
      );

      const param = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
          const match = script.textContent.match(/window\.getPlaylist\s*\(\s*['"]([^'"]+)['"]\s*\)/);
          if (match) return match[1];
        }
        return null;
      });

      if (!param) {
        console.warn(`⚠️ Parameter tidak ditemukan untuk ${url}`);
        continue;
      }

      const result = await page.evaluate(async (id) => {
        const decode = await window.getPlaylist(id);
        return decode.encrypted;
      }, param);

      if (result && result.match(/\.m3u8/i)) {
        console.log(`📥 Link ditemukan: ${result}`);
        m3u8Links.push(result);
      } else {
        console.warn(`⚠️ Tidak ada link m3u8 untuk ${url}`);
      }
    } catch (err) {
      console.error(`❌ Gagal memproses ${url}:`, err.message);
    }
  }

  await browser.close();

  const unique = [...new Set(m3u8Links)];
  fs.writeFileSync('output.m3u8', unique.join('\n'), 'utf8');
  console.log(`\n✅ Selesai, ${unique.length} link ditemukan.`);
})();
