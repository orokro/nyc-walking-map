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
  if (walk.status === 'planned') return settings.plannedWalkWidth ?? 4.0;
  if (walk.isSubwayWalk) return settings.subwayWalkWidth ?? 3.2;
  return settings.completedWalkWidth ?? 3.2;
}

/**
 * Generates Google Maps Measure-Tool style graduated tick marks (every 0.25 mi)
 * and Mile Marker label points (every 1.0 mi + Start + End total badge)
 * for all visible Planned walks and/or the active draft route.
 */
export function generatePlannedMeasureOverlays(
  plannedWalks: { id: string; title: string; coordinates: [number, number][]; color?: string }[]
): {
  linesGeoJSON: GeoJSON.FeatureCollection;
  ticksGeoJSON: GeoJSON.FeatureCollection;
  markersGeoJSON: GeoJSON.FeatureCollection;
} {
  const lineFeatures: GeoJSON.Feature[] = [];
  const tickFeatures: GeoJSON.Feature[] = [];
  const markerFeatures: GeoJSON.Feature[] = [];

  for (const walk of plannedWalks) {
    const coords = walk.coordinates;
    if (!coords || coords.length < 2) continue;

    const line = turf.lineString(coords, {
      id: walk.id,
      title: walk.title,
      color: walk.color || '#FF6D00',
    });
    const totalMiles = turf.length(line, { units: 'miles' });
    lineFeatures.push(line);

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
      const pt = turf.along(line, dist, { units: 'miles' });
      const ptBefore = turf.along(line, Math.max(0, dist - epsilon), { units: 'miles' });
      const ptAfter = turf.along(line, Math.min(totalMiles, dist + epsilon), { units: 'miles' });
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
    linesGeoJSON: { type: 'FeatureCollection', features: lineFeatures },
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
