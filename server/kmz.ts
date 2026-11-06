import JSZip from 'jszip';

export interface WalkItem {
  id: string;
  title: string;
  date: string;
  year: string;
  status: 'completed' | 'planned';
  isSubwayWalk: boolean;
  manualLayerId: string;
  originalFolder?: string;
  originalColor?: string;
  styleOverride?: {
    color?: string;
    width?: number;
  };
  distanceMiles: number;
  notes: string;
  coordinates: [number, number][];
}

export interface WalkSettings {
  completedWalkColor: string;
  completedWalkWidth: number;
  completedWalkOpacity: number;
  subwayWalkColor: string;
  subwayWalkWidth: number;
  subwayWalkOpacity: number;
  plannedWalkColor: string;
  plannedWalkWidth: number;
  boroughLineColor: string;
  boroughLineWidth: number;
  showBoroughLines: boolean;
  showSubwayLines: boolean;
  showCommuterRail: boolean;
  colorMode: 'uniform' | 'year';
}

export interface ManualLayer {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

export interface WalkDataset {
  version: number;
  updatedAt: string;
  settings: WalkSettings;
  manualLayers: ManualLayer[];
  walks: WalkItem[];
}

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

export async function generateKmzBuffer(
  dataset: WalkDataset,
  boroughGeoJson?: any
): Promise<Buffer> {
  // Google My Maps has a 10-folder limit.
  // We group walks into:
  // 1. Borough Lines
  // 2. Subway Walks
  // 3. Year folders (grouping 2020/2021 together as My Maps did, plus each year, and condensing oldest if > 10 folders)
  // 4. To Walk (Planned)
  const foldersMap = new Map<string, { name: string; placemarks: string[] }>();

  const ensureFolder = (name: string) => {
    if (!foldersMap.has(name)) {
      foldersMap.set(name, { name, placemarks: [] });
    }
    return foldersMap.get(name)!;
  };

  // Style Registry
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

  // 1. Borough Lines
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

  // 2. Walks
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

  // Build styles XML
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
      <BalloonStyle>
        <text><![CDATA[<h3>$[name]</h3>]]></text>
      </BalloonStyle>
    </Style>
    <Style id="${st.id}-highlight">
      <LineStyle>
        <color>${kmlColor}</color>
        <width>${hiWidth}</width>
      </LineStyle>
      <BalloonStyle>
        <text><![CDATA[<h3>$[name]</h3>]]></text>
      </BalloonStyle>
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

  // Build folders XML
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
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}
