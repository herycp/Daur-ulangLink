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
  
  const logMessage = `[${timestamp}] ${prefix} ${message}`;
  console.log(logMessage);
  
  if (data && DEBUG) {
    console.log(`  └─ Data: ${JSON.stringify(data, null, 2)}`);
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
function fetchHtmlWithReferer(url, referer) {
  return new Promise((resolve, reject) => {
    log(`Mengambil HTML dari: ${url}`, 'network');
    log(`Menggunakan referer: ${referer}`, 'network');
    
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
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    };
    
    const req = client.request(options, (res) => {
      log(`Response status: ${res.statusCode} ${res.statusMessage}`, 'network');
      log(`Content-Encoding: ${res.headers['content-encoding'] || 'none'}`, 'debug');
      
      let chunks = [];
      let totalLength = 0;
      
      res.on('data', (chunk) => {
        chunks.push(chunk);
        totalLength += chunk.length;
      });
      
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        log(`Raw data diterima: ${buffer.length} bytes`, 'debug');
        
        // Handle decompression
        const contentEncoding = res.headers['content-encoding'];
        let decompressStream;
        
        if (contentEncoding === 'gzip') {
          log('Mendekompresi gzip...', 'debug');
          decompressStream = zlib.createGunzip();
        } else if (contentEncoding === 'deflate') {
          log('Mendekompresi deflate...', 'debug');
          decompressStream = zlib.createInflate();
        } else if (contentEncoding === 'br') {
          log('Mendekompresi brotli...', 'debug');
          try {
            decompressStream = zlib.createBrotliDecompress();
          } catch (err) {
            log(`Brotli tidak didukung: ${err.message}`, 'warn');
            // Fallback: coba sebagai string biasa
            try {
              const html = buffer.toString('utf8');
              log(`HTML berhasil diambil (tanpa decompress): ${html.length} bytes`, 'success');
              resolve(html);
              return;
            } catch (e) {
              reject(new Error(`Gagal decode HTML: ${e.message}`));
              return;
            }
          }
        } else {
          // Tidak ada compression
          try {
            const html = buffer.toString('utf8');
            log(`HTML berhasil diambil: ${html.length} bytes`, 'success', { size: html.length });
            resolve(html);
            return;
          } catch (err) {
            reject(new Error(`Gagal decode HTML: ${err.message}`));
            return;
          }
        }
        
        // Proses decompression
        const decompress = zlib.createUnzip();
        let decompressedChunks = [];
        
        decompressStream.on('data', (chunk) => {
          decompressedChunks.push(chunk);
        });
        
        decompressStream.on('end', () => {
          const decompressed = Buffer.concat(decompressedChunks);
          try {
            const html = decompressed.toString('utf8');
            log(`HTML berhasil didekompresi: ${html.length} bytes`, 'success', { 
              original: buffer.length,
              decompressed: html.length
            });
            
            // Simpan HTML untuk debug
            if (DEBUG) {
              const debugPath = path.join(__dirname, 'debug-original.html');
              fs.writeFileSync(debugPath, html);
              log(`HTML asli disimpan ke: ${debugPath}`, 'debug');
            }
            
            resolve(html);
          } catch (err) {
            reject(new Error(`Gagal decode HTML setelah decompress: ${err.message}`));
          }
        });
        
        decompressStream.on('error', (err) => {
          log(`Gagal decompress: ${err.message}`, 'error');
          // Fallback: coba sebagai string biasa
          try {
            const html = buffer.toString('utf8');
            log(`Fallback: HTML sebagai string: ${html.length} bytes`, 'warn');
            resolve(html);
          } catch (e) {
            reject(new Error(`Gagal decode HTML: ${e.message}`));
          }
        });
        
        decompressStream.write(buffer);
        decompressStream.end();
      });
    });
    
    req.on('error', (err) => {
      log(`Gagal fetch HTML: ${err.message}`, 'error');
      reject(err);
    });
    
    req.setTimeout(30000, () => {
      log('Request timeout', 'error');
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

// ========== EKSTRAK VIDEO ID DARI HTML (PERBAIKAN) ==========
function extractVideoIdFromHtml(html) {
  log('Mencari video ID di HTML...', 'debug');
  
  // Pattern untuk mencari video ID
  const patterns = [
    // Pattern utama: window.getPlaylist(`ID`)
    /window\.getPlaylist\s*\(\s*`([^`]+)`\s*\)/,
    // Pattern dengan single quote
    /window\.getPlaylist\s*\(\s*'([^']+)'\s*\)/,
    // Pattern dengan double quote
    /window\.getPlaylist\s*\(\s*"([^"]+)"\s*\)/,
    // Pattern tanpa window
    /getPlaylist\s*\(\s*`([^`]+)`\s*\)/,
    /getPlaylist\s*\(\s*'([^']+)'\s*\)/,
    /getPlaylist\s*\(\s*"([^"]+)"\s*\)/,
    // Pattern untuk video_id variable
    /video_id\s*=\s*['"`]([^'"`]+)['"`]/,
    /var\s+videoId\s*=\s*['"`]([^'"`]+)['"`]/,
    // Pattern untuk data attribute
    /data-video-id\s*=\s*['"]([^'"]+)['"]/,
    // Pattern untuk ID 32 karakter hex
    /['"`]([a-f0-9]{32})['"`]/
  ];
  
  let foundId = null;
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) {
      // Validasi ID (harus 32 karakter hex)
      const id = match[1].trim();
      if (/^[a-f0-9]{32}$/.test(id)) {
        foundId = id;
        log(`Video ID ditemukan: ${foundId}`, 'success', { 
          pattern: pattern.toString(),
          id: foundId 
        });
        break;
      }
    }
  }
  
  if (!foundId) {
    log('Video ID tidak ditemukan di HTML', 'warn');
    
    // Debug: tampilkan bagian HTML yang mengandung getPlaylist
    if (DEBUG) {
      const getPlaylistIndex = html.indexOf('getPlaylist');
      if (getPlaylistIndex > -1) {
        const snippet = html.substring(
          Math.max(0, getPlaylistIndex - 100),
          Math.min(html.length, getPlaylistIndex + 200)
        );
        log('Snippet sekitar getPlaylist:', 'debug', { snippet });
      } else {
        log('Tidak ada "getPlaylist" di HTML', 'warn');
        // Tampilkan 2000 karakter pertama HTML
        log('Sample HTML (2000 chars):', 'debug', { 
          sample: html.substring(0, 2000) 
        });
      }
    }
  }
  
  return foundId;
}

// ========== BUAT HTML MINI ==========
function createMiniHtml(videoId, originalHtml) {
  log('Membuat HTML mini untuk ekstraksi...', 'html');
  log(`Video ID: ${videoId}`, 'info');
  
  // Cari script yang mengandung getPlaylist
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let getPlaylistScript = null;
  let match;
  
  while ((match = scriptRegex.exec(originalHtml)) !== null) {
    const scriptContent = match[1];
    if (scriptContent && (
      scriptContent.includes('getPlaylist') || 
      scriptContent.includes('window.getPlaylist')
    )) {
      getPlaylistScript = scriptContent;
      log('Fungsi getPlaylist ditemukan di script', 'success');
      break;
    }
  }
  
  // Coba cari script yang di-load dari external
  if (!getPlaylistScript) {
    log('Fungsi getPlaylist tidak ditemukan di inline script, coba external...', 'warn');
    
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
    <script src="//cdn.jwplayer.com/libraries/aVr2lJgW.js"></script>
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
        
        // ============================================================
        // FUNGSI getPlaylist (dari halaman asli)
        // ============================================================
        ${getPlaylistScript || `
        // Fallback: implementasi sederhana
        window.getPlaylist = async function(id) {
            logDebug('getPlaylist dipanggil dengan ID: ' + id);
            return { encrypted: null, tracks: null };
        };
        `}
        
        // ============================================================
        // FUNGSI UTAMA EKSTRAKSI
        // ============================================================
        async function extractPlaylist() {
            try {
                logDebug('Memulai ekstraksi playlist untuk ID: ' + window.videoId);
                
                if (typeof window.getPlaylist !== 'function') {
                    const error = 'window.getPlaylist tidak tersedia!';
                    logDebug(error);
                    window.error = error;
                    window.done = true;
                    return;
                }
                
                logDebug('Memanggil window.getPlaylist...');
                const result = await window.getPlaylist(window.videoId);
                logDebug('Hasil getPlaylist:', result);
                
                if (result && result.encrypted) {
                    window.m3u8Url = result.encrypted;
                    window.tracks = result.tracks || null;
                    logDebug('M3U8 URL ditemukan: ' + window.m3u8Url);
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
        // TUNGGU KOMPONEN
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
                        } else if (attempts > 200) {
                            logDebug('Timeout menunggu JWPlayer');
                            clearInterval(check);
                            resolve();
                        }
                    }, 100);
                }
            });
        }
        
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
                        } else if (attempts > 200) {
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
            
            const logsEl = document.getElementById('logs');
            if (logsEl) {
                logsEl.innerHTML = DEBUG_LOGS.map(log => 
                    '<div>[' + log.time + '] ' + log.message + (log.data ? ' ' + JSON.stringify(log.data) : '')
                ).join('<br>');
            }
        })();
    </script>
    <style>
        body { font-family: monospace; padding: 20px; background: #1a1a2e; color: #eee; margin: 0; }
        #status { padding: 20px; background: #16213e; border-radius: 8px; margin: 20px 0; font-size: 14px; word-break: break-all; }
        #logs { padding: 20px; background: #0f3460; border-radius: 8px; max-height: 400px; overflow-y: auto; font-size: 12px; line-height: 1.8; }
        .success { color: #4ade80; }
        .error { color: #f87171; }
        .info { color: #60a5fa; }
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
    
    htmlPath = path.join(__dirname, 'mini-player.html');
    fs.writeFileSync(htmlPath, miniHtml);
    log(`HTML mini disimpan: ${htmlPath}`, 'debug');
    
    // ====== STEP 4: Launch browser ======
    logStep(4, 6, 'Meluncurkan browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-web-security'
      ]
    });
    log('Browser berhasil diluncurkan', 'success');
    
    // ====== STEP 5: Create context ======
    logStep(5, 6, 'Membuat context dan page...');
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: { 'Referer': referer },
      viewport: { width: 1280, height: 720 }
    });
    
    page = await context.newPage();
    
    // Capture console logs
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[DEBUG]')) {
        log(text.replace('[DEBUG]', '').trim(), 'debug');
      } else if (text.includes('error') || text.includes('Error')) {
        log(text, 'error');
      }
    });
    
    page.on('pageerror', (error) => {
      log(`Page error: ${error.message}`, 'error');
    });
    
    // ====== STEP 6: Navigate ======
    logStep(6, 6, 'Menavigasi ke HTML mini...');
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    log('HTML mini berhasil dimuat', 'success');
    
    // ====== Tunggu ekstraksi ======
    log('Menunggu proses ekstraksi selesai...', 'info');
    await page.waitForFunction(
      () => window.done === true,
      { timeout: 120000, polling: 500 }
    );
    
    // ====== Ambil hasil ======
    const result = await page.evaluate(() => {
      return {
        encrypted: window.m3u8Url || null,
        tracks: window.tracks || null,
        error: window.error || null,
        done: window.done || false
      };
    });
    
    if (result.error) {
      throw new Error(`Ekstraksi error: ${result.error}`);
    }
    
    if (!result.encrypted) {
      throw new Error('Tidak ada encrypted URL ditemukan');
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`✅ EKSTRAKSI BERHASIL dalam ${duration} detik`, 'success');
    log(`📹 M3U8 URL: ${result.encrypted}`, 'success');
    
    await browser.close();
    if (htmlPath && fs.existsSync(htmlPath)) {
      fs.unlinkSync(htmlPath);
    }
    
    return result;
    
  } catch (err) {
    log(`❌ EKSTRAKSI GAGAL: ${err.message}`, 'error');
    
    if (page) {
      try {
        await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
        log('Screenshot disimpan: error-screenshot.png', 'debug');
      } catch (e) {}
      
      try {
        const content = await page.content();
        fs.writeFileSync('error-page.html', content);
        log('HTML page disimpan: error-page.html', 'debug');
      } catch (e) {}
    }
    
    if (browser) {
      await browser.close();
    }
    throw err;
  }
}

