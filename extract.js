const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ========== KONFIGURASI ==========
const DEFAULT_REFERER = 'https://9tsu.vip/';
const DB_PATH = process.env.DB_PATH || 'playlist.db';
const JSON_PATH = process.env.JSON_PATH || 'output.json';
const M3U8_PATH = process.env.M3U8_PATH || 'output.m3u8';
const DEBUG = process.env.DEBUG === 'true' || true;

// ========== LOGGING FUNGSI ==========
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
  
  const logMessage = `[${timestamp}] ${prefix} ${message}`;
  console.log(logMessage);
  
  if (data && DEBUG) {
    console.log(`  └─ Data: ${JSON.stringify(data, null, 2)}`);
  }
}

function logStep(step, total, message) {
  log(`[${step}/${total}] ${message}`, 'step');
}

// ========== FUNGSI DATABASE ==========
function initDatabase(dbPath) {
  try {
    log('Membuka koneksi database...', 'database');
    const db = new Database(dbPath);
    
    log('Membuat tabel playlist...', 'database');
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
    
    log(`Database siap: ${dbPath}`, 'success', { path: dbPath });
    return db;
  } catch (err) {
    log(`Gagal inisialisasi database: ${err.message}`, 'error');
    throw err;
  }
}

function saveToDatabase(db, url, videoId, m3u8Url, tracks, referer, error = null) {
  try {
    log('Menyimpan ke database...', 'database');
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

// ========== FUNGSI FETCH HTML DENGAN REFERER (pakai fetch bawaan) ==========
async function fetchHtmlWithReferer(url, referer) {
  log(`Mengambil HTML dari: ${url}`, 'network');
  log(`Menggunakan referer: ${referer}`, 'network');
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'identity'  // Force plain text
      }
    });
    
    log(`Response status: ${response.status} ${response.statusText}`, 'network');
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    // Dapatkan buffer untuk inspeksi
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    
    log(`HTML berhasil diambil: ${html.length} bytes`, 'success', { size: html.length });
    
    // Simpan HTML untuk debug
    if (DEBUG) {
      const debugPath = path.join(__dirname, 'debug-original.html');
      fs.writeFileSync(debugPath, html);
      log(`HTML asli disimpan ke: ${debugPath}`, 'debug');
    }
    
    return html;
    
  } catch (err) {
    log(`Gagal fetch HTML: ${err.message}`, 'error');
    throw err;
  }
}

// ========== EKSTRAK VIDEO ID DARI HTML ==========
function extractVideoIdFromHtml(html) {
  log('Mencari video ID di HTML...', 'debug');
  
  // Pattern: window.getPlaylist('ID')
  const patterns = [
    /window\.getPlaylist\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    /getPlaylist\s*\(\s*['"]([^'"]+)['"]\s*\)/,
    /video_id\s*=\s*['"]([^'"]+)['"]/,
    /data-video-id\s*=\s*['"]([^'"]+)['"]/,
    /id\s*:\s*['"]([a-f0-9]{32})['"]/
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      log(`Video ID ditemukan: ${match[1]}`, 'success', { pattern: pattern.toString(), id: match[1] });
      return match[1];
    }
  }
  
  log('Video ID tidak ditemukan di HTML', 'warn');
  
  // Debug: tampilkan sample HTML
  if (DEBUG && html.length > 0) {
    const sample = html.substring(0, 500);
    log('Sample HTML:', 'debug', { sample });
  }
  
  return null;
}

