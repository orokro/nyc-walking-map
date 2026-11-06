import fs from 'fs';
import path from 'path';

const ROOT_DIR = process.cwd();
const outDir = path.join(ROOT_DIR, 'dist-static');
const tileCacheDir = path.join(ROOT_DIR, 'tile_cache');

const openProviders = ['carto-voyager', 'carto-light', 'carto-dark', 'osm', 'esri-sat'];
const bundledProviders = [];

for (const key of openProviders) {
  const src = path.join(tileCacheDir, key);
  if (fs.existsSync(src)) {
    const dest = path.join(outDir, 'tiles', key);
    fs.cpSync(src, dest, { recursive: true });
    bundledProviders.push(key);
  }
}

fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
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

console.log(`Static build finalized at ${outDir} (bundled tile sets: ${bundledProviders.join(', ') || 'none - using live open CDNs + OpenFreeMap vector'})`);
