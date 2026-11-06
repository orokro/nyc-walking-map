const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { exec } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const cors = require('cors');
const JSZip = require('jszip');

const execAsync = promisify(exec);
const PORT = 3456;
const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const TILE_CACHE_DIR = path.join(ROOT_DIR, 'tile_cache');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const WALKS_FILE = path.join(DATA_DIR, 'walks.json');
const BOROUGHS_FILE = path.join(DATA_DIR, 'borough-lines.geojson');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });

const TILE_PROVIDERS = {
  'google-roadmap': {
    name: 'Google Maps (Roadmap 2x)',
    urlTemplate: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&scale=2',
    isOpenShareable: false,
    contentType: 'image/png',
  },
  'google-terrain': {
    name: 'Google Maps (Terrain 2x)',
    urlTemplate: 'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}&scale=2',
    isOpenShareable: false,
    contentType: 'image/png',
  },
  'google-hybrid': {
    name: 'Google Maps (Hybrid Satellite 2x)',
    urlTemplate: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2',
    isOpenShareable: false,
    contentType: 'image/jpeg',
  },
  'google-satellite': {
    name: 'Google Maps (Satellite 2x)',
    urlTemplate: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2',
    isOpenShareable: false,
    contentType: 'image/jpeg',
  },
  'carto-voyager': {
    name: 'Carto Voyager (Open 2x)',
    urlTemplate: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    isOpenShareable: true,
    contentType: 'image/png',
  },
  'carto-light': {
    name: 'Carto Positron Light (Open 2x)',
    urlTemplate: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
    isOpenShareable: true,
    contentType: 'image/png',
  },
  'carto-dark': {
    name: 'Carto Dark Matter (Open 2x)',
    urlTemplate: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    isOpenShareable: true,
    contentType: 'image/png',
  },
  osm: {
    name: 'OpenStreetMap Standard (Open)',
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    isOpenShareable: true,
    contentType: 'image/png',
  },
  'esri-sat': {
    name: 'Esri World Imagery (Satellite)',
    urlTemplate:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    isOpenShareable: true,
    contentType: 'image/jpeg',
  },
};

function hexToKmlColor(hex, alphaHex = 'ff') {
  const clean = (hex || '#0288D1').replace('#', '').trim();
  if (clean.length !== 6) return 'ffd18802';
  const rr = clean.substring(0, 2).toLowerCase();
  const gg = clean.substring(2, 4).toLowerCase();
  const bb = clean.substring(4, 6).toLowerCase();
  return `${alphaHex}${bb}${gg}${rr}`;
}

