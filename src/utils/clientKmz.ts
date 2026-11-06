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

export async function exportDatasetToKmzBlob(
  dataset: WalkDataset,
  boroughGeoJson?: any
): Promise<Blob> {
  const foldersMap = new Map<string, { name: string; placemarks: string[] }>();
  const ensureFolder = (name: string) => {
    if (!foldersMap.has(name)) {
      foldersMap.set(name, { name, placemarks: [] });
    }
    return foldersMap.get(name)!;
  };

  const styleSet = new Map<string, { id: string; colorHex: string; width: number }>();
  const registerStyle = (colorHex: string, width: number) => {
    const cleanHex = (colorHex || '#0288D1').replace('#', '').toUpperCase();
    const wInt = Math.round(width * 1000);
    const id = `line-${cleanHex}-${wInt}-nodesc`;
    if (!styleSet.has(id)) {
      styleSet.set(id, { id, colorHex: `#${cleanHex}`, width });
    }
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

  const stylesXml: string[] = [];
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

  const foldersXml: string[] = [];
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
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
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
