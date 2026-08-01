const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');
const zlib = require('zlib');

// ========== KONFIGURASI ==========
const DEFAULT_REFERER = 'https://9tsu.vip/';
const DB_PATH = process.env.DB_PATH || 'playlist.db';
const JSON_PATH = process.env.JSON_PATH || 'output.json';
const M3U8_PATH = process.env.M3U8_PATH || 'output.m3u8';
const DEBUG = process.env.DEBUG === 'true' || true;

// ========== LOGGING ==========
function log(message, level = 'info', data = null) {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warn: '⚠️',
    debug: '🔍',
    step: '📌',
    network: '🌐',
    database: '🗄️',
    browser: '🖥️',
    html: '📄'
  }[level] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
  if (data && DEBUG) {
    console.log(`  └─ ${JSON.stringify(data, null, 2)}`);
  }
}

// ========== FUNGSI DATABASE ==========
function initDatabase(dbPath) {
  try {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS playlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        video_id TEXT,
        m3u8_url TEXT,
        tracks TEXT,
        referer TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_url ON playlist(url);
      CREATE INDEX IF NOT EXISTS idx_video_id ON playlist(video_id);
    `);
    log(`Database siap: ${dbPath}`, 'success');
    return db;
  } catch (err) {
    log(`Gagal inisialisasi database: ${err.message}`, 'error');
    throw err;
  }
}

function saveToDatabase(db, url, videoId, m3u8Url, tracks, referer, error = null) {
  try {
    const stmt = db.prepare(`
      INSERT INTO playlist (url, video_id, m3u8_url, tracks, referer, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(url, videoId, m3u8Url, JSON.stringify(tracks), referer, error);
    log(`Data tersimpan (ID: ${info.lastInsertRowid})`, 'success');
    return info.lastInsertRowid;
  } catch (err) {
    log(`Gagal menyimpan ke database: ${err.message}`, 'error');
    throw err;
  }
}

// ========== FUNGSI FETCH HTML DENGAN HANDLE COMPRESSION ==========
function fetchUrl(url, referer) {
  return new Promise((resolve, reject) => {
    log(`Fetching: ${url}`, 'network');
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      }
    };
    
    const req = client.request(options, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        let decompress;
        if (encoding === 'gzip') decompress = zlib.createGunzip();
        else if (encoding === 'deflate') decompress = zlib.createInflate();
        else if (encoding === 'br') {
          try { decompress = zlib.createBrotliDecompress(); } catch(e) { decompress = null; }
        }
        if (decompress) {
          const chunks2 = [];
          decompress.on('data', (chunk) => chunks2.push(chunk));
          decompress.on('end', () => {
            resolve(Buffer.concat(chunks2).toString('utf8'));
          });
          decompress.on('error', () => {
            resolve(buffer.toString('utf8')); // fallback
          });
          decompress.write(buffer);
          decompress.end();
        } else {
          resolve(buffer.toString('utf8'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ========== EKSTRAK VIDEO ID ==========
function extractVideoId(html) {
  const patterns = [
    /window\.getPlaylist\s*\(\s*`([^`]+)`\s*\)/,
    /window\.getPlaylist\s*\(\s*'([^']+)'\s*\)/,
    /window\.getPlaylist\s*\(\s*"([^"]+)"\s*\)/,
    /getPlaylist\s*\(\s*`([^`]+)`\s*\)/,
    /getPlaylist\s*\(\s*'([^']+)'\s*\)/,
    /getPlaylist\s*\(\s*"([^"]+)"\s*\)/,
    /video_id\s*=\s*['"`]([^'"`]+)['"`]/,
    /['"`]([a-f0-9]{32})['"`]/
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1] && /^[a-f0-9]{32}$/.test(match[1])) {
      log(`Video ID ditemukan: ${match[1]}`, 'success');
      return match[1];
    }
  }
  return null;
}

// ========== AMBIL SCRIPT YANG MENGANDUNG getPlaylist ==========
function extractGetPlaylistScript(html, baseUrl) {
  log('Mencari script yang mengandung getPlaylist...', 'debug');
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let combinedScript = '';
  let found = false;
  
  while ((match = scriptRegex.exec(html)) !== null) {
    const content = match[1];
    if (content && content.includes('getPlaylist')) {
      combinedScript += content + '\n';
      found = true;
      log('Menemukan script dengan getPlaylist', 'debug');
    }
  }
  
  // Cari juga script src yang mengandung app.js
  const srcRegex = /<script[^>]*src=["']([^"']*app\.js[^"']*)["'][^>]*>/i;
  const srcMatch = html.match(srcRegex);
  if (srcMatch) {
    const appJsUrl = new URL(srcMatch[1], baseUrl).href;
    log(`Menemukan app.js: ${appJsUrl}`, 'debug');
    // Kita akan fetch app.js secara terpisah nanti
    return { combinedScript, appJsUrl, found };
  }
  
  return { combinedScript, appJsUrl: null, found };
}

// ========== BUAT HTML MINI ==========
function createMiniHtml(videoId, scriptContent, appJsUrl, referer) {
  log('Membuat HTML mini...', 'html');
  
  // Jika scriptContent kosong, kita akan load app.js langsung
  const scriptTag = appJsUrl 
    ? `<script src="${appJsUrl}"></script>` 
    : '';
  
  const inlineScript = scriptContent ? `
    // ===== FUNGSI getPlaylist dari halaman asli =====
    try {
      ${scriptContent}
      console.log('getPlaylist berhasil di-inject');
    } catch(e) {
      console.error('Gagal inject getPlaylist:', e);
    }
  ` : '';
  
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>M3U8 Extractor</title>
    <script src="//cdn.jwplayer.com/libraries/aVr2lJgW.js"></script>
    ${scriptTag}
    <script>
      // ===== INJECT SCRIPT getPlaylist =====
      ${inlineScript}
      
      // ===== FALLBACK: jika getPlaylist tetap undefined =====
      if (typeof window.getPlaylist !== 'function') {
        console.warn('window.getPlaylist masih undefined, mencoba fallback...');
        // Coba ambil dari window.parent atau window.top
        window.getPlaylist = window.getPlaylist || window.parent.getPlaylist || window.top.getPlaylist || null;
        if (typeof window.getPlaylist !== 'function') {
          console.error('window.getPlaylist tetap tidak tersedia');
        }
      }
      
      // ===== VARIABEL =====
      window.videoId = '${videoId}';
      window.m3u8Url = null;
      window.tracks = null;
      window.error = null;
      window.done = false;
      
      // ===== EKSTRAKSI =====
      async function extract() {
        try {
          console.log('Memanggil getPlaylist dengan ID:', window.videoId);
          const result = await window.getPlaylist(window.videoId);
          console.log('Hasil:', result);
          if (result && result.encrypted) {
            window.m3u8Url = result.encrypted;
            window.tracks = result.tracks || null;
            window.done = true;
          } else {
            window.error = 'Tidak ada encrypted URL';
            window.done = true;
          }
        } catch(err) {
          window.error = err.message;
          window.done = true;
          console.error(err);
        }
      }
      
      // ===== TUNGGU JWPLAYER DAN getPlaylist =====
      function waitFor(condition, timeout = 30000) {
        return new Promise((resolve) => {
          if (condition()) return resolve();
          let elapsed = 0;
          const interval = 200;
          const timer = setInterval(() => {
            elapsed += interval;
            if (condition() || elapsed >= timeout) {
              clearInterval(timer);
              resolve();
            }
          }, interval);
        });
      }
      
      (async function() {
        console.log('Menunggu JWPlayer dan getPlaylist...');
        await waitFor(() => typeof jwplayer !== 'undefined');
        await waitFor(() => typeof window.getPlaylist === 'function');
        console.log('Komponen siap, memulai ekstraksi...');
        await extract();
        console.log('Ekstraksi selesai. Done:', window.done);
        document.getElementById('status').innerHTML = window.m3u8Url 
          ? '✅ M3U8: ' + window.m3u8Url 
          : '❌ Error: ' + (window.error || 'Tidak ditemukan');
      })();
    </script>
    <style>
      body { font-family: monospace; padding: 20px; background: #1a1a2e; color: #eee; }
      #status { padding: 20px; background: #16213e; border-radius: 8px; margin-top: 20px; word-break: break-all; }
    </style>
</head>
<body>
    <h1>🎬 M3U8 Extractor</h1>
    <div id="status">⏳ Loading...</div>
    <div id="player" style="display:none;"></div>
</body>
</html>
  `;
}

// ========== EKSTRAKSI UTAMA ==========
async function extractM3U8(pageUrl, referer = DEFAULT_REFERER) {
  log(`🚀 MULAI EKSTRAKSI: ${pageUrl}`, 'info');
  
  let browser, context, page;
  try {
    // 1. Fetch HTML asli
    log('Step 1: Fetch HTML asli', 'step');
    const html = await fetchUrl(pageUrl, referer);
    log(`HTML berhasil: ${html.length} bytes`, 'success');
    
    // 2. Cari video ID
    log('Step 2: Cari video ID', 'step');
    const videoId = extractVideoId(html);
    if (!videoId) throw new Error('Video ID tidak ditemukan');
    log(`Video ID: ${videoId}`, 'success');
    
    // 3. Cari script getPlaylist
    log('Step 3: Cari script getPlaylist', 'step');
    const { combinedScript, appJsUrl, found } = extractGetPlaylistScript(html, pageUrl);
    log(`Script ditemukan: ${found}, appJsUrl: ${appJsUrl || 'tidak ada'}`, 'debug');
    
    // 4. Buat HTML mini
    log('Step 4: Buat HTML mini', 'step');
    const miniHtml = createMiniHtml(videoId, combinedScript, appJsUrl, referer);
    const miniPath = path.join(__dirname, 'mini.html');
    fs.writeFileSync(miniPath, miniHtml);
    log(`HTML mini disimpan: ${miniPath}`, 'debug');
    
    // 5. Launch browser
    log('Step 5: Launch browser', 'step');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      extraHTTPHeaders: { 'Referer': referer }
    });
    page = await context.newPage();
    
    // 6. Navigate
    log('Step 6: Navigasi ke HTML mini', 'step');
    await page.goto(`file://${miniPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // 7. Tunggu hasil
    log('Menunggu ekstraksi selesai...', 'info');
    await page.waitForFunction(() => window.done === true, { timeout: 120000, polling: 500 });
    
    const result = await page.evaluate(() => ({
      encrypted: window.m3u8Url,
      tracks: window.tracks,
      error: window.error
    }));
    
    if (result.error) throw new Error(result.error);
    if (!result.encrypted) throw new Error('Tidak ada encrypted URL');
    
    log(`✅ M3U8: ${result.encrypted}`, 'success');
    await browser.close();
    fs.unlinkSync(miniPath);
    return result;
    
  } catch (err) {
    log(`❌ Gagal: ${err.message}`, 'error');
    if (page) {
      try {
        await page.screenshot({ path: 'error.png', fullPage: true });
        const content = await page.content();
        fs.writeFileSync('error.html', content);
      } catch(e) {}
    }
    if (browser) await browser.close();
    throw err;
  }
}

// ========== MAIN ==========
async function main() {
  log('🎬 M3U8 EXTRACTOR v3.1', 'info');
  const args = process.argv.slice(2);
  let url = null, referer = DEFAULT_REFERER;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') { url = args[i+1]; i++; }
    else if (args[i] === '--referer') { referer = args[i+1]; i++; }
    else if (!url) url = args[i];
  }
  
  if (process.env.INPUT_URLS) {
    const urls = process.env.INPUT_URLS.split(',').map(s=>s.trim()).filter(Boolean);
    if (urls.length) {
      for (const u of urls) {
        try {
          const result = await extractM3U8(u, referer);
          // save to db, json, m3u8
        } catch(e) { log(`Gagal: ${e.message}`, 'error'); }
      }
      return;
    }
  }
  
  if (fs.existsSync('urls.txt')) {
    const urls = fs.readFileSync('urls.txt','utf8').split('\n').map(s=>s.trim()).filter(Boolean);
    for (const u of urls) {
      try {
        const result = await extractM3U8(u, referer);
        // save
      } catch(e) { log(`Gagal: ${e.message}`, 'error'); }
    }
    return;
  }
  
  if (url) {
    const result = await extractM3U8(url, referer);
    // save
  } else {
    log('Tidak ada URL', 'error');
  }
}

main().catch(console.error);