function escapeXml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function generateKmzBuffer(dataset, boroughGeoJson) {
  const foldersMap = new Map();
  const ensureFolder = (name) => {
    if (!foldersMap.has(name)) foldersMap.set(name, { name, placemarks: [] });
    return foldersMap.get(name);
  };

  const styleSet = new Map();
  const registerStyle = (colorHex, width) => {
    const cleanHex = (colorHex || '#0288D1').replace('#', '').toUpperCase();
    const wInt = Math.round(width * 1000);
    const id = `line-${cleanHex}-${wInt}-nodesc`;
    if (!styleSet.has(id)) styleSet.set(id, { id, colorHex: `#${cleanHex}`, width });
    return id;
  };

  if (boroughGeoJson && Array.isArray(boroughGeoJson.features)) {
    const bFolder = ensureFolder('Borough LInes');
    const styleId = registerStyle(
      dataset.settings.boroughLineColor || '#E65100',
      dataset.settings.boroughLineWidth || 3.0
    );
    for (const feat of boroughGeoJson.features) {
      const name = feat.properties?.name || 'Borough';
      const coords = feat.geometry?.coordinates || [];
      const coordStr = coords.map((c) => `${c[0]},${c[1]},0`).join('\n            ');
      bFolder.placemarks.push(`      <Placemark>
        <name>${escapeXml(name)}</name>
        <styleUrl>#${styleId}</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>
            ${coordStr}
          </coordinates>
        </LineString>
      </Placemark>`);
    }
  }

  for (const walk of dataset.walks) {
    let folderName = 'Other';
    let colorHex = dataset.settings.completedWalkColor || '#0288D1';
    let width = dataset.settings.completedWalkWidth || 3.2;

    if (walk.isSubwayWalk) {
      folderName = 'Subway Walks';
      colorHex = dataset.settings.subwayWalkColor || '#0097A7';
      width = dataset.settings.subwayWalkWidth || 3.2;
    } else if (walk.status === 'planned') {
      folderName = walk.manualLayerId === 'other' ? 'Other' : 'To Walk';
      colorHex = '#000000';
      width = 2.0;
    } else {
      const yr = walk.date ? walk.date.substring(0, 4) : walk.year || '2026';
      folderName = yr === '2020' || yr === '2021' ? '2020 / 2021' : yr;
    }

    if (walk.styleOverride?.color) colorHex = walk.styleOverride.color;
    if (walk.styleOverride?.width) width = walk.styleOverride.width;

    const styleId = registerStyle(colorHex, width);
    const folder = ensureFolder(folderName);
    const displayName = walk.date ? `${walk.date} ${walk.title}` : walk.title;
    const coordStr = walk.coordinates.map((c) => `${c[0]},${c[1]},0`).join('\n            ');
    const descXml = walk.notes ? `\n        <description>${escapeXml(walk.notes)}</description>` : '';

    folder.placemarks.push(`      <Placemark>
        <name>${escapeXml(displayName)}</name>${descXml}
        <styleUrl>#${styleId}</styleUrl>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>
            ${coordStr}
          </coordinates>
        </LineString>
      </Placemark>`);
  }

  const stylesXml = [];
  for (const st of styleSet.values()) {
    const kmlColor = hexToKmlColor(st.colorHex, 'ff');
    const normWidth = Number(st.width.toFixed(2));
    const hiWidth = Number((st.width * 1.5).toFixed(2));
    stylesXml.push(`    <Style id="${st.id}-normal">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>${normWidth}</width>
      </LineStyle>
    </Style>
    <Style id="${st.id}-highlight">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>${hiWidth}</width>
      </LineStyle>
    </Style>
    <StyleMap id="${st.id}">
      <Pair>
        <key>normal</key>
        <styleUrl>#${st.id}-normal</styleUrl>
      </Pair>
      <Pair>
        <key>highlight</key>
        <styleUrl>#${st.id}-highlight</styleUrl>
      </Pair>
    </StyleMap>`);
  }

  const foldersXml = [];
  for (const folder of foldersMap.values()) {
    if (folder.placemarks.length === 0) continue;
    foldersXml.push(`    <Folder>
      <name>${escapeXml(folder.name)}</name>
${folder.placemarks.join('\n')}
    </Folder>`);
  }

  const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Walks</name>
    <description>Exported from NYC Walks Map</description>
${stylesXml.join('\n')}
${foldersXml.join('\n')}
  </Document>
</kml>`;

  const zip = new JSZip();
  zip.file('doc.kml', kmlContent);
  return await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

async function fetchAndCacheTile(providerKey, z, x, y) {
  const provider = TILE_PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown tile provider: ${providerKey}`);

  const ext = provider.contentType === 'image/jpeg' ? 'jpg' : 'png';
  const tilePath = path.join(TILE_CACHE_DIR, providerKey, String(z), String(x), `${y}.${ext}`);

  if (fs.existsSync(tilePath)) {
    const buffer = await fs.promises.readFile(tilePath);
    return { buffer, contentType: provider.contentType, fromCache: true };
  }

  const remoteUrl = provider.urlTemplate
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  const response = await fetch(remoteUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });

  if (!response.ok) throw new Error(`Upstream tile error ${response.status}`);

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  await fs.promises.mkdir(path.dirname(tilePath), { recursive: true });
  await fs.promises.writeFile(tilePath, buffer);

  return { buffer, contentType: provider.contentType, fromCache: false };
}

function countFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = countFilesRecursive(full);
      count += sub.count;
      bytes += sub.bytes;
    } else {
      count += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { count, bytes };
}

function lon2tile(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat, zoom) {
  return Math.floor(
    ((1 -
      Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2) *
      Math.pow(2, zoom)
  );
}

let prefetchState = {
  running: false,
  provider: '',
  total: 0,
  completed: 0,
  cachedHits: 0,
  downloaded: 0,
  errors: 0,
};

function startEmbeddedExpressServer() {
  return new Promise((resolve) => {
    const serverApp = express();
    serverApp.use(cors());
    serverApp.use(express.json({ limit: '50mb' }));

    serverApp.get('/api/walks', (_req, res) => {
      try {
        if (!fs.existsSync(WALKS_FILE)) return res.status(404).json({ error: 'walks.json not found' });
        res.setHeader('Content-Type', 'application/json');
        res.send(fs.readFileSync(WALKS_FILE, 'utf-8'));
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    serverApp.put('/api/walks', (req, res) => {
      try {
        const dataset = req.body;
        if (!dataset || !Array.isArray(dataset.walks)) {
          return res.status(400).json({ error: 'Invalid walk dataset payload' });
        }
        dataset.updatedAt = new Date().toISOString();
        if (fs.existsSync(WALKS_FILE)) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.copyFileSync(WALKS_FILE, path.join(BACKUP_DIR, `walks-${stamp}.json`));
          const backups = fs
            .readdirSync(BACKUP_DIR)
            .filter((f) => f.startsWith('walks-'))
            .sort();
          while (backups.length > 15) {
            fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
          }
        }
        fs.writeFileSync(WALKS_FILE, JSON.stringify(dataset, null, 2), 'utf-8');
        res.json({ ok: true, updatedAt: dataset.updatedAt, count: dataset.walks.length });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    serverApp.get('/api/export/kmz', async (_req, res) => {
      try {
        const dataset = JSON.parse(fs.readFileSync(WALKS_FILE, 'utf-8'));
        const boroughs = fs.existsSync(BOROUGHS_FILE)
          ? JSON.parse(fs.readFileSync(BOROUGHS_FILE, 'utf-8'))
          : null;
        const kmzBuffer = await generateKmzBuffer(dataset, boroughs);
        res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
        res.setHeader('Content-Disposition', 'attachment; filename="Walks.kmz"');
        res.send(kmzBuffer);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    serverApp.get('/api/tiles/:provider/:z/:x/:y', async (req, res) => {
      try {
        const { provider, z, x, y } = req.params;
        const cleanY = y.replace(/\.(png|jpg|jpeg|webp)$/i, '');
        const result = await fetchAndCacheTile(provider, z, x, cleanY);
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('X-Tile-Cache', result.fromCache ? 'HIT' : 'MISS');
        res.send(result.buffer);
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    });

    serverApp.get('/api/tiles-status', (_req, res) => {
      const stats = {};
      for (const key of Object.keys(TILE_PROVIDERS)) {
        const { count, bytes } = countFilesRecursive(path.join(TILE_CACHE_DIR, key));
        stats[key] = { count, sizeMB: Number((bytes / (1024 * 1024)).toFixed(2)) };
      }
      res.json({ providers: stats, prefetch: prefetchState });
    });

    serverApp.post('/api/tiles-prefetch', async (req, res) => {
      if (prefetchState.running) {
        return res.status(409).json({ error: 'Already running', prefetch: prefetchState });
      }
      const {
        provider = 'google-roadmap',
        minZoom = 11,
        maxZoom = 15,
        bbox = [-74.27, 40.49, -73.58, 40.98],
      } = req.body || {};

      if (!TILE_PROVIDERS[provider]) return res.status(400).json({ error: 'Invalid provider' });

      const [west, south, east, north] = bbox;
      const queue = [];
      for (let z = minZoom; z <= maxZoom; z++) {
        const xMin = lon2tile(west, z);
        const xMax = lon2tile(east, z);
        const yMin = lat2tile(north, z);
        const yMax = lat2tile(south, z);
        for (let x = xMin; x <= xMax; x++) {
          for (let y = yMin; y <= yMax; y++) {
            queue.push({ z, x, y });
          }
        }
      }

      prefetchState = {
        running: true,
        provider,
        total: queue.length,
        completed: 0,
        cachedHits: 0,
        downloaded: 0,
        errors: 0,
      };
      res.json({ started: true, total: queue.length, prefetch: prefetchState });

      (async () => {
        let idx = 0;
        async function worker() {
          while (idx < queue.length && prefetchState.running) {
            const cur = queue[idx++];
            try {
              const r = await fetchAndCacheTile(provider, cur.z, cur.x, cur.y);
              if (r.fromCache) prefetchState.cachedHits++;
              else prefetchState.downloaded++;
            } catch {
              prefetchState.errors++;
            }
            prefetchState.completed++;
          }
        }
        await Promise.all(Array.from({ length: 6 }, () => worker()));
        prefetchState.running = false;
      })();
    });

    serverApp.post('/api/tiles-prefetch/cancel', (_req, res) => {
      prefetchState.running = false;
      res.json({ cancelled: true, prefetch: prefetchState });
    });

    serverApp.post('/api/export/static', async (req, res) => {
      try {
        const { includeCachedOpenTiles = true } = req.body || {};
        const outDir = path.join(ROOT_DIR, 'dist-static');
        await execAsync('npx vite build --outDir dist-static', {
          cwd: ROOT_DIR,
          env: { ...process.env, VITE_STATIC_EXPORT: 'true' },
        });
        const destDataDir = path.join(outDir, 'data');
        fs.mkdirSync(destDataDir, { recursive: true });
        for (const file of [
          'walks.json',
          'borough-lines.geojson',
          'transit-subway.geojson',
          'transit-rail.geojson',
        ]) {
          const src = path.join(DATA_DIR, file);
          if (fs.existsSync(src)) fs.copyFileSync(src, path.join(destDataDir, file));
        }

        const bundledProviders = [];
        if (includeCachedOpenTiles) {
          for (const [key, info] of Object.entries(TILE_PROVIDERS)) {
            if (info.isOpenShareable) {
              const srcProviderDir = path.join(TILE_CACHE_DIR, key);
              if (fs.existsSync(srcProviderDir)) {
                fs.cpSync(srcProviderDir, path.join(outDir, 'tiles', key), { recursive: true });
                bundledProviders.push(key);
              }
            }
          }
        }

        fs.writeFileSync(
          path.join(outDir, 'data', 'static-manifest.json'),
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              staticMode: true,
              bundledOpenProviders: bundledProviders,
            },
            null,
            2
          ),
          'utf-8'
        );
        res.json({ ok: true, outputPath: outDir, bundledOpenProviders: bundledProviders });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    if (fs.existsSync(DIST_DIR)) {
      serverApp.use(express.static(DIST_DIR));
    }
    serverApp.use(express.static(path.join(ROOT_DIR, 'public')));

    const srv = serverApp.listen(PORT, '127.0.0.1', () => {
      console.log(`[Electron Embedded Express] Listening on http://127.0.0.1:${PORT}`);
      resolve();
    });

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Electron Embedded Express] Reusing existing server on port ${PORT}`);
        resolve();
      } else {
        console.error('[Electron Embedded Express] Error:', err);
        resolve();
      }
    });
  });
}

function checkUrlAlive(url, timeout = 500) {
  return new Promise((resolve) => {
    const req = http
      .get(url, (res) => {
        res.resume();
        resolve(true);
      })
      .on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
  });
}

let mainWindow = null;

async function createWindow() {
  await startEmbeddedExpressServer();

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1024,
    minHeight: 680,
    title: 'NYC Walks Map — Coverage Tracker & Route Planner',
    backgroundColor: '#090d16',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // If Vite dev server is running (npm run dev), use it for HMR; otherwise load from embedded Express server
  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const isDevRunning = await checkUrlAlive(devUrl, 450);

  if (isDevRunning) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
