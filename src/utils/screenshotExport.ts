import { jsPDF } from 'jspdf';
import * as maplibregl from 'maplibre-gl';
import { ViewportFrameConfig } from '../components/MapCanvas';

export async function exportMapScreenshot(
  map: maplibregl.Map,
  format: 'png' | 'pdf',
  frameConfig: ViewportFrameConfig,
  bannerText: { title: string; subtitle: string; milesText: string }
): Promise<void> {
  // Wait for a render frame so WebGL buffer is fresh
  await new Promise<void>((resolve) => {
    map.once('render', () => resolve());
    map.triggerRepaint();
  });

  const srcCanvas = map.getCanvas();
  const fullW = srcCanvas.width;
  const fullH = srcCanvas.height;

  let cropW = fullW;
  let cropH = fullH;

  if (frameConfig.enabled) {
    let targetRatio = 9 / 16;
    if (frameConfig.aspect === 'phone-tall') targetRatio = 9 / 19.5;
    else if (frameConfig.aspect === 'square') targetRatio = 1;
    else if (frameConfig.aspect === 'landscape') targetRatio = 16 / 9;

    const maxH = fullH * 0.86;
    const maxW = fullW * 0.86;
    if (maxW / maxH > targetRatio) {
      cropH = Math.round(maxH);
      cropW = Math.round(cropH * targetRatio);
    } else {
      cropW = Math.round(maxW);
      cropH = Math.round(cropW / targetRatio);
    }
  }

  const cropX = Math.round((fullW - cropW) / 2);
  const cropY = Math.round((fullH - cropH) / 2);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = cropW;
  outCanvas.height = cropH;
  const ctx = outCanvas.getContext('2d')!;

  ctx.drawImage(srcCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Optional header banner for phone reference screenshot
  if (frameConfig.includeBanner) {
    const bannerH = Math.max(54, Math.round(cropH * 0.065));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(0, 0, cropW, bannerH);

    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(0, bannerH - 3, cropW, 3);

    const fontSize = Math.max(16, Math.round(bannerH * 0.36));
    ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = '#f8fafc';
    ctx.textBaseline = 'middle';
    ctx.fillText(bannerText.title || 'NYC Walk Route', 20, bannerH / 2);

    if (bannerText.milesText) {
      const mWidth = ctx.measureText(bannerText.milesText).width;
      ctx.fillStyle = '#facc15';
      ctx.fillText(bannerText.milesText, cropW - mWidth - 20, bannerH / 2);
    }
  }

  const safeSlug = (bannerText.title || 'nyc-walk')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (format === 'png') {
    const dataUrl = outCanvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${safeSlug || 'nyc-walk'}-map.png`;
    a.click();
  } else {
    const imgData = outCanvas.toDataURL('image/jpeg', 0.95);
    const orientation = cropW > cropH ? 'l' : 'p';
    const pdf = new jsPDF({
      orientation,
      unit: 'px',
      format: [cropW, cropH],
    });
    pdf.addImage(imgData, 'JPEG', 0, 0, cropW, cropH);
    pdf.save(`${safeSlug || 'nyc-walk'}-map.pdf`);
  }
}
