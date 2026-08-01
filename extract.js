const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const Database = require('better-sqlite3');

// ========== KONFIGURASI ==========
const DEFAULT_REFERER = 'https://9tsu.vip/';
const DB_PATH = process.env.DB_PATH || 'playlist.db';
const JSON_PATH = process.env.JSON_PATH || 'output.json';
const M3U8_PATH = process.env.M3U8_PATH || 'output.m3u8';

// ========== FUNGSI DATABASE ==========
function initDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      m3u8_url TEXT,
      tracks TEXT,
      referer TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_url ON playlist(url);
  `);
  return db;
}

function saveToDatabase(db, url, m3u8Url, tracks, referer, error = null) {
  const stmt = db.prepare(`
    INSERT INTO playlist (url, m3u8_url, tracks, referer, error)
    VALUES (?, ?, ?, ?, ?)
  `);
  const info = stmt.run(url, m3u8Url, JSON.stringify(tracks), referer, error);
  return info.lastInsertRowid;
}

// ========== EKSTRAKSI DENGAN STEALTH ==========
async function extractM3U8(pageUrl, referer = DEFAULT_REFERER) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security'
    ],
    executablePath: process.env.CHROME_PATH || undefined
  });
  const page = await browser.newPage();

  // ====== 1. Matikan deteksi DevTools ======
  await page.evaluateOnNewDocument(() => {
    // Nonaktifkan devtools-detector
    window.devtoolsDetector = {
      launch: () => {},
      addListener: () => {},
      isOpen: false
    };
    // Cegah reload
    const originalReload = window.location.reload;
    window.location.reload = function() {
      console.log('[Puppeteer] Reload dicegah');
    };
    // Cegah alert
    window.alert = function() {};
    // Hapus event listener sebelum unload
    window.addEventListener('beforeunload', (e) => {
      e.stopImmediatePropagation();
    }, true);
    // Timpa navigasi
    window.location.replace = function() {};
    window.location.assign = function() {};
  });

  // ====== 2. Set Referer ======
  await page.setExtraHTTPHeaders({ Referer: referer });

  // ====== 3. Navigasi ======
  await page.goto(pageUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000
  });

  // ====== 4. Tunggu getPlaylist ======
  await page.waitForFunction(
    () => typeof window.getPlaylist === 'function',
    { timeout: 60000, polling: 500 }
  );

  // ====== 5. Ekstrak parameter ID ======
  const param = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script');
    for (let script of scripts) {
      const text = script.textContent;
      const match = text.match(/window\.getPlaylist\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (match) return match[1];
    }
    return null;
  });

  if (!param) {
    await browser.close();
    throw new Error('Parameter getPlaylist tidak ditemukan.');
  }

  // ====== 6. Panggil getPlaylist ======
  const result = await page.evaluate(async (id) => {
    const decode = await window.getPlaylist(id);
    return {
      encrypted: decode.encrypted,
      tracks: decode.tracks
    };
  }, param);

  await browser.close();
  return result;
}

// ========== FUNGSI MAIN ==========
async function main() {
  const args = process.argv.slice(2);
  let url = null;
  let referer = DEFAULT_REFERER;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && i + 1 < args.length) {
      url = args[i + 1];
      i++;
    } else if (args[i] === '--referer' && i + 1 < args.length) {
      referer = args[i + 1];
      i++;
    } else if (!url && !args[i].startsWith('--')) {
      url = args[i];
    }
  }

  if (process.env.INPUT_URLS) {
    const urls = process.env.INPUT_URLS.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      await processMultipleUrls(urls, referer);
      return;
    }
  }

  if (fs.existsSync('urls.txt')) {
    const urls = fs.readFileSync('urls.txt', 'utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (urls.length > 0) {
      await processMultipleUrls(urls, referer);
      return;
    }
  }

  if (url) {
    await processSingleUrl(url, referer);
    return;
  }

  console.error('Tidak ada URL yang diberikan.');
  process.exit(1);
}

async function processSingleUrl(url, referer) {
  console.log(`🔄 Memproses: ${url}`);
  const db = initDatabase(DB_PATH);
  let result = null;
  let error = null;

  try {
    result = await extractM3U8(url, referer);
    console.log(`✅ Link ditemukan: ${result.encrypted}`);
    if (result.tracks) {
      console.log(`📺 Tracks: ${JSON.stringify(result.tracks)}`);
    }
  } catch (err) {
    error = err.message;
    console.error(`❌ Gagal: ${error}`);
  }

  const id = saveToDatabase(
    db,
    url,
    result ? result.encrypted : null,
    result ? result.tracks : null,
    referer,
    error
  );
  console.log(`💾 Disimpan ke database (ID: ${id})`);

  let allData = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {
      allData = [];
    }
  }
  const entry = {
    id,
    url,
    m3u8_url: result ? result.encrypted : null,
    tracks: result ? result.tracks : null,
    referer,
    error,
    created_at: new Date().toISOString()
  };
  allData.push(entry);
  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');
  console.log(`💾 Disimpan ke ${JSON_PATH}`);

  if (result && result.encrypted) {
    fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
    console.log(`💾 Ditambahkan ke ${M3U8_PATH}`);
  }

  db.close();
}

async function processMultipleUrls(urls, referer) {
  console.log(`📋 Memproses ${urls.length} URL...`);
  const db = initDatabase(DB_PATH);
  let allData = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {
      allData = [];
    }
  }

  for (const url of urls) {
    console.log(`\n🔄 ${url}`);
    let result = null;
    let error = null;
    try {
      result = await extractM3U8(url, referer);
      console.log(`✅ ${result.encrypted}`);
    } catch (err) {
      error = err.message;
      console.error(`❌ ${error}`);
    }

    const id = saveToDatabase(
      db,
      url,
      result ? result.encrypted : null,
      result ? result.tracks : null,
      referer,
      error
    );
    console.log(`💾 DB ID: ${id}`);

    const entry = {
      id,
      url,
      m3u8_url: result ? result.encrypted : null,
      tracks: result ? result.tracks : null,
      referer,
      error,
      created_at: new Date().toISOString()
    };
    allData.push(entry);
    if (result && result.encrypted) {
      fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
    }
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');
  console.log(`\n✅ Selesai. Semua data disimpan di ${JSON_PATH} dan ${DB_PATH}`);
  db.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
