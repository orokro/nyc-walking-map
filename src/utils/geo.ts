import * as turf from '@turf/turf';
import { WalkItem, WalkSettings, ManualLayer, YEAR_PALETTE } from '../types/walks';

export function computeLineMiles(coords: [number, number][]): number {
  if (!coords || coords.length < 2) return 0;
  try {
    const line = turf.lineString(coords);
    const len = turf.length(line, { units: 'miles' });
    return Number(len.toFixed(2));
  } catch {
    return 0;
  }
}

export function getAutoYearGroup(walk: WalkItem): string {
  if (walk.date && walk.date.length >= 4) {
    const yr = walk.date.substring(0, 4);
    if (yr === '2020' || yr === '2021') return '2020 / 2021';
    return yr;
  }
  if (walk.year === '2020' || walk.year === '2021') return '2020 / 2021';
  return walk.year || '2026';
}

export function resolveWalkColor(
  walk: WalkItem,
  settings: WalkSettings,
  manualLayers: ManualLayer[]
): string {
  if (walk.styleOverride?.color) return walk.styleOverride.color;
  if (walk.status === 'planned') return settings.plannedWalkColor || '#FF6D00';
  if (walk.isSubwayWalk) return settings.subwayWalkColor || '#0097A7';
  if (walk.manualLayerId) {
    const ml = manualLayers.find((l) => l.id === walk.manualLayerId);
    if (ml) return ml.color;
  }
  if (settings.colorMode === 'year') {
    const yg = getAutoYearGroup(walk);
    return YEAR_PALETTE[yg] || settings.completedWalkColor || '#0288D1';
  }
  return settings.completedWalkColor || '#0288D1';
}

export function resolveWalkWidth(walk: WalkItem, settings: WalkSettings): number {
  if (walk.styleOverride?.width !== undefined) return walk.styleOverride.width;
  if (walk.status === 'planned') return settings.plannedWalkWidth ?? 3.5;
  if (walk.isSubwayWalk) return settings.subwayWalkWidth ?? 3.2;
  return settings.completedWalkWidth ?? 3.2;
}

export interface ResolvedWalkStyle {
  color: string;
  width: number;
  showBorder: boolean;
  borderColor: string;
  borderWidth: number;
  showDashes: boolean;
  showTicks: boolean;
  showSelectionGlow: boolean;
  gradientEnabled: boolean;
  gradientStartColor: string;
  gradientEndColor: string;
  gradientRepeats: number;
  hasCustomOverride: boolean;
}

export function resolveEffectiveWalkStyle(
  walk: WalkItem,
  settings: WalkSettings,
  manualLayers: ManualLayer[]
): ResolvedWalkStyle {
  const ov = walk.styleOverride || {};
  const isPlanned = walk.status === 'planned';
  const baseColor = resolveWalkColor(walk, settings, manualLayers);
  const width = resolveWalkWidth(walk, settings);

  const showBorder =
    ov.showBorder !== undefined
      ? ov.showBorder
      : isPlanned
      ? settings.plannedShowBorder ?? true
      : true;

  const borderColor =
    ov.borderColor || (isPlanned ? settings.plannedBorderColor || '#111827' : '#0f172a');

  const borderWidth =
    ov.borderWidth !== undefined
      ? ov.borderWidth
      : isPlanned
      ? settings.plannedBorderWidth ?? 3.0
      : 1.4;

  const showDashes =
    ov.showDashes !== undefined
      ? ov.showDashes
      : isPlanned
      ? settings.plannedShowDashes ?? true
      : false;

  const showTicks =
    ov.showTicks !== undefined
      ? ov.showTicks
      : isPlanned
      ? settings.plannedShowTicks ?? true
      : false;

  const gradientEnabled =
    ov.gradientEnabled !== undefined
      ? ov.gradientEnabled
      : isPlanned
      ? settings.plannedGradientEnabled ?? false
      : false;

  const gradientStartColor =
    ov.gradientStartColor ||
    (isPlanned ? settings.plannedGradientStartColor || baseColor : baseColor);

  const gradientEndColor =
    ov.gradientEndColor ||
    (isPlanned ? settings.plannedGradientEndColor || '#00E5FF' : '#00E5FF');

  const gradientRepeats = Math.max(
    1,
    Math.round(
      ov.gradientRepeats !== undefined
        ? ov.gradientRepeats
        : isPlanned
        ? settings.plannedGradientRepeats ?? 1
        : 1
    )
  );

  const hasCustomOverride =
    ov.width !== undefined ||
    ov.color !== undefined ||
    ov.showBorder !== undefined ||
    ov.showDashes !== undefined ||
    ov.showTicks !== undefined ||
    ov.gradientEnabled !== undefined;

  const showSelectionGlow =
    ov.showSelectionGlow !== undefined
      ? ov.showSelectionGlow
      : !isPlanned && !gradientEnabled && showBorder;

  return {
    color: baseColor,
    width,
    showBorder,
    borderColor,
    borderWidth,
    showDashes,
    showTicks,
    showSelectionGlow,
    gradientEnabled,
    gradientStartColor,
    gradientEndColor,
    gradientRepeats,
    hasCustomOverride,
  };
}

