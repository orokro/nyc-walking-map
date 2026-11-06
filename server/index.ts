import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generateKmzBuffer, WalkDataset } from './kmz.js';

const execAsync = promisify(exec);
const app = express();
const PORT = 3456;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'public', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const TILE_CACHE_DIR = path.join(ROOT_DIR, 'tile_cache');
const WALKS_FILE = path.join(DATA_DIR, 'walks.json');
const BOROUGHS_FILE = path.join(DATA_DIR, 'borough-lines.geojson');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(TILE_CACHE_DIR, { recursive: true });

export const TILE_PROVIDERS: Record<
  string,
  { name: string; urlTemplate: string; isOpenShareable: boolean; contentType: string }
> = {
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

// Get Walks Dataset
app.get('/api/walks', (_req, res) => {
  try {
    if (!fs.existsSync(WALKS_FILE)) {
      res.status(404).json({ error: 'walks.json not found' });
      return;
    }
    const raw = fs.readFileSync(WALKS_FILE, 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Save Walks Dataset
app.put('/api/walks', (req, res) => {
  try {
    const dataset: WalkDataset = req.body;
    if (!dataset || !Array.isArray(dataset.walks)) {
      res.status(400).json({ error: 'Invalid walk dataset payload' });
      return;
    }
    dataset.updatedAt = new Date().toISOString();

    // Keep rolling backups (up to 15 recent backups)
    if (fs.existsSync(WALKS_FILE)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = path.join(BACKUP_DIR, `walks-${stamp}.json`);
      fs.copyFileSync(WALKS_FILE, backupFile);
      const backups = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith('walks-'))
        .sort();
      while (backups.length > 15) {
        const oldest = backups.shift()!;
        fs.unlinkSync(path.join(BACKUP_DIR, oldest));
      }
    }

    fs.writeFileSync(WALKS_FILE, JSON.stringify(dataset, null, 2), 'utf-8');
    res.json({ ok: true, updatedAt: dataset.updatedAt, count: dataset.walks.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Export KMZ for Google My Maps
app.get('/api/export/kmz', async (_req, res) => {
  try {
    const dataset: WalkDataset = JSON.parse(fs.readFileSync(WALKS_FILE, 'utf-8'));
    const boroughs = fs.existsSync(BOROUGHS_FILE)
      ? JSON.parse(fs.readFileSync(BOROUGHS_FILE, 'utf-8'))
      : null;

    const kmzBuffer = await generateKmzBuffer(dataset, boroughs);
    res.setHeader('Content-Type', 'application/vnd.google-earth.kmz');
    res.setHeader('Content-Disposition', 'attachment; filename="Walks.kmz"');
    res.send(kmzBuffer);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to fetch and cache a single tile
async function fetchAndCacheTile(
  providerKey: string,
  z: string | number,
  x: string | number,
  y: string | number
): Promise<{ buffer: Buffer; contentType: string; fromCache: boolean }> {
  const provider = TILE_PROVIDERS[providerKey];
  if (!provider) {
    throw new Error(`Unknown tile provider: ${providerKey}`);
  }

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

  if (!response.ok) {
    throw new Error(`Upstream tile error ${response.status}`);
  }

  const arrayBuf = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);

  await fs.promises.mkdir(path.dirname(tilePath), { recursive: true });
  await fs.promises.writeFile(tilePath, buffer);

  return { buffer, contentType: provider.contentType, fromCache: false };
}

// Local Caching Tile Proxy Endpoint
app.get('/api/tiles/:provider/:z/:x/:y', async (req, res) => {
  try {
    const { provider, z, x, y } = req.params;
    const cleanY = y.replace(/\.(png|jpg|jpeg|webp)$/i, '');
    const result = await fetchAndCacheTile(provider, z, x, cleanY);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Tile-Cache', result.fromCache ? 'HIT' : 'MISS');
    res.send(result.buffer);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

// Count cached tiles per provider
function countFilesRecursive(dir: string): { count: number; bytes: number } {
  if (!fs.existsSync(dir)) return { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
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

// Background Prefetch Job State
let prefetchState = {
  running: false,
  provider: '',
  total: 0,
  completed: 0,
  cachedHits: 0,
  downloaded: 0,
  errors: 0,
};

function lon2tile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function lat2tile(lat: number, zoom: number): number {
  return Math.floor(
    ((1 -
      Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) /
      2) *
      Math.pow(2, zoom)
  );
}

app.get('/api/tiles-status', (_req, res) => {
  const stats: Record<string, { count: number; sizeMB: number }> = {};
  for (const key of Object.keys(TILE_PROVIDERS)) {
    const { count, bytes } = countFilesRecursive(path.join(TILE_CACHE_DIR, key));
    stats[key] = { count, sizeMB: Number((bytes / (1024 * 1024)).toFixed(2)) };
  }
  res.json({ providers: stats, prefetch: prefetchState });
});

app.post('/api/tiles-prefetch', async (req, res) => {
  if (prefetchState.running) {
    res.status(409).json({ error: 'A tile prefetch job is already running', prefetch: prefetchState });
    return;
  }

  const {
    provider = 'google-roadmap',
    minZoom = 11,
    maxZoom = 15,
    // Default bbox covers NYC 5 Boroughs + Rye/Westchester + Western Nassau:
    bbox = [-74.27, 40.49, -73.58, 40.98],
  } = req.body || {};

  if (!TILE_PROVIDERS[provider]) {
    res.status(400).json({ error: 'Invalid provider' });
    return;
  }

  const [west, south, east, north] = bbox;
  const queue: { z: number; x: number; y: number }[] = [];

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

  // Run worker pool asynchronously
  (async () => {
    const concurrency = 6;
    let idx = 0;

    async function worker() {
      while (idx < queue.length && prefetchState.running) {
        const current = queue[idx++];
        try {
          const result = await fetchAndCacheTile(provider, current.z, current.x, current.y);
          if (result.fromCache) {
            prefetchState.cachedHits++;
          } else {
            prefetchState.downloaded++;
          }
        } catch {
          prefetchState.errors++;
        }
        prefetchState.completed++;
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    prefetchState.running = false;
  })();
});

app.post('/api/tiles-prefetch/cancel', (_req, res) => {
  prefetchState.running = false;
  res.json({ cancelled: true, prefetch: prefetchState });
});

// Build Standalone Static Website into dist-static/
app.post('/api/export/static', async (req, res) => {
  try {
    const { includeCachedOpenTiles = true } = req.body || {};
    const outDir = path.join(ROOT_DIR, 'dist-static');

    // Run Vite build targeting dist-static with VITE_STATIC_EXPORT=true
    await execAsync('npx vite build --outDir dist-static', {
      cwd: ROOT_DIR,
      env: { ...process.env, VITE_STATIC_EXPORT: 'true' },
    });

    // Ensure latest walks.json and geojson files are copied into dist-static/data
    const destDataDir = path.join(outDir, 'data');
    fs.mkdirSync(destDataDir, { recursive: true });
    for (const file of [
      'walks.json',
      'borough-lines.geojson',
      'transit-subway.geojson',
      'transit-rail.geojson',
    ]) {
      const src = path.join(DATA_DIR, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(destDataDir, file));
      }
    }

    // Optionally copy open shareable tile caches into dist-static/tiles/
    const bundledProviders: string[] = [];
    if (includeCachedOpenTiles) {
      for (const [key, info] of Object.entries(TILE_PROVIDERS)) {
        if (info.isOpenShareable) {
          const srcProviderDir = path.join(TILE_CACHE_DIR, key);
          if (fs.existsSync(srcProviderDir)) {
            const destProviderDir = path.join(outDir, 'tiles', key);
            fs.cpSync(srcProviderDir, destProviderDir, { recursive: true });
            bundledProviders.push(key);
          }
        }
      }
    }

    // Write static manifest so the static frontend knows which local tile folders are bundled
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

    res.json({
      ok: true,
      outputPath: outDir,
      bundledOpenProviders: bundledProviders,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[NYC Walks Server] Listening on http://127.0.0.1:${PORT}`);
});