// ========== BUAT HTML MINI UNTUK EKSTRAKSI ==========
function createMiniHtml(videoId, originalHtml) {
  log('Membuat HTML mini untuk ekstraksi...', 'html');
  log(`Video ID: ${videoId}`, 'info');
  
  // Cari script yang mengandung getPlaylist
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let getPlaylistScript = null;
  let match;
  
  while ((match = scriptRegex.exec(originalHtml)) !== null) {
    const scriptContent = match[1];
    if (scriptContent && scriptContent.includes('function') && scriptContent.includes('getPlaylist')) {
      getPlaylistScript = scriptContent;
      log('Fungsi getPlaylist ditemukan di script', 'success');
      break;
    }
  }
  
  // Coba cari di script yang di-load dari external
  if (!getPlaylistScript) {
    log('Fungsi getPlaylist tidak ditemukan di inline script, cek external...', 'warn');
    
    // Cari script src yang mengandung app.js
    const srcRegex = /<script[^>]*src=["']([^"']*app\.js[^"']*)["'][^>]*>/i;
    const srcMatch = originalHtml.match(srcRegex);
    if (srcMatch) {
      log(`App.js ditemukan di: ${srcMatch[1]}`, 'debug');
    }
  }
  
  // Buat HTML mini
  const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>M3U8 Extractor - Mini</title>
    <!-- Load JWPlayer -->
    <script src="//cdn.jwplayer.com/libraries/aVr2lJgW.js"></script>
    <!-- Load HLS.js untuk decoding -->
    <script src="//cdn.jsdelivr.net/npm/hls.js@0.14.17/dist/hls.min.js"></script>
    <script>
        // ============================================================
        // DEBUG LOGGING
        // ============================================================
        const DEBUG_LOGS = [];
        function logDebug(message, data) {
            const entry = { 
                time: new Date().toISOString(), 
                message: message, 
                data: data || null 
            };
            DEBUG_LOGS.push(entry);
            console.log('[DEBUG]', message, data || '');
        }
        
        // ============================================================
        // VARIABEL GLOBAL
        // ============================================================
        window.videoId = '${videoId}';
        window.m3u8Url = null;
        window.tracks = null;
        window.error = null;
        window.done = false;
        window.getPlaylistCalled = false;
        
        // ============================================================
        // FUNGSI getPlaylist (dari halaman asli)
        // ============================================================
        ${getPlaylistScript || 'window.getPlaylist = async function(id) { logDebug("getPlaylist dipanggil dengan ID: " + id); return { encrypted: null, tracks: null }; };'}
        
        // ============================================================
        // FUNGSI UTAMA EKSTRAKSI
        // ============================================================
        async function extractPlaylist() {
            try {
                logDebug('Memulai ekstraksi playlist untuk ID: ' + window.videoId);
                
                // Cek apakah getPlaylist tersedia
                if (typeof window.getPlaylist !== 'function') {
                    const error = 'window.getPlaylist tidak tersedia!';
                    logDebug(error);
                    window.error = error;
                    window.done = true;
                    return;
                }
                
                logDebug('Memanggil window.getPlaylist...');
                window.getPlaylistCalled = true;
                const result = await window.getPlaylist(window.videoId);
                logDebug('Hasil getPlaylist:', result);
                
                if (result && result.encrypted) {
                    window.m3u8Url = result.encrypted;
                    window.tracks = result.tracks || null;
                    logDebug('M3U8 URL ditemukan: ' + window.m3u8Url);
                    if (window.tracks) {
                        logDebug('Tracks ditemukan: ' + JSON.stringify(window.tracks));
                    }
                    window.done = true;
                    window.error = null;
                } else {
                    const error = 'Tidak ada encrypted URL di result';
                    logDebug(error);
                    window.error = error;
                    window.done = true;
                }
            } catch (err) {
                logDebug('Error dalam extractPlaylist: ' + err.message);
                window.error = err.message;
                window.done = true;
                console.error(err);
            }
        }
        
        // ============================================================
        // TUNGGU JWPLAYER LOAD
        // ============================================================
        function waitForJWPlayer() {
            return new Promise((resolve) => {
                logDebug('Menunggu JWPlayer...');
                if (typeof jwplayer !== 'undefined') {
                    logDebug('JWPlayer sudah tersedia');
                    resolve();
                } else {
                    let attempts = 0;
                    const check = setInterval(() => {
                        attempts++;
                        if (typeof jwplayer !== 'undefined') {
                            logDebug('JWPlayer tersedia setelah ' + attempts + ' percobaan');
                            clearInterval(check);
                            resolve();
                        } else if (attempts > 100) {
                            logDebug('Timeout menunggu JWPlayer');
                            clearInterval(check);
                            resolve();
                        }
                    }, 100);
                }
            });
        }
        
        // ============================================================
        // TUNGGU getPlaylist
        // ============================================================
        function waitForGetPlaylist() {
            return new Promise((resolve) => {
                logDebug('Menunggu window.getPlaylist...');
                if (typeof window.getPlaylist === 'function') {
                    logDebug('window.getPlaylist sudah tersedia');
                    resolve();
                } else {
                    let attempts = 0;
                    const check = setInterval(() => {
                        attempts++;
                        if (typeof window.getPlaylist === 'function') {
                            logDebug('window.getPlaylist tersedia setelah ' + attempts + ' percobaan');
                            clearInterval(check);
                            resolve();
                        } else if (attempts > 100) {
                            logDebug('Timeout menunggu window.getPlaylist');
                            clearInterval(check);
                            resolve();
                        }
                    }, 100);
                }
            });
        }
        
        // ============================================================
        // MAIN
        // ============================================================
        (async function() {
            logDebug('=== STARTING EXTRACTION ===');
            logDebug('Video ID: ' + window.videoId);
            
            await waitForJWPlayer();
            await waitForGetPlaylist();
            
            logDebug('Semua komponen siap, memulai ekstraksi...');
            await extractPlaylist();
            
            logDebug('=== EXTRACTION COMPLETE ===');
            logDebug('Done: ' + window.done);
            logDebug('Error: ' + window.error);
            logDebug('M3U8 URL: ' + window.m3u8Url);
            
            // Tampilkan hasil di elemen status
            const statusEl = document.getElementById('status');
            if (statusEl) {
                if (window.m3u8Url) {
                    statusEl.innerHTML = '✅ M3U8 ditemukan: <br><small>' + window.m3u8Url + '</small>';
                    statusEl.style.color = 'green';
                } else if (window.error) {
                    statusEl.innerHTML = '❌ Error: ' + window.error;
                    statusEl.style.color = 'red';
                } else {
                    statusEl.innerHTML = '⏳ Proses selesai, cek hasil...';
                }
            }
            
            // Tampilkan debug logs
            const logsEl = document.getElementById('logs');
            if (logsEl) {
                logsEl.innerHTML = DEBUG_LOGS.map(log => 
                    '<div>[' + log.time + '] ' + log.message + (log.data ? ' ' + JSON.stringify(log.data) : '')
                ).join('<br>');
            }
        })();
    </script>
    <style>
        body {
            font-family: monospace;
            padding: 20px;
            background: #1a1a2e;
            color: #eee;
            margin: 0;
        }
        #status {
            padding: 20px;
            background: #16213e;
            border-radius: 8px;
            margin: 20px 0;
            font-size: 14px;
            word-break: break-all;
        }
        #logs {
            padding: 20px;
            background: #0f3460;
            border-radius: 8px;
            max-height: 400px;
            overflow-y: auto;
            font-size: 12px;
            line-height: 1.8;
        }
        .success { color: #4ade80; }
        .error { color: #f87171; }
        .info { color: #60a5fa; }
        .warning { color: #fbbf24; }
        h3 { color: #a78bfa; }
    </style>
</head>
<body>
    <h1>🎬 M3U8 Extractor</h1>
    <div id="status">⏳ Loading...</div>
    <div id="player" style="display:none;"></div>
    <h3>📋 Debug Logs</h3>
    <div id="logs">Menunggu log...</div>
</body>
</html>
  `;
  
  log(`HTML mini berhasil dibuat: ${html.length} bytes`, 'success');
  return html;
}

// ========== EKSTRAKSI DENGAN PLAYWRIGHT ==========
async function extractM3U8(pageUrl, referer = DEFAULT_REFERER) {
  const startTime = Date.now();
  log('================================================', 'info');
  log(`🚀 MULAI EKSTRAKSI: ${pageUrl}`, 'info');
  log('================================================', 'info');
  
  let browser = null;
  let context = null;
  let page = null;
  let htmlPath = null;

  try {
    // ====== STEP 1: Fetch HTML asli ======
    logStep(1, 6, 'Mengambil HTML asli dengan referer...');
    const html = await fetchHtmlWithReferer(pageUrl, referer);
    
    // ====== STEP 2: Ekstrak video ID ======
    logStep(2, 6, 'Mengekstrak video ID...');
    const videoId = extractVideoIdFromHtml(html);
    if (!videoId) {
      throw new Error('Video ID tidak ditemukan di HTML');
    }
    log(`Video ID: ${videoId}`, 'success');
    
    // ====== STEP 3: Buat HTML mini ======
    logStep(3, 6, 'Membuat HTML mini...');
    const miniHtml = createMiniHtml(videoId, html);
    
    // Simpan HTML mini ke file
    htmlPath = path.join(__dirname, 'mini-player.html');
    fs.writeFileSync(htmlPath, miniHtml);
    log(`HTML mini disimpan: ${htmlPath}`, 'debug');
    
    // ====== STEP 4: Launch browser ======
    logStep(4, 6, 'Meluncurkan browser...');
    log('Menggunakan Playwright dengan Chromium...', 'browser');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    log('Browser berhasil diluncurkan', 'success');
    
    // ====== STEP 5: Create context dan page ======
    logStep(5, 6, 'Membuat context dan page...');
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Referer': referer
      },
      viewport: { width: 1280, height: 720 }
    });
    log('Context berhasil dibuat', 'success');
    
    page = await context.newPage();
    log('Page berhasil dibuat', 'success');
    
    // Capture console logs dari page
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[DEBUG]')) {
        log(text.replace('[DEBUG]', '').trim(), 'debug');
      } else if (text.includes('error') || text.includes('Error')) {
        log(text, 'error');
      } else {
        log(text, 'debug');
      }
    });
    
    page.on('pageerror', (error) => {
      log(`Page error: ${error.message}`, 'error');
    });
    
    // ====== STEP 6: Navigate ke HTML mini ======
    logStep(6, 6, 'Menavigasi ke HTML mini...');
    log(`File: ${htmlPath}`, 'debug');
    
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    log('HTML mini berhasil dimuat', 'success');
    
    // ====== Tunggu ekstraksi selesai ======
    log('Menunggu proses ekstraksi selesai...', 'info');
    await page.waitForFunction(
      () => window.done === true,
      { timeout: 120000, polling: 500 }
    );
    
    // ====== Ambil hasil ======
    log('Mengambil hasil ekstraksi...', 'debug');
    const result = await page.evaluate(() => {
      return {
        encrypted: window.m3u8Url || null,
        tracks: window.tracks || null,
        error: window.error || null,
        done: window.done || false,
        logs: window.DEBUG_LOGS || []
      };
    });
    
    log('Hasil ekstraksi:', 'debug', result);
    
    // ====== Cek error ======
    if (result.error) {
      throw new Error(`Ekstraksi error: ${result.error}`);
    }
    
    if (!result.encrypted) {
      throw new Error('Tidak ada encrypted URL ditemukan');
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`✅ EKSTRAKSI BERHASIL dalam ${duration} detik`, 'success');
    log(`📹 M3U8 URL: ${result.encrypted}`, 'success');
    
    // ====== Cleanup ======
    await browser.close();
    if (htmlPath && fs.existsSync(htmlPath)) {
      fs.unlinkSync(htmlPath);
      log('HTML mini dihapus', 'debug');
    }
    
    return result;
    
  } catch (err) {
    log(`❌ EKSTRAKSI GAGAL: ${err.message}`, 'error');
    
    // ====== Debug: screenshot ======
    if (page) {
      try {
        const screenshotPath = path.join(__dirname, 'error-screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        log(`Screenshot disimpan: ${screenshotPath}`, 'debug');
      } catch (screenshotErr) {
        log(`Gagal mengambil screenshot: ${screenshotErr.message}`, 'warn');
      }
    }
    
    // ====== Debug: HTML page ======
    if (page) {
      try {
        const content = await page.content();
        const htmlDebugPath = path.join(__dirname, 'error-page.html');
        fs.writeFileSync(htmlDebugPath, content);
        log(`HTML page disimpan: ${htmlDebugPath}`, 'debug');
      } catch (htmlErr) {
        log(`Gagal mengambil HTML: ${htmlErr.message}`, 'warn');
      }
    }
    
    if (browser) {
      await browser.close();
    }
    throw err;
  }
}

// ========== FUNGSI MAIN ==========
async function main() {
  log('================================================', 'info');
  log('🎬 M3U8 EXTRACTOR v3.0', 'info');
  log('================================================', 'info');
  log(`Debug mode: ${DEBUG}`, 'debug');
  
  const args = process.argv.slice(2);
  let url = null;
  let referer = DEFAULT_REFERER;

  // Parse arguments
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

  // Check environment variables
  if (process.env.INPUT_URLS) {
    const urls = process.env.INPUT_URLS.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      log(`Ditemukan ${urls.length} URL dari INPUT_URLS`, 'info');
      await processMultipleUrls(urls, referer);
      return;
    }
  }

  // Check urls.txt file
  if (fs.existsSync('urls.txt')) {
    const urls = fs.readFileSync('urls.txt', 'utf8')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    if (urls.length > 0) {
      log(`Ditemukan ${urls.length} URL dari urls.txt`, 'info');
      await processMultipleUrls(urls, referer);
      return;
    }
  }

  // Single URL from argument
  if (url) {
    log(`Memproses single URL dari argumen`, 'info');
    await processSingleUrl(url, referer);
    return;
  }

  log('Tidak ada URL yang diberikan.', 'error');
  log('Gunakan: --url <URL> atau buat file urls.txt', 'info');
  process.exit(1);
}

async function processSingleUrl(url, referer) {
  log(`\n📌 Processing: ${url}`, 'info');
  const db = initDatabase(DB_PATH);
  let result = null;
  let error = null;

  try {
    result = await extractM3U8(url, referer);
    log(`Link ditemukan: ${result.encrypted}`, 'success');
  } catch (err) {
    error = err.message;
    log(`Gagal: ${error}`, 'error');
  }

  // Ekstrak video ID dari URL
  const videoId = url.match(/embed\/([^?]+)/)?.[1] || null;

  const id = saveToDatabase(
    db,
    url,
    videoId,
    result ? result.encrypted : null,
    result ? result.tracks : null,
    referer,
    error
  );

  // Save to JSON
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
    video_id: videoId,
    m3u8_url: result ? result.encrypted : null,
    tracks: result ? result.tracks : null,
    referer,
    error,
    created_at: new Date().toISOString()
  };
  allData.push(entry);
  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');
  log(`Disimpan ke ${JSON_PATH}`, 'success');

  if (result && result.encrypted) {
    fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
    log(`Ditambahkan ke ${M3U8_PATH}`, 'success');
  }

  db.close();
  log(`✅ Selesai: ${url}\n`, 'success');
}

async function processMultipleUrls(urls, referer) {
  log(`\n📋 Memproses ${urls.length} URL...`, 'info');
  const db = initDatabase(DB_PATH);
  let allData = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {
      allData = [];
    }
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    log(`\n[${i + 1}/${urls.length}] Processing: ${url}`, 'info');
    let result = null;
    let error = null;
    
    try {
      result = await extractM3U8(url, referer);
      log(`✅ ${result.encrypted}`, 'success');
      successCount++;
    } catch (err) {
      error = err.message;
      log(`❌ ${error}`, 'error');
      failCount++;
    }

    const videoId = url.match(/embed\/([^?]+)/)?.[1] || null;
    const id = saveToDatabase(
      db,
      url,
      videoId,
      result ? result.encrypted : null,
      result ? result.tracks : null,
      referer,
      error
    );

    const entry = {
      id,
      url,
      video_id: videoId,
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
  log(`\n✅ Selesai! Sukses: ${successCount}, Gagal: ${failCount}`, 'success');
  log(`Data disimpan di ${JSON_PATH} dan ${DB_PATH}`, 'info');
  db.close();
}

// ========== RUN ==========
main().catch(err => {
  log(`💥 Fatal error: ${err.message}`, 'error');
  console.error(err.stack);
  process.exit(1);
});