/**
 * Evaluates a smooth 2-color gradient with repeating alternating stops (ping-pong)
 * so there is never a hard color switch at repeat boundaries.
 * - repeats = 1: Start (A) -> End (B)
 * - repeats = 2: A -> B -> A
 * - repeats = 3: A -> B -> A -> B
 */
export function evaluatePingPongGradient(
  colorA: string,
  colorB: string,
  t: number,
  repeats = 1
): string {
  const r = Math.max(1, Math.round(repeats));
  const clamped = Math.max(0, Math.min(1, t));
  if (clamped >= 1) {
    return r % 2 === 1 ? colorB : colorA;
  }
  const scaled = clamped * r;
  const seg = Math.floor(scaled);
  const frac = scaled - seg;
  const localT = seg % 2 === 0 ? frac : 1 - frac;
  return interpolateHexColor(colorA, colorB, localT);
}

/**
 * Builds a CSS linear-gradient string matching evaluatePingPongGradient stops.
 */
export function buildCssPingPongGradient(
  colorA: string,
  colorB: string,
  repeats = 1
): string {
  const r = Math.max(1, Math.round(repeats));
  const stops: string[] = [];
  for (let i = 0; i <= r; i++) {
    const pct = Number(((i / r) * 100).toFixed(2));
    const col = i % 2 === 0 ? colorA : colorB;
    stops.push(`${col} ${pct}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/**
 * Subdivides a walk's coordinate array into smooth contiguous LineString features
 * colored along a ping-pong gradient from start to end while preserving all original vertices.
 */
export function buildGradientLineFeatures(
  coords: [number, number][],
  colorA: string,
  colorB: string,
  repeats: number,
  baseProps: Record<string, any>,
  maxProgress = 1
): GeoJSON.Feature[] {
  if (!coords || coords.length < 2) return [];

  const cosLat = Math.cos(((coords[0][1] || 40.73) * Math.PI) / 180);
  const segLengths: number[] = [];
  let totalLen = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const dx = (coords[i + 1][0] - coords[i][0]) * cosLat;
    const dy = coords[i + 1][1] - coords[i][1];
    const len = Math.hypot(dx, dy);
    segLengths.push(len);
    totalLen += len;
  }

  if (totalLen <= 1e-9) {
    return [
      {
        type: 'Feature',
        properties: { ...baseProps, color: colorA },
        geometry: { type: 'LineString', coordinates: coords },
      },
    ];
  }

  const r = Math.max(1, Math.round(repeats));
  const targetSteps = Math.min(240, Math.max(75, r * 48));
  const stepLen = totalLen / targetSteps;

  const features: GeoJSON.Feature[] = [];
  let currentPoints: [number, number][] = [coords[0]];
  let chunkStartDist = 0;
  let accumDist = 0;

  const flushChunk = (endDist: number, lastPt: [number, number]) => {
    if (currentPoints.length < 2) return;
    const midDist = (chunkStartDist + endDist) * 0.5;
    const normT = (midDist / totalLen) * Math.max(0, Math.min(1, maxProgress));
    const segColor = evaluatePingPongGradient(colorA, colorB, normT, r);
    features.push({
      type: 'Feature',
      properties: {
        ...baseProps,
        color: segColor,
      },
      geometry: {
        type: 'LineString',
        coordinates: currentPoints,
      },
    });
    currentPoints = [lastPt];
    chunkStartDist = endDist;
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const segLen = segLengths[i];
    if (segLen <= 1e-10) continue;

    // If this single vertex-to-vertex segment is longer than stepLen, subdivide it
    const subCount = Math.max(1, Math.ceil(segLen / stepLen));
    for (let s = 1; s <= subCount; s++) {
      const frac = s / subCount;
      const pt: [number, number] =
        s === subCount
          ? p1
          : [
              Number((p0[0] + (p1[0] - p0[0]) * frac).toFixed(6)),
              Number((p0[1] + (p1[1] - p0[1]) * frac).toFixed(6)),
            ];
      currentPoints.push(pt);
      const d = accumDist + segLen * frac;
      if (d - chunkStartDist >= stepLen * 0.92) {
        flushChunk(d, pt);
      }
    }
    accumDist += segLen;
  }

  if (currentPoints.length >= 2) {
    flushChunk(totalLen, coords[coords.length - 1]);
  }

  return features;
}

export interface PlannedWalkRenderInput {
  id: string;
  title: string;
  coordinates: [number, number][];
  color: string;
  width: number;
  showBorder: boolean;
  borderColor: string;
  borderWidth: number;
  showDashes: boolean;
  showTicks: boolean;
  gradientEnabled: boolean;
  gradientStartColor: string;
  gradientEndColor: string;
  gradientRepeats: number;
  animProgress?: number;
}

/**
 * Generates Google Maps Measure-Tool style graduated tick marks (every 0.25 mi),
 * Mile Marker label points (every 1.0 mi + Start + End total badge),
 * plus customizable border, dashes, thickness, and smooth gradient segments
 * for all visible Planned walks and/or the active draft route.
 */
export function generatePlannedMeasureOverlays(
  plannedWalks: PlannedWalkRenderInput[]
): {
  hitGeoJSON: GeoJSON.FeatureCollection;
  casingGeoJSON: GeoJSON.FeatureCollection;
  linesGeoJSON: GeoJSON.FeatureCollection;
  dashesGeoJSON: GeoJSON.FeatureCollection;
  ticksGeoJSON: GeoJSON.FeatureCollection;
  markersGeoJSON: GeoJSON.FeatureCollection;
} {
  const hitFeatures: GeoJSON.Feature[] = [];
  const casingFeatures: GeoJSON.Feature[] = [];
  const lineFeatures: GeoJSON.Feature[] = [];
  const dashFeatures: GeoJSON.Feature[] = [];
  const tickFeatures: GeoJSON.Feature[] = [];
  const markerFeatures: GeoJSON.Feature[] = [];

  for (const walk of plannedWalks) {
    const coords = walk.coordinates;
    if (!coords || coords.length < 2) continue;

    const width = walk.width ?? 3.5;
    const borderExtra = walk.borderWidth ?? 3.0;
    const baseProps = {
      id: walk.id,
      title: walk.title,
      color: walk.color || '#FF6D00',
      width,
      borderColor: walk.borderColor || '#111827',
      casingWidth: width + borderExtra,
      dashWidth: Number(Math.max(1.2, width * 0.56).toFixed(2)),
    };

    const fullLine = turf.lineString(coords, baseProps);
    hitFeatures.push(fullLine);

    if (walk.showBorder !== false) {
      casingFeatures.push(fullLine);
    }

    if (walk.gradientEnabled) {
      const gradSegments = buildGradientLineFeatures(
        coords,
        walk.gradientStartColor || walk.color || '#FF6D00',
        walk.gradientEndColor || '#00E5FF',
        walk.gradientRepeats || 1,
        baseProps,
        walk.animProgress ?? 1
      );
      lineFeatures.push(...gradSegments);
    } else {
      lineFeatures.push(fullLine);
    }

    if (walk.showDashes !== false) {
      dashFeatures.push(fullLine);
    }

    if (walk.showTicks === false) {
      continue;
    }

    const totalMiles = turf.length(fullLine, { units: 'miles' });

    // Start marker (0 mi)
    markerFeatures.push({
      type: 'Feature',
      properties: {
        walkId: walk.id,
        label: 'START',
        mile: 0,
        kind: 'start',
      },
      geometry: {
        type: 'Point',
        coordinates: coords[0],
      },
    });

    // Step every 0.25 miles along the route for graduation ticks & 1.0-mile badges
    const stepMiles = 0.25;
    const epsilon = 0.01;
    for (let dist = stepMiles; dist < totalMiles - 0.04; dist += stepMiles) {
      const isMajorMile = Math.abs(dist - Math.round(dist)) < 0.001;
      const pt = turf.along(fullLine, dist, { units: 'miles' });
      const ptBefore = turf.along(fullLine, Math.max(0, dist - epsilon), { units: 'miles' });
      const ptAfter = turf.along(fullLine, Math.min(totalMiles, dist + epsilon), { units: 'miles' });
      const bearing = turf.bearing(ptBefore, ptAfter);

      // Perpendicular tick line
      const tickHalfLenMiles = isMajorMile ? 0.032 : 0.018;
      const leftPt = turf.destination(pt, tickHalfLenMiles, bearing - 90, { units: 'miles' });
      const rightPt = turf.destination(pt, tickHalfLenMiles, bearing + 90, { units: 'miles' });

      tickFeatures.push({
        type: 'Feature',
        properties: {
          walkId: walk.id,
          mile: Number(dist.toFixed(2)),
          major: isMajorMile ? 1 : 0,
        },
        geometry: {
          type: 'LineString',
          coordinates: [leftPt.geometry.coordinates, rightPt.geometry.coordinates],
        },
      });

      if (isMajorMile) {
        const mileInt = Math.round(dist);
        markerFeatures.push({
          type: 'Feature',
          properties: {
            walkId: walk.id,
            label: `${mileInt} mi`,
            mile: mileInt,
            kind: 'mile',
          },
          geometry: pt.geometry,
        });
      }
    }

    // End marker with exact total mileage
    if (totalMiles >= 0.05) {
      markerFeatures.push({
        type: 'Feature',
        properties: {
          walkId: walk.id,
          label: `${totalMiles.toFixed(2)} mi`,
          mile: Number(totalMiles.toFixed(2)),
          kind: 'end',
        },
        geometry: {
          type: 'Point',
          coordinates: coords[coords.length - 1],
        },
      });
    }
  }

  return {
    hitGeoJSON: { type: 'FeatureCollection', features: hitFeatures },
    casingGeoJSON: { type: 'FeatureCollection', features: casingFeatures },
    linesGeoJSON: { type: 'FeatureCollection', features: lineFeatures },
    dashesGeoJSON: { type: 'FeatureCollection', features: dashFeatures },
    ticksGeoJSON: { type: 'FeatureCollection', features: tickFeatures },
    markersGeoJSON: { type: 'FeatureCollection', features: markerFeatures },
  };
}

/**
 * Interpolates between two hex colors (#RRGGBB).
 * t = 0 returns hexA (e.g. Hot color), t = 1 returns hexB (e.g. Cool final color).
 */
export function interpolateHexColor(hexA: string, hexB: string, t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const parse = (h: string) => {
    const clean = (h || '#0288D1').replace('#', '').trim();
    if (clean.length !== 6) return [2, 136, 209];
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  };
  const [r1, g1, b1] = parse(hexA);
  const [r2, g2, b2] = parse(hexB);
  const r = Math.round(r1 + (r2 - r1) * clamped);
  const g = Math.round(g1 + (g2 - g1) * clamped);
  const b = Math.round(b1 + (b2 - b1) * clamped);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * Slices a LineString up to a given fraction (0..1) for smooth walk animation.
 */
export function sliceCoordinatesByProgress(
  coords: [number, number][],
  progress: number
): [number, number][] {
  if (!coords || coords.length < 2) return coords;
  if (progress <= 0) return [coords[0], coords[0]];
  if (progress >= 1) return coords;
  try {
    const line = turf.lineString(coords);
    const total = turf.length(line, { units: 'miles' });
    const target = total * progress;
    if (target <= 0.001) return [coords[0], coords[0]];
    const sliced = turf.lineSliceAlong(line, 0, target, { units: 'miles' });
    return sliced.geometry.coordinates as [number, number][];
  } catch {
    const count = Math.max(2, Math.floor(coords.length * progress));
    return coords.slice(0, count);
  }
}

/**
 * Finds nearest existing vertex across visible walks for optional Alt-key snapping.
 */
export function findNearestVertexSnap(
  lngLat: [number, number],
  walks: WalkItem[],
  maxDistanceMeters = 45
): [number, number] | null {
  let bestCoord: [number, number] | null = null;
  let bestDist = maxDistanceMeters;
  const targetPt = turf.point(lngLat);

  for (const w of walks) {
    for (const c of w.coordinates) {
      // Quick bounding box pre-check (~0.001 deg is ~100m)
      if (Math.abs(c[0] - lngLat[0]) > 0.001 || Math.abs(c[1] - lngLat[1]) > 0.001) {
        continue;
      }
      const d = turf.distance(targetPt, turf.point(c), { units: 'meters' });
      if (d < bestDist) {
        bestDist = d;
        bestCoord = [c[0], c[1]];
      }
    }
  }
  return bestCoord;
}
