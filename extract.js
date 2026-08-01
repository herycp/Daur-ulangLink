const { chromium } = require('playwright');
const fs = require('fs');
const Database = require('better-sqlite3');

// ========== KONFIGURASI ==========
const DEFAULT_REFERER = 'https://9tsu.vip/';
const DB_PATH = process.env.DB_PATH || 'playlist.db';
const JSON_PATH = process.env.JSON_PATH || 'output.json';
const M3U8_PATH = process.env.M3U8_PATH || 'output.m3u8';
const DEBUG = process.env.DEBUG === 'true' || true;

// ========== LOGGING ==========
function log(message, level = 'info') {
  const timestamp = new Date().toISOString();
  const prefix = {
    info: 'ℹ️',
    success: '✅',
    error: '❌',
    warn: '⚠️',
    debug: '🔍'
  }[level] || 'ℹ️';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

function debugLog(message) {
  if (DEBUG) {
    log(message, 'debug');
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
        m3u8_url TEXT,
        tracks TEXT,
        referer TEXT,
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_url ON playlist(url);
    `);
    log(`Database initialized: ${dbPath}`, 'success');
    return db;
  } catch (err) {
    log(`Failed to initialize database: ${err.message}`, 'error');
    throw err;
  }
}

function saveToDatabase(db, url, m3u8Url, tracks, referer, error = null) {
  try {
    const stmt = db.prepare(`
      INSERT INTO playlist (url, m3u8_url, tracks, referer, error)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(url, m3u8Url, JSON.stringify(tracks), referer, error);
    log(`Saved to database (ID: ${info.lastInsertRowid})`, 'success');
    return info.lastInsertRowid;
  } catch (err) {
    log(`Failed to save to database: ${err.message}`, 'error');
    throw err;
  }
}

// ========== EKSTRAKSI DENGAN PLAYWRIGHT ==========
async function extractM3U8(pageUrl, referer = DEFAULT_REFERER) {
  log(`Starting extraction for: ${pageUrl}`, 'info');
  log(`Using referer: ${referer}`, 'debug');
  
  let browser = null;
  let context = null;
  let page = null;

  try {
    // ====== 1. Launch browser ======
    log('Launching Chromium browser...', 'debug');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--disable-gpu',
        '--disable-dev-shm-usage'
      ]
    });
    log('Browser launched successfully', 'success');

    // ====== 2. Create context with custom user agent ======
    log('Creating browser context...', 'debug');
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      extraHTTPHeaders: {
        'Referer': referer
      },
      viewport: { width: 1920, height: 1080 }
    });
    log('Browser context created', 'success');

    // ====== 3. Create page ======
    page = await context.newPage();
    log('New page created', 'debug');

    // ====== 4. Add anti-devtools script ======
    log('Injecting anti-devtools bypass...', 'debug');
    await page.addInitScript(() => {
      // Nonaktifkan devtools-detector
      window.devtoolsDetector = {
        launch: () => {},
        addListener: () => {},
        isOpen: false
      };
      
      // Cegah reload
      const originalReload = window.location.reload;
      window.location.reload = function() {
        console.log('[Playwright] Reload prevented');
      };
      
      // Cegah alert
      window.alert = function() {};
      
      // Hapus event listener
      window.addEventListener('beforeunload', (e) => {
        e.stopImmediatePropagation();
      }, true);
      
      // Timpa navigasi
      window.location.replace = function() {};
      window.location.assign = function() {};
      
      // Override console.log untuk debugging
      const originalConsole = console.log;
      console.log = function(...args) {
        if (args[0] && typeof args[0] === 'string') {
          // Filter pesan tertentu
          if (!args[0].includes('devtools')) {
            originalConsole.apply(console, args);
          }
        } else {
          originalConsole.apply(console, args);
        }
      };
    });
    log('Anti-devtools bypass injected', 'success');

    // ====== 5. Navigate to page ======
    log(`Navigating to: ${pageUrl}`, 'info');
    log('Waiting for domcontentloaded (timeout: 120s)...', 'debug');
    
    let response = null;
    try {
      response = await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000
      });
      log(`Page loaded with status: ${response ? response.status() : 'unknown'}`, 'success');
    } catch (err) {
      log(`Navigation error: ${err.message}`, 'error');
      
      // Coba alternatif dengan networkidle
      log('Trying alternative navigation with networkidle...', 'warn');
      response = await page.goto(pageUrl, {
        waitUntil: 'networkidle',
        timeout: 120000
      });
      log(`Page loaded with status: ${response ? response.status() : 'unknown'}`, 'success');
    }

    if (response && response.status() !== 200) {
      log(`Page returned non-200 status: ${response.status()}`, 'warn');
    }

    // ====== 6. Log page title ======
    try {
      const title = await page.title();
      log(`Page title: "${title}"`, 'debug');
    } catch (err) {
      log(`Could not get page title: ${err.message}`, 'warn');
    }

    // ====== 7. Check for getPlaylist function ======
    log('Waiting for window.getPlaylist function...', 'debug');
    try {
      await page.waitForFunction(
        () => typeof window.getPlaylist === 'function',
        { timeout: 60000, polling: 500 }
      );
      log('window.getPlaylist found!', 'success');
    } catch (err) {
      log(`getPlaylist function not found: ${err.message}`, 'error');
      
      // Debug: log semua script
      const scripts = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script')).map(s => s.src || 'inline');
      });
      log(`Scripts found: ${scripts.join(', ')}`, 'debug');
      
      throw new Error('window.getPlaylist function not available');
    }

    // ====== 8. Extract parameter ID ======
    log('Extracting parameter ID...', 'debug');
    const param = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (let script of scripts) {
        const text = script.textContent;
        if (text && text.includes('getPlaylist')) {
          const match = text.match(/window\.getPlaylist\s*\(\s*['"]([^'"]+)['"]\s*\)/);
          if (match) {
            return match[1];
          }
        }
      }
      return null;
    });

    if (!param) {
      log('Parameter ID not found in scripts', 'error');
      
      // Debug: log semua script content
      const allScripts = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('script')).map(s => s.textContent);
      });
      log(`All scripts content (first 100 chars each):`, 'debug');
      allScripts.forEach((script, index) => {
        if (script && script.includes('getPlaylist')) {
          log(`Script ${index}: ${script.substring(0, 200)}...`, 'debug');
        }
      });
      
      throw new Error('Parameter ID not found');
    }
    log(`Parameter ID: ${param}`, 'info');

    // ====== 9. Call getPlaylist ======
    log('Calling window.getPlaylist...', 'info');
    let result = null;
    try {
      result = await page.evaluate(async (id) => {
        console.log(`Calling getPlaylist with ID: ${id}`);
        const decode = await window.getPlaylist(id);
        console.log('getPlaylist result:', decode);
        return {
          encrypted: decode.encrypted,
          tracks: decode.tracks
        };
      }, param);
      log('getPlaylist called successfully', 'success');
    } catch (err) {
      log(`Error calling getPlaylist: ${err.message}`, 'error');
      throw err;
    }

    if (!result || !result.encrypted) {
      log('No encrypted URL found in result', 'error');
      log(`Result: ${JSON.stringify(result)}`, 'debug');
      throw new Error('No encrypted URL found');
    }

    log(`Encrypted URL found: ${result.encrypted}`, 'success');
    if (result.tracks) {
      log(`Tracks found: ${JSON.stringify(result.tracks)}`, 'debug');
    }

    // ====== 10. Close browser ======
    await browser.close();
    log('Browser closed', 'debug');

    return result;

  } catch (err) {
    log(`Extraction failed: ${err.message}`, 'error');
    if (page) {
      try {
        // Screenshot untuk debug
        await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
        log('Error screenshot saved: error-screenshot.png', 'debug');
        
        // Log HTML untuk debug
        const html = await page.content();
        fs.writeFileSync('error-page.html', html);
        log('Error HTML saved: error-page.html', 'debug');
      } catch (screenshotErr) {
        log(`Could not capture debug info: ${screenshotErr.message}`, 'warn');
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
  log('=== M3U8 Extractor Started ===', 'info');
  log(`Debug mode: ${DEBUG}`, 'debug');
  
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

  // Check environment variables
  if (process.env.INPUT_URLS) {
    const urls = process.env.INPUT_URLS.split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length > 0) {
      log(`Found ${urls.length} URLs from INPUT_URLS`, 'info');
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
      log(`Found ${urls.length} URLs from urls.txt`, 'info');
      await processMultipleUrls(urls, referer);
      return;
    }
  }

  // Single URL from argument
  if (url) {
    log(`Processing single URL from argument`, 'info');
    await processSingleUrl(url, referer);
    return;
  }

  log('No URLs provided. Use --url, urls.txt, or INPUT_URLS environment variable', 'error');
  process.exit(1);
}

async function processSingleUrl(url, referer) {
  log(`\n=== Processing: ${url} ===`, 'info');
  const db = initDatabase(DB_PATH);
  let result = null;
  let error = null;

  try {
    result = await extractM3U8(url, referer);
    log(`Link found: ${result.encrypted}`, 'success');
    if (result.tracks) {
      log(`Tracks: ${JSON.stringify(result.tracks)}`, 'debug');
    }
  } catch (err) {
    error = err.message;
    log(`Failed: ${error}`, 'error');
  }

  const id = saveToDatabase(
    db,
    url,
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
    m3u8_url: result ? result.encrypted : null,
    tracks: result ? result.tracks : null,
    referer,
    error,
    created_at: new Date().toISOString()
  };
  allData.push(entry);
  fs.writeFileSync(JSON_PATH, JSON.stringify(allData, null, 2), 'utf8');
  log(`Saved to ${JSON_PATH}`, 'success');

  if (result && result.encrypted) {
    fs.appendFileSync(M3U8_PATH, result.encrypted + '\n', 'utf8');
    log(`Added to ${M3U8_PATH}`, 'success');
  }

  db.close();
  log(`=== Finished: ${url} ===\n`, 'info');
}

async function processMultipleUrls(urls, referer) {
  log(`\n=== Processing ${urls.length} URLs ===`, 'info');
  const db = initDatabase(DB_PATH);
  let allData = [];
  if (fs.existsSync(JSON_PATH)) {
    try {
      allData = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    } catch (e) {
      allData = [];
    }
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    log(`\n[${i + 1}/${urls.length}] Processing: ${url}`, 'info');
    let result = null;
    let error = null;
    
    try {
      result = await extractM3U8(url, referer);
      log(`✅ ${result.encrypted}`, 'success');
    } catch (err) {
      error = err.message;
      log(`❌ ${error}`, 'error');
    }

    const id = saveToDatabase(
      db,
      url,
      result ? result.encrypted : null,
      result ? result.tracks : null,
      referer,
      error
    );

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
  log(`\n✅ All done. Data saved to ${JSON_PATH} and ${DB_PATH}`, 'success');
  db.close();
}

// ========== RUN ==========
main().catch(err => {
  log(`Fatal error: ${err.message}`, 'error');
  console.error(err.stack);
  process.exit(1);
});