function logStep(step, total, message) {
  log(`[${step}/${total}] ${message}`, 'step');
}

// ========== MAIN ==========
async function main() {
  log('================================================', 'info');
  log('🎬 M3U8 EXTRACTOR v3.0', 'info');
  log('================================================', 'info');
  
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

  log('Tidak ada URL yang diberikan.', 'error');
  process.exit(1);
}

async function processSingleUrl(url, referer) {
  const db = initDatabase(DB_PATH);
  let result = null;
  let error = null;

  try {
    result = await extractM3U8(url, referer);
  } catch (err) {
    error = err.message;
  }

  const videoId = url.match(/embed\/([^?]+)/)?.[1] || null;
  
  saveToDatabase(
    db,
    url,
    videoId,
    result ? result.encrypted : null,
    result ? result.tracks : null,
    referer,
    error
  );

  let allData = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {}
  }
  
  allData.push({
    url,
    video_id: videoId,
    m3u8_url: result ? result.encrypted : null,
    tracks: result ? result.tracks : null,
    referer,
    error,
    created_at: new Date().toISOString()
  });
  
  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');

  if (result && result.encrypted) {
    fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
  }

  db.close();
}

async function processMultipleUrls(urls, referer) {
  const db = initDatabase(DB_PATH);
  let allData = [];
  
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {}
  }

  for (const url of urls) {
    log(`\n📌 Processing: ${url}`, 'info');
    let result = null;
    let error = null;
    
    try {
      result = await extractM3U8(url, referer);
    } catch (err) {
      error = err.message;
    }

    const videoId = url.match(/embed\/([^?]+)/)?.[1] || null;
    
    saveToDatabase(
      db,
      url,
      videoId,
      result ? result.encrypted : null,
      result ? result.tracks : null,
      referer,
      error
    );

    allData.push({
      url,
      video_id: videoId,
      m3u8_url: result ? result.encrypted : null,
      tracks: result ? result.tracks : null,
      referer,
      error,
      created_at: new Date().toISOString()
    });
    
    if (result && result.encrypted) {
      fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
    }
  }

  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');
  db.close();
}

main().catch(err => {
  log(`💥 Fatal error: ${err.message}`, 'error');
  console.error(err.stack);
  process.exit(1);
});
