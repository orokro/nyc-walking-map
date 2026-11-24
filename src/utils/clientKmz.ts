import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { WalkDataset, WalkItem } from '../types/walks';
import { computeLineMiles } from './geo';

function hexToKmlColor(hex: string, alphaHex = 'ff'): string {
  const clean = (hex || '#0288D1').replace('#', '').trim();
  if (clean.length !== 6) return 'ffd18802';
  const rr = clean.substring(0, 2).toLowerCase();
  const gg = clean.substring(2, 4).toLowerCase();
  const bb = clean.substring(4, 6).toLowerCase();
  return `${alphaHex}${bb}${gg}${rr}`;
}

function escapeXml(str: string): string {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function getMyMapsFolderName(walk: WalkItem, dataset?: WalkDataset): string {
  if (walk.isSubwayWalk) return 'Subway Walks';
  if (walk.status === 'planned') {
    if (walk.manualLayerId === 'other' || walk.originalFolder === 'Other') return 'Other';
    return 'To Walk';
  }
  if (walk.manualLayerId && dataset) {
    const ml = dataset.manualLayers.find((l) => l.id === walk.manualLayerId);
    if (ml) return ml.name;
  }
  const yr = walk.date ? walk.date.substring(0, 4) : walk.year || '2026';
  return yr === '2020' || yr === '2021' ? '2020 / 2021' : yr;
}

export function formatMyMapsPlacemarkName(walk: WalkItem): string {
  const title = (walk.title || 'Untitled Walk').trim();
  if (!walk.date) return title;
  if (title.startsWith(walk.date)) return title;
  return `${walk.date} ${title}`;
}

export interface MyMapsExportOptions {
  format?: 'kml' | 'kmz';
  styleMode?: 'mymaps-standard' | 'app-custom';
  includeBoroughLines?: boolean;
  boroughGeoJson?: any;
  documentName?: string;
}

export function buildKmlForWalks(
  walksToExport: WalkItem[],
  dataset: WalkDataset,
  options: MyMapsExportOptions = {}
): string {
  const styleMode = options.styleMode || 'mymaps-standard';
  const foldersMap = new Map<string, { name: string; placemarks: string[] }>();
  const ensureFolder = (name: string) => {
    if (!foldersMap.has(name)) {
      foldersMap.set(name, { name, placemarks: [] });
    }
    return foldersMap.get(name)!;
  };

  const styleSet = new Map<
    string,
    { id: string; colorHex: string; width: number; hasDesc: boolean }
  >();
  const registerStyle = (colorHex: string, width: number, hasDesc: boolean) => {
    const cleanHex = (colorHex || '#0288D1').replace('#', '').toUpperCase();
    const wInt = Math.round(width * 1000);
    const suffix = hasDesc ? '' : '-nodesc';
    const id = `line-${cleanHex}-${wInt}${suffix}`;
    if (!styleSet.has(id)) {
      styleSet.set(id, { id, colorHex: `#${cleanHex}`, width, hasDesc });
    }
    return id;
  };

  const boroughGeoJson = options.boroughGeoJson;
  if (options.includeBoroughLines && boroughGeoJson && Array.isArray(boroughGeoJson.features)) {
    const bFolder = ensureFolder('Borough LInes');
    const styleId = registerStyle(
      dataset.settings.boroughLineColor || '#E65100',
      dataset.settings.boroughLineWidth || 3.131,
      false
    );
    for (const feat of boroughGeoJson.features) {
      const name = feat.properties?.name || 'Borough';
      const coords: [number, number][] = feat.geometry?.coordinates || [];
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

  for (const walk of walksToExport) {
    const folderName = getMyMapsFolderName(walk, dataset);
    let colorHex = '#0288D1';
    let width = 3.131;

    if (styleMode === 'mymaps-standard') {
      if (walk.isSubwayWalk) {
        colorHex = '#0097A7';
        width = 3.131;
      } else if (folderName === 'Other') {
        colorHex = '#000000';
        width = 1.2;
      } else {
        // Both completed year folders (2020..2026) and 'To Walk' use Google My Maps #0288D1 blue in Walks.kmz
        colorHex = walk.originalColor || '#0288D1';
        width = 3.131;
      }
    } else {
      colorHex = dataset.settings.completedWalkColor || '#0288D1';
      width = dataset.settings.completedWalkWidth || 3.131;
      if (walk.isSubwayWalk) {
        colorHex = dataset.settings.subwayWalkColor || '#0097A7';
        width = dataset.settings.subwayWalkWidth || 3.131;
      } else if (walk.status === 'planned') {
        colorHex =
          folderName === 'Other'
            ? '#000000'
            : dataset.settings.plannedWalkColor || '#0288D1';
        width = folderName === 'Other' ? 1.2 : dataset.settings.plannedWalkWidth || 3.131;
      }
      if (walk.styleOverride?.color) colorHex = walk.styleOverride.color;
      if (walk.styleOverride?.width) width = walk.styleOverride.width;
    }

    const hasDesc = Boolean(walk.notes && walk.notes.trim());
    const styleId = registerStyle(colorHex, width, hasDesc);
    const folder = ensureFolder(folderName);
    const displayName = formatMyMapsPlacemarkName(walk);
    const coordStr = walk.coordinates.map((c) => `${c[0]},${c[1]},0`).join('\n            ');
    const descXml = hasDesc ? `\n        <description>${escapeXml(walk.notes)}</description>` : '';

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

  const stylesXml: string[] = [];
  for (const st of styleSet.values()) {
    const kmlColor = hexToKmlColor(st.colorHex, 'ff');
    const normWidth = Number(st.width.toFixed(3));
    const hiWidth = Number((st.width * 1.5).toFixed(3));
    const balloonXml = st.hasDesc
      ? ''
      : `\n      <BalloonStyle>\n        <text><![CDATA[<h3>$[name]</h3>]]></text>\n      </BalloonStyle>`;
    stylesXml.push(`    <Style id="${st.id}-normal">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>${normWidth}</width>
      </LineStyle>${balloonXml}
    </Style>
    <Style id="${st.id}-highlight">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>${hiWidth}</width>
      </LineStyle>${balloonXml}
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

  const foldersXml: string[] = [];
  for (const folder of foldersMap.values()) {
    if (folder.placemarks.length === 0) continue;
    foldersXml.push(`    <Folder>
      <name>${escapeXml(folder.name)}</name>
${folder.placemarks.join('\n')}
    </Folder>`);
  }

  const docName = options.documentName || 'Walks';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(docName)}</name>
    <description/>
${stylesXml.join('\n')}
${foldersXml.join('\n')}
  </Document>
</kml>`;
}

export async function exportDatasetToKmzBlob(
  dataset: WalkDataset,
  boroughGeoJson?: any
): Promise<Blob> {
  const kmlContent = buildKmlForWalks(dataset.walks, dataset, {
    styleMode: 'mymaps-standard',
    includeBoroughLines: true,
    boroughGeoJson,
    documentName: 'Walks',
  });
  const zip = new JSZip();
  zip.file('doc.kml', kmlContent);
  return await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

export async function downloadWalksForMyMaps(
  walksToExport: WalkItem[],
  dataset: WalkDataset,
  options: MyMapsExportOptions = {}
): Promise<void> {
  if (!walksToExport || walksToExport.length === 0) return;
  const format = options.format || 'kml';
  const kmlContent = buildKmlForWalks(walksToExport, dataset, options);

  let baseFilename = 'Walks-MyMaps-Merge';
  if (walksToExport.length === 1) {
    const w = walksToExport[0];
    const raw = formatMyMapsPlacemarkName(w)
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_|_$/g, '');
    baseFilename = raw || 'Walk';
  } else {
    const folders = Array.from(
      new Set(walksToExport.map((w) => getMyMapsFolderName(w, dataset)))
    );
    if (folders.length === 1) {
      const fClean = folders[0].replace(/[^a-zA-Z0-9_-]+/g, '_');
      baseFilename = `MyMaps_${fClean}_${walksToExport.length}_walks`;
    } else {
      baseFilename = `MyMaps_Merge_${walksToExport.length}_walks`;
    }
  }

  let blob: Blob;
  if (format === 'kmz') {
    const zip = new JSZip();
    zip.file('doc.kml', kmlContent);
    blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
  } else {
    blob = new Blob([kmlContent], {
      type: 'application/vnd.google-earth.kml+xml;charset=utf-8',
    });
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseFilename}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function parseKmzFileToWalks(file: File): Promise<WalkItem[]> {
  let kmlText = '';
  if (file.name.toLowerCase().endsWith('.kmz')) {
    const zip = await JSZip.loadAsync(file);
    const kmlEntry = zip.file(/\.kml$/i)[0];
    if (!kmlEntry) throw new Error('No .kml file found inside KMZ archive');
    kmlText = await kmlEntry.async('string');
  } else {
    kmlText = await file.text();
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });
  const parsed = parser.parse(kmlText);
  const doc = parsed?.kml?.Document || parsed?.Document;
  if (!doc) throw new Error('Invalid KML structure');

  const folders = Array.isArray(doc.Folder) ? doc.Folder : doc.Folder ? [doc.Folder] : [doc];
  const walks: WalkItem[] = [];
  let idx = 1;

  for (const folder of folders) {
    const folderName = String(folder.name || 'Imported').trim();
    if (folderName.toLowerCase() === 'borough lines') continue;

    const pms = Array.isArray(folder.Placemark)
      ? folder.Placemark
      : folder.Placemark
      ? [folder.Placemark]
      : [];

    for (const pm of pms) {
      const rawName = String(pm.name || 'Untitled').trim();
      const coordRaw = pm?.LineString?.coordinates;
      if (!coordRaw) continue;
      const coords: [number, number][] = [];
      for (const token of String(coordRaw).trim().split(/\s+/)) {
        const parts = token.split(',');
        if (parts.length >= 2) {
          const lon = Number(Number(parts[0]).toFixed(6));
          const lat = Number(Number(parts[1]).toFixed(6));
          if (!isNaN(lon) && !isNaN(lat)) coords.push([lon, lat]);
        }
      }
      if (coords.length < 2) continue;

      const m = rawName.match(/^(\d{2,4})[-_](\d{1,2})[-_](\d{1,2})\s*(.*)$/);
      let isoDate = '';
      let title = rawName;
      let yearStr = '2026';

      if (m) {
        let yr = parseInt(m[1], 10);
        if (yr < 100) yr += 2000;
        const mo = String(parseInt(m[2], 10)).padStart(2, '0');
        const da = String(parseInt(m[3], 10)).padStart(2, '0');
        isoDate = `${yr}-${mo}-${da}`;
        title = m[4].replace(/^[-_:\s]+/, '').trim() || `Walk on ${isoDate}`;
        yearStr = String(yr);
      }

      const isSubway = folderName === 'Subway Walks';
      const isPlanned = folderName === 'To Walk' || folderName === 'Other';

      walks.push({
        id: `walk-imp-${Date.now()}-${idx++}`,
        title,
        date: isoDate,
        year: yearStr,
        status: isPlanned ? 'planned' : 'completed',
        isSubwayWalk: isSubway,
        manualLayerId: folderName === 'Other' ? 'other' : '',
        originalFolder: folderName,
        distanceMiles: computeLineMiles(coords),
        notes: String(pm.description || '').trim(),
        coordinates: coords,
      });
    }
  }
  return walks;
}
