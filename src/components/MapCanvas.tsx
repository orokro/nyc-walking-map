import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  WalkDataset,
  TileProviderId,
  TILE_PROVIDER_OPTIONS,
} from '../types/walks';
import {
  getAutoYearGroup,
  resolveWalkColor,
  resolveWalkWidth,
  generatePlannedMeasureOverlays,
  sliceCoordinatesByProgress,
  findNearestVertexSnap,
  interpolateHexColor,
} from '../utils/geo';

export interface AnimationState {
  active: boolean;
  playing: boolean;
  mode: 'chronological' | 'single';
  currentWalkIndex: number;
  currentWalkProgress: number; // 0..1
  cooldownProgress: number; // Advances after the final walk finishes so hot lines fade out
  speed: number;
  hotFadeEnabled: boolean;
  hotColor: string;
  fadeTailWalks: number; // How many walks it takes to fade from hotColor to cool final color
}

export interface ViewportFrameConfig {
  enabled: boolean;
  aspect: 'phone-portrait' | 'phone-tall' | 'square' | 'landscape';
  includeBanner: boolean;
}

interface MapCanvasProps {
  dataset: WalkDataset;
  boroughGeoJson: any;
  subwayGeoJson: any;
  railGeoJson: any;
  tileProvider: TileProviderId;
  staticMode: boolean;
  bundledOpenProviders: string[];
  visibleYears: Record<string, boolean>;
  showSubwayWalks: boolean;
  showPlannedWalks: boolean;
  searchQuery: string;
  selectedWalkId: string | null;
  onSelectWalk: (id: string | null) => void;
  editorMode: 'view' | 'draw' | 'edit';
  appendUnlocked: boolean;
  draftCoords: [number, number][];
  draftStatus: 'planned' | 'completed';
  draftTitle: string;
  onUpdateDraftCoords: (coords: [number, number][], pushHistory?: boolean) => void;
  bearing: number;
  onBearingChangeFromMap: (bearing: number) => void;
  viewportFrame: ViewportFrameConfig;
  animState: AnimationState;
  mapRefOut: React.MutableRefObject<maplibregl.Map | null>;
}

const GLYPHS_URL = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

function buildRasterStyle(tileUrl: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      'base-raster': {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        maxzoom: 19,
      },
    },
    layers: [
      {
        id: 'base-raster-layer',
        type: 'raster',
        source: 'base-raster',
        minzoom: 0,
        maxzoom: 22,
      },
    ],
  };
}

export const MapCanvas: React.FC<MapCanvasProps> = ({
  dataset,
  boroughGeoJson,
  subwayGeoJson,
  railGeoJson,
  tileProvider,
  staticMode,
  bundledOpenProviders,
  visibleYears,
  showSubwayWalks,
  showPlannedWalks,
  searchQuery,
  selectedWalkId,
  onSelectWalk,
  editorMode,
  appendUnlocked,
  draftCoords,
  draftStatus,
  draftTitle,
  onUpdateDraftCoords,
  bearing,
  onBearingChangeFromMap,
  viewportFrame,
  animState,
  mapRefOut,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [snapPreviewCoord, setSnapPreviewCoord] = useState<[number, number] | null>(null);
  const [hoverVertexIdx, setHoverVertexIdx] = useState<number | null>(null);

  // Ref holding all latest props so MapLibre event listeners (style.load, styledata, mouse events)
  // always have immediate access to the freshest state.
  const stateRef = useRef({
    editorMode,
    appendUnlocked,
    draftCoords,
    draftStatus,
    draftTitle,
    dataset,
    boroughGeoJson,
    subwayGeoJson,
    railGeoJson,
    visibleYears,
    showSubwayWalks,
    showPlannedWalks,
    searchQuery,
    selectedWalkId,
    animState,
    snapPreviewCoord,
    onUpdateDraftCoords,
    onSelectWalk,
  });
  stateRef.current = {
    editorMode,
    appendUnlocked,
    draftCoords,
    draftStatus,
    draftTitle,
    dataset,
    boroughGeoJson,
    subwayGeoJson,
    railGeoJson,
    visibleYears,
    showSubwayWalks,
    showPlannedWalks,
    searchQuery,
    selectedWalkId,
    animState,
    snapPreviewCoord,
    onUpdateDraftCoords,
    onSelectWalk,
  };

  const dragVertexRef = useRef<{
    active: boolean;
    vertexIndex: number;
    isMidpointInsert: boolean;
    currentCoords: [number, number][];
  } | null>(null);

  const resolveTileStyleOrUrl = useCallback(
    (providerId: TileProviderId): string | maplibregl.StyleSpecification => {
      const opt =
        TILE_PROVIDER_OPTIONS.find((o) => o.id === providerId) || TILE_PROVIDER_OPTIONS[0];
      if (opt.isVectorStyle && opt.vectorStyleUrl) {
        return opt.vectorStyleUrl;
      }
      if (staticMode) {
        if (bundledOpenProviders.includes(providerId)) {
          return buildRasterStyle(`./tiles/${providerId}/{z}/{x}/{y}.png`);
        }
        const fallbackOpt = opt.isOpenShareable
          ? opt
          : TILE_PROVIDER_OPTIONS.find((o) => o.id === 'carto-voyager')!;
        return buildRasterStyle(fallbackOpt.directTileUrl!);
      }
      return buildRasterStyle(`/api/tiles/${providerId}/{z}/{x}/{y}`);
    },
    [staticMode, bundledOpenProviders]
  );

  // Ensure all custom GeoJSON sources and layers exist on the map style.
  // Returns true if sources are ready to accept .setData().
  const ensureCustomSourcesAndLayers = useCallback((map: maplibregl.Map): boolean => {
    try {
      if (!map.style) return false;
    } catch {
      return false;
    }

    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const sources = [
      'borough-lines-src',
      'transit-rail-src',
      'transit-subway-src',
      'completed-walks-src',
      'anim-head-src',
      'selected-walk-src',
      'planned-lines-src',
      'planned-ticks-src',
      'planned-markers-src',
      'editor-line-src',
      'editor-midpoints-src',
      'editor-vertices-src',
      'snap-preview-src',
    ];

    try {
      for (const sId of sources) {
        if (!map.getSource(sId)) {
          map.addSource(sId, { type: 'geojson', data: emptyFC });
        }
      }

      // 1. Borough Boundary Lines
      if (!map.getLayer('borough-lines-casing')) {
        map.addLayer({
          id: 'borough-lines-casing',
          type: 'line',
          source: 'borough-lines-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 4.5,
            'line-opacity': 0.65,
          },
        });
      }
      if (!map.getLayer('borough-lines-layer')) {
        map.addLayer({
          id: 'borough-lines-layer',
          type: 'line',
          source: 'borough-lines-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#E65100'],
            'line-width': ['coalesce', ['get', 'width'], 2.5],
            'line-dasharray': [3, 2],
            'line-opacity': 0.85,
          },
        });
      }

      // 2. Commuter Rail Overlay (LIRR / Metro-North)
      if (!map.getLayer('transit-rail-layer')) {
        map.addLayer({
          id: 'transit-rail-layer',
          type: 'line',
          source: 'transit-rail-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#7E57C2'],
            'line-width': 2.2,
            'line-dasharray': [4, 2],
            'line-opacity': 0.75,
          },
        });
      }

      // 3. NYC Subway Overlay
      if (!map.getLayer('transit-subway-layer')) {
        map.addLayer({
          id: 'transit-subway-layer',
          type: 'line',
          source: 'transit-subway-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#0097A7'],
            'line-width': 2.4,
            'line-opacity': 0.7,
          },
        });
      }

      // 4. Completed Walks (Wide invisible hit area + casing + crisp line)
      if (!map.getLayer('completed-walks-hit-layer')) {
        map.addLayer({
          id: 'completed-walks-hit-layer',
          type: 'line',
          source: 'completed-walks-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#000000',
            'line-width': 12,
            'line-opacity': 0.01,
          },
        });
      }
      if (!map.getLayer('completed-walks-casing-layer')) {
        map.addLayer({
          id: 'completed-walks-casing-layer',
          type: 'line',
          source: 'completed-walks-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#0f172a',
            'line-width': ['+', ['coalesce', ['get', 'width'], 3.2], 1.2],
            'line-opacity': ['*', ['coalesce', ['get', 'opacity'], 0.9], 0.32],
          },
        });
      }
      if (!map.getLayer('completed-walks-layer')) {
        map.addLayer({
          id: 'completed-walks-layer',
          type: 'line',
          source: 'completed-walks-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['get', 'color'],
            'line-width': ['get', 'width'],
            'line-opacity': ['get', 'opacity'],
          },
        });
      }

      // Animation Hot Leading Tip Marker
      if (!map.getLayer('anim-head-glow')) {
        map.addLayer({
          id: 'anim-head-glow',
          type: 'circle',
          source: 'anim-head-src',
          paint: {
            'circle-radius': 10,
            'circle-color': ['coalesce', ['get', 'color'], '#FF1744'],
            'circle-opacity': 0.35,
          },
        });
      }
      if (!map.getLayer('anim-head-dot')) {
        map.addLayer({
          id: 'anim-head-dot',
          type: 'circle',
          source: 'anim-head-src',
          paint: {
            'circle-radius': 5,
            'circle-color': '#ffffff',
            'circle-stroke-color': ['coalesce', ['get', 'color'], '#FF1744'],
            'circle-stroke-width': 3,
          },
        });
      }

      // 5. Selected Walk Highlight
      if (!map.getLayer('selected-walk-glow')) {
        map.addLayer({
          id: 'selected-walk-glow',
          type: 'line',
          source: 'selected-walk-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#facc15',
            'line-width': 9,
            'line-opacity': 0.85,
          },
        });
      }
      if (!map.getLayer('selected-walk-core')) {
        map.addLayer({
          id: 'selected-walk-core',
          type: 'line',
          source: 'selected-walk-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#0288D1'],
            'line-width': 4,
            'line-opacity': 1,
          },
        });
      }

      // 6. Planned Walks (Google Maps Measure-Tool Graduated Style)
      if (!map.getLayer('planned-walks-casing-layer')) {
        map.addLayer({
          id: 'planned-walks-casing-layer',
          type: 'line',
          source: 'planned-lines-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#111827',
            'line-width': 6.5,
            'line-opacity': 0.92,
          },
        });
      }
      if (!map.getLayer('planned-walks-inner-layer')) {
        map.addLayer({
          id: 'planned-walks-inner-layer',
          type: 'line',
          source: 'planned-lines-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['coalesce', ['get', 'color'], '#FF6D00'],
            'line-width': 3.5,
            'line-opacity': 1,
          },
        });
      }
      if (!map.getLayer('planned-walks-dash-layer')) {
        map.addLayer({
          id: 'planned-walks-dash-layer',
          type: 'line',
          source: 'planned-lines-src',
          layout: { 'line-join': 'round', 'line-cap': 'butt' },
          paint: {
            'line-color': '#ffffff',
            'line-width': 2.0,
            'line-dasharray': [2, 3],
            'line-opacity': 0.9,
          },
        });
      }

      // Graduation Ticks (0.25 mi minor & 1.0 mi major)
      if (!map.getLayer('planned-ticks-casing')) {
        map.addLayer({
          id: 'planned-ticks-casing',
          type: 'line',
          source: 'planned-ticks-src',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': '#0f172a',
            'line-width': ['case', ['==', ['get', 'major'], 1], 4.5, 3.0],
            'line-opacity': 0.95,
          },
        });
      }
      if (!map.getLayer('planned-ticks-layer')) {
        map.addLayer({
          id: 'planned-ticks-layer',
          type: 'line',
          source: 'planned-ticks-src',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': ['case', ['==', ['get', 'major'], 1], '#fef08a', '#ffffff'],
            'line-width': ['case', ['==', ['get', 'major'], 1], 2.5, 1.5],
            'line-opacity': 1,
          },
        });
      }

      // Mile Marker Circles & Labels
      if (!map.getLayer('planned-markers-circle')) {
        map.addLayer({
          id: 'planned-markers-circle',
          type: 'circle',
          source: 'planned-markers-src',
          paint: {
            'circle-radius': [
              'case',
              ['==', ['get', 'kind'], 'end'],
              7,
              ['==', ['get', 'kind'], 'start'],
              6,
              5,
            ],
            'circle-color': [
              'case',
              ['==', ['get', 'kind'], 'end'],
              '#dc2626',
              ['==', ['get', 'kind'], 'start'],
              '#16a34a',
              '#1e293b',
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
          },
        });
      }
      if (!map.getLayer('planned-markers-label')) {
        map.addLayer({
          id: 'planned-markers-label',
          type: 'symbol',
          source: 'planned-markers-src',
          layout: {
            'text-field': ['get', 'label'],
            'text-font': ['Noto Sans Bold'],
            'text-size': ['case', ['==', ['get', 'kind'], 'end'], 12, 10.5],
            'text-offset': [0, -1.25],
            'text-anchor': 'bottom',
            'text-allow-overlap': true,
            'text-ignore-placement': false,
          },
          paint: {
            'text-color': [
              'case',
              ['==', ['get', 'kind'], 'end'],
              '#fef08a',
              ['==', ['get', 'kind'], 'start'],
              '#bbf7d0',
              '#ffffff',
            ],
            'text-halo-color': '#0f172a',
            'text-halo-width': 2.2,
          },
        });
      }

      // 7. Active Route Editor Layers (Line, Midpoints, Draggable Vertices, Snap Ring)
      if (!map.getLayer('editor-line-casing')) {
        map.addLayer({
          id: 'editor-line-casing',
          type: 'line',
          source: 'editor-line-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#0f172a',
            'line-width': 6.5,
            'line-opacity': 0.9,
          },
        });
      }
      if (!map.getLayer('editor-line-core')) {
        map.addLayer({
          id: 'editor-line-core',
          type: 'line',
          source: 'editor-line-src',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': '#38bdf8',
            'line-width': 3.5,
            'line-opacity': 1,
          },
        });
      }
      if (!map.getLayer('editor-midpoints-layer')) {
        map.addLayer({
          id: 'editor-midpoints-layer',
          type: 'circle',
          source: 'editor-midpoints-src',
          paint: {
            'circle-radius': 4.5,
            'circle-color': '#38bdf8',
            'circle-opacity': 0.75,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5,
          },
        });
      }
      if (!map.getLayer('editor-vertices-layer')) {
        map.addLayer({
          id: 'editor-vertices-layer',
          type: 'circle',
          source: 'editor-vertices-src',
          paint: {
            'circle-radius': [
              'case',
              ['==', ['get', 'role'], 'start'],
              7,
              ['==', ['get', 'role'], 'end'],
              7,
              5.5,
            ],
            'circle-color': [
              'case',
              ['==', ['get', 'role'], 'start'],
              '#22c55e',
              ['==', ['get', 'role'], 'end'],
              '#f97316',
              '#ffffff',
            ],
            'circle-stroke-color': '#0f172a',
            'circle-stroke-width': 2.2,
          },
        });
      }
      if (!map.getLayer('snap-preview-layer')) {
        map.addLayer({
          id: 'snap-preview-layer',
          type: 'circle',
          source: 'snap-preview-src',
          paint: {
            'circle-radius': 9,
            'circle-color': 'rgba(236, 72, 153, 0.25)',
            'circle-stroke-color': '#ec4899',
            'circle-stroke-width': 2.5,
          },
        });
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  // Push Borough, Subway, and Commuter Rail data to map sources
  const syncReferenceOverlays = useCallback(
    (map: maplibregl.Map) => {
      if (!ensureCustomSourcesAndLayers(map)) return;
      const {
        dataset: ds,
        boroughGeoJson: bGeo,
        subwayGeoJson: sGeo,
        railGeoJson: rGeo,
      } = stateRef.current;

      const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

      const boroughSrc = map.getSource('borough-lines-src') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (boroughSrc) {
        if (ds.settings.showBoroughLines && bGeo) {
          const styledFeatures = (bGeo.features || []).map((f: any) => ({
            ...f,
            properties: {
              ...f.properties,
              color: ds.settings.boroughLineColor || '#E65100',
              width: ds.settings.boroughLineWidth ?? 2.5,
            },
          }));
          boroughSrc.setData({ type: 'FeatureCollection', features: styledFeatures });
        } else {
          boroughSrc.setData(emptyFC);
        }
      }

      const subwaySrc = map.getSource('transit-subway-src') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (subwaySrc) {
        subwaySrc.setData(ds.settings.showSubwayLines && sGeo ? sGeo : emptyFC);
      }

      const railSrc = map.getSource('transit-rail-src') as maplibregl.GeoJSONSource | undefined;
      if (railSrc) {
        railSrc.setData(ds.settings.showCommuterRail && rGeo ? rGeo : emptyFC);
      }
    },
    [ensureCustomSourcesAndLayers]
  );

  // Push Completed Walks, Planned Measure Walks, Animation Hot Fade, and Editor handles to map sources
  const syncWalksAndEditorData = useCallback(
    (map: maplibregl.Map) => {
      if (!ensureCustomSourcesAndLayers(map)) return;
      const {
        dataset: ds,
        visibleYears: visYrs,
        showSubwayWalks: showSub,
        showPlannedWalks: showPlan,
        searchQuery: sq,
        selectedWalkId: selId,
        editorMode: mode,
        draftCoords: dCoords,
        draftStatus: dStatus,
        draftTitle: dTitle,
        animState: anim,
      } = stateRef.current;

      const q = sq.trim().toLowerCase();
      const completedFeatures: GeoJSON.Feature[] = [];
      const animHeadFeatures: GeoJSON.Feature[] = [];
      const plannedForMeasure: {
        id: string;
        title: string;
        coordinates: [number, number][];
        color?: string;
      }[] = [];

      const visibleManualSet = new Set(
        ds.manualLayers.filter((l) => l.visible).map((l) => l.id)
      );

      const editingWalkId = mode === 'edit' ? selId : null;

      // Sort completed walks chronologically for animation indexing
      const completedWalksList = ds.walks
        .filter((w) => w.status === 'completed')
        .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
      const completedIndexMap = new Map<string, number>();
      completedWalksList.forEach((cw, idx) => completedIndexMap.set(cw.id, idx));

      ds.walks.forEach((walk) => {
        if (walk.id === editingWalkId) return;

        if (q) {
          const hay = `${walk.date} ${walk.title} ${walk.notes}`.toLowerCase();
          if (!hay.includes(q)) return;
        }

        if (walk.manualLayerId && !visibleManualSet.has(walk.manualLayerId)) {
          return;
        }

        if (walk.status === 'planned') {
          if (!showPlan) return;
          plannedForMeasure.push({
            id: walk.id,
            title: walk.title,
            coordinates: walk.coordinates,
            color: walk.styleOverride?.color || ds.settings.plannedWalkColor || '#FF6D00',
          });
          return;
        }

        if (walk.isSubwayWalk) {
          if (!showSub) return;
        } else {
          const yg = getAutoYearGroup(walk);
          if (visYrs[yg] === false) return;
        }

        let coords = walk.coordinates;
        let color = resolveWalkColor(walk, ds.settings, ds.manualLayers);
        let width = resolveWalkWidth(walk, ds.settings);
        const opacity = walk.isSubwayWalk
          ? ds.settings.subwayWalkOpacity ?? 0.9
          : ds.settings.completedWalkOpacity ?? 0.9;

        // Handle Animation & Hot-to-Cool Color Fade
        if (anim.active) {
          const cooldown = anim.cooldownProgress || 0;
          if (anim.mode === 'single') {
            if (walk.id !== selId) return;
            coords = sliceCoordinatesByProgress(walk.coordinates, anim.currentWalkProgress);
            if (anim.hotFadeEnabled && coords.length >= 2) {
              // While drawing (progress < 1), keep hot; during end cooldown (0..1), fade smoothly to cool final color
              const coolT = anim.currentWalkProgress < 1 ? 0 : Math.min(1, cooldown);
              color = interpolateHexColor(anim.hotColor || '#FF1744', color, coolT);
              width = width + (1 - coolT) * 1.8;
              if (anim.currentWalkProgress < 1) {
                animHeadFeatures.push({
                  type: 'Feature',
                  properties: { color: anim.hotColor || '#FF1744' },
                  geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
                });
              }
            }
          } else {
            const cIdx = completedIndexMap.get(walk.id) ?? -1;
            if (cIdx === -1 || cIdx > anim.currentWalkIndex) return;
            if (cIdx === anim.currentWalkIndex) {
              coords = sliceCoordinatesByProgress(walk.coordinates, anim.currentWalkProgress);
              if (coords.length >= 2 && cooldown === 0 && anim.currentWalkProgress < 1) {
                animHeadFeatures.push({
                  type: 'Feature',
                  properties: { color: anim.hotColor || '#FF1744' },
                  geometry: { type: 'Point', coordinates: coords[coords.length - 1] },
                });
              }
            }

            if (anim.hotFadeEnabled) {
              const fadeWindow = Math.max(1, anim.fadeTailWalks || 8);
              const exactTimelinePos =
                anim.currentWalkIndex + anim.currentWalkProgress + cooldown;
              const ageWalks = Math.max(0, exactTimelinePos - (cIdx + 1));

              if (cIdx === anim.currentWalkIndex && cooldown === 0 && anim.currentWalkProgress < 1) {
                // Currently drawing walk: 100% Hot Color + thickness boost so it stands out on top
                color = anim.hotColor || '#FF1744';
                width = width + 2.0;
              } else if (ageWalks < fadeWindow) {
                // Recently completed walk (including final walks during end cooldown):
                // smoothly cool from Hot Color -> Final Cool Color
                const coolT = ageWalks / fadeWindow;
                color = interpolateHexColor(anim.hotColor || '#FF1744', color, coolT);
                width = width + (1 - coolT) * 1.6;
              }
            }
          }
        }

        if (!coords || coords.length < 2) return;

        completedFeatures.push({
          type: 'Feature',
          properties: {
            id: walk.id,
            title: walk.title,
            date: walk.date,
            isSubway: walk.isSubwayWalk ? 1 : 0,
            color,
            width,
            opacity,
          },
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
        });
      });

      if ((mode === 'draw' || mode === 'edit') && dCoords.length >= 2 && dStatus === 'planned') {
        plannedForMeasure.push({
          id: 'draft-planned',
          title: dTitle || 'Planned Route',
          coordinates: dCoords,
          color: ds.settings.plannedWalkColor || '#FF6D00',
        });
      }

      (map.getSource('completed-walks-src') as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: completedFeatures,
      });

      (map.getSource('anim-head-src') as maplibregl.GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features: animHeadFeatures,
      });

      // Selected Walk Highlight
      const selectedSrc = map.getSource('selected-walk-src') as
        | maplibregl.GeoJSONSource
        | undefined;
      if (selectedSrc) {
        const selWalk =
          mode === 'view' && selId && !anim.active
            ? ds.walks.find((w) => w.id === selId)
            : null;
        if (selWalk && selWalk.coordinates.length >= 2) {
          selectedSrc.setData({
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: {
                  id: selWalk.id,
                  color: resolveWalkColor(selWalk, ds.settings, ds.manualLayers),
                },
                geometry: {
                  type: 'LineString',
                  coordinates: selWalk.coordinates,
                },
              },
            ],
          });
        } else {
          selectedSrc.setData({ type: 'FeatureCollection', features: [] });
        }
      }

      // Planned Measure Overlays
      const { linesGeoJSON, ticksGeoJSON, markersGeoJSON } =
        generatePlannedMeasureOverlays(plannedForMeasure);

      (map.getSource('planned-lines-src') as maplibregl.GeoJSONSource | undefined)?.setData(
        linesGeoJSON
      );
      (map.getSource('planned-ticks-src') as maplibregl.GeoJSONSource | undefined)?.setData(
        ticksGeoJSON
      );
      (map.getSource('planned-markers-src') as maplibregl.GeoJSONSource | undefined)?.setData(
        markersGeoJSON
      );

      // Editor Active Line, Midpoints & Vertices
      const editorLineSrc = map.getSource('editor-line-src') as
        | maplibregl.GeoJSONSource
        | undefined;
      const editorMidSrc = map.getSource('editor-midpoints-src') as
        | maplibregl.GeoJSONSource
        | undefined;
      const editorVertSrc = map.getSource('editor-vertices-src') as
        | maplibregl.GeoJSONSource
        | undefined;

      if (mode === 'draw' || mode === 'edit') {
        editorLineSrc?.setData(
          dCoords.length >= 2
            ? {
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: dCoords },
                  },
                ],
              }
            : { type: 'FeatureCollection', features: [] }
        );

        const mids: GeoJSON.Feature[] = [];
        for (let i = 0; i < dCoords.length - 1; i++) {
          const a = dCoords[i];
          const b = dCoords[i + 1];
          mids.push({
            type: 'Feature',
            properties: { afterIndex: i },
            geometry: {
              type: 'Point',
              coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
            },
          });
        }
        editorMidSrc?.setData({ type: 'FeatureCollection', features: mids });

        const verts: GeoJSON.Feature[] = dCoords.map((c, idx) => ({
          type: 'Feature',
          properties: {
            index: idx,
            role: idx === 0 ? 'start' : idx === dCoords.length - 1 ? 'end' : 'mid',
          },
          geometry: { type: 'Point', coordinates: c },
        }));
        editorVertSrc?.setData({ type: 'FeatureCollection', features: verts });
      } else {
        editorLineSrc?.setData({ type: 'FeatureCollection', features: [] });
        editorMidSrc?.setData({ type: 'FeatureCollection', features: [] });
        editorVertSrc?.setData({ type: 'FeatureCollection', features: [] });
      }
    },
    [ensureCustomSourcesAndLayers]
  );

  // Instant GPU paint property updates for style sliders (width, opacity, colors)
  // so dragging sliders to their extremes updates at 60fps without waiting on GeoJSON worker queues
  const syncStylePaintProperties = useCallback(
    (map: maplibregl.Map) => {
      if (!ensureCustomSourcesAndLayers(map)) return;
      const { dataset: ds, animState: anim } = stateRef.current;
      const s = ds.settings;

      try {
        if (map.getLayer('borough-lines-layer')) {
          map.setPaintProperty(
            'borough-lines-layer',
            'line-color',
            s.boroughLineColor || '#E65100'
          );
          map.setPaintProperty(
            'borough-lines-layer',
            'line-width',
            Number(s.boroughLineWidth ?? 2.5)
          );
        }
        if (map.getLayer('planned-walks-inner-layer')) {
          map.setPaintProperty(
            'planned-walks-inner-layer',
            'line-color',
            s.plannedWalkColor || '#FF6D00'
          );
        }

        if (map.getLayer('completed-walks-layer') && map.getLayer('completed-walks-casing-layer')) {
          if (anim.active) {
            map.setPaintProperty('completed-walks-layer', 'line-color', ['get', 'color']);
            map.setPaintProperty('completed-walks-layer', 'line-width', ['get', 'width']);
            map.setPaintProperty('completed-walks-layer', 'line-opacity', ['get', 'opacity']);
            map.setPaintProperty('completed-walks-casing-layer', 'line-width', [
              '+',
              ['coalesce', ['get', 'width'], 3.2],
              1.2,
            ]);
          } else {
            const wExpr: any = [
              'case',
              ['==', ['get', 'isSubway'], 1],
              Number(s.subwayWalkWidth ?? 3.2),
              Number(s.completedWalkWidth ?? 3.2),
            ];
            const opExpr: any = [
              'case',
              ['==', ['get', 'isSubway'], 1],
              Number(s.subwayWalkOpacity ?? 0.9),
              Number(s.completedWalkOpacity ?? 0.9),
            ];
            const colExpr: any =
              s.colorMode === 'uniform'
                ? [
                    'case',
                    ['==', ['get', 'isSubway'], 1],
                    s.subwayWalkColor || '#0097A7',
                    s.completedWalkColor || '#0288D1',
                  ]
                : ['get', 'color'];

            map.setPaintProperty('completed-walks-layer', 'line-width', wExpr);
            map.setPaintProperty('completed-walks-layer', 'line-opacity', opExpr);
            map.setPaintProperty('completed-walks-layer', 'line-color', colExpr);

            map.setPaintProperty('completed-walks-casing-layer', 'line-width', ['+', wExpr, 1.2]);
            map.setPaintProperty('completed-walks-casing-layer', 'line-opacity', [
              '*',
              opExpr,
              0.32,
            ]);
          }
        }
        map.triggerRepaint();
      } catch {
        // ignore if layer not yet ready
      }
    },
    [ensureCustomSourcesAndLayers]
  );

  // Initialize MapLibre GL instance
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initialStyle = resolveTileStyleOrUrl(tileProvider);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: initialStyle,
      center: [-73.935, 40.73],
      zoom: 11.2,
      bearing: bearing,
      pitch: 0,
      maxZoom: 20,
      minZoom: 8,
      canvasContextAttributes: { preserveDrawingBuffer: true },
      attributionControl: false,
    });

    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();

    // Update UI bearing readout when user rotates map via mouse/touch
    map.on('rotate', () => {
      onBearingChangeFromMap(Math.round(map.getBearing()));
    });

    const handleStyleReady = () => {
      const ok = ensureCustomSourcesAndLayers(map);
      if (ok) {
        syncReferenceOverlays(map);
        syncWalksAndEditorData(map);
        syncStylePaintProperties(map);
      } else {
        setTimeout(handleStyleReady, 50);
      }
    };

    map.on('load', handleStyleReady);
    map.on('style.load', handleStyleReady);
    map.on('styledata', () => {
      if (!map.getLayer('completed-walks-layer')) {
        handleStyleReady();
      }
    });
    // Kick off initial check immediately as well
    setTimeout(handleStyleReady, 30);

    // Pointer tracking to distinguish clean click (< 5px movement) from pan/rotate drag
    let pointerDownPos: { x: number; y: number } | null = null;
    const canvas = map.getCanvas();

    const onMouseDown = (e: maplibregl.MapMouseEvent) => {
      // Never interfere with Ctrl+drag or Shift+drag (native MapLibre rotation / box zoom)
      if (e.originalEvent.ctrlKey || e.originalEvent.shiftKey || e.originalEvent.metaKey) {
        pointerDownPos = null;
        return;
      }

      if (e.originalEvent.button === 2) {
        // Right click on vertex deletes it in draw/edit mode
        const { editorMode: mode, draftCoords: coords, onUpdateDraftCoords: update } =
          stateRef.current;
        if (mode === 'draw' || mode === 'edit') {
          const hits = map.queryRenderedFeatures(e.point, {
            layers: ['editor-vertices-layer'],
          });
          if (hits.length > 0) {
            e.preventDefault();
            const vIdx = hits[0].properties?.index;
            if (typeof vIdx === 'number' && coords.length > 1) {
              const next = coords.filter((_, idx) => idx !== vIdx);
              update(next, true);
            }
            return;
          }
        }
        return;
      }

      if (e.originalEvent.button !== 0) return;
      pointerDownPos = { x: e.point.x, y: e.point.y };

      const { editorMode: mode, draftCoords: coords } = stateRef.current;
      if (mode === 'draw' || mode === 'edit') {
        // Check if grabbing an existing vertex handle
        const vertexHits = map.queryRenderedFeatures(e.point, {
          layers: ['editor-vertices-layer'],
        });
        if (vertexHits.length > 0) {
          const vIdx = Number(vertexHits[0].properties?.index);
          if (!isNaN(vIdx)) {
            e.preventDefault();
            map.dragPan.disable();
            canvas.style.cursor = 'grabbing';
            dragVertexRef.current = {
              active: true,
              vertexIndex: vIdx,
              isMidpointInsert: false,
              currentCoords: [...coords],
            };
            return;
          }
        }

        // Check if grabbing a segment midpoint ghost handle to insert & drag a new vertex
        const midHits = map.queryRenderedFeatures(e.point, {
          layers: ['editor-midpoints-layer'],
        });
        if (midHits.length > 0) {
          const afterIdx = Number(midHits[0].properties?.afterIndex);
          if (!isNaN(afterIdx)) {
            e.preventDefault();
            map.dragPan.disable();
            canvas.style.cursor = 'grabbing';
            const pt: [number, number] = [
              Number(e.lngLat.lng.toFixed(6)),
              Number(e.lngLat.lat.toFixed(6)),
            ];
            const next = [...coords];
            next.splice(afterIdx + 1, 0, pt);
            dragVertexRef.current = {
              active: true,
              vertexIndex: afterIdx + 1,
              isMidpointInsert: true,
              currentCoords: next,
            };
            stateRef.current.onUpdateDraftCoords(next, false);
            return;
          }
        }
      }
    };

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const { editorMode: mode, dataset: ds } = stateRef.current;

      if (dragVertexRef.current?.active) {
        let lngLat: [number, number] = [
          Number(e.lngLat.lng.toFixed(6)),
          Number(e.lngLat.lat.toFixed(6)),
        ];
        if (e.originalEvent.altKey) {
          const snap = findNearestVertexSnap(lngLat, ds.walks, 50);
          if (snap) {
            lngLat = snap;
            setSnapPreviewCoord(snap);
          } else {
            setSnapPreviewCoord(null);
          }
        } else {
          setSnapPreviewCoord(null);
        }
        const next = [...dragVertexRef.current.currentCoords];
        next[dragVertexRef.current.vertexIndex] = lngLat;
        dragVertexRef.current.currentCoords = next;
        stateRef.current.onUpdateDraftCoords(next, false);
        return;
      }

      if (!map.getLayer('editor-vertices-layer')) return;

      if (mode === 'draw' || mode === 'edit') {
        if (e.originalEvent.altKey) {
          const snap = findNearestVertexSnap([e.lngLat.lng, e.lngLat.lat], ds.walks, 50);
          setSnapPreviewCoord(snap);
        } else {
          setSnapPreviewCoord(null);
        }

        const vHits = map.queryRenderedFeatures(e.point, {
          layers: ['editor-vertices-layer', 'editor-midpoints-layer'],
        });
        if (vHits.length > 0) {
          canvas.style.cursor = 'pointer';
          if (vHits[0].layer.id === 'editor-vertices-layer') {
            setHoverVertexIdx(Number(vHits[0].properties?.index));
          } else {
            setHoverVertexIdx(null);
          }
        } else {
          canvas.style.cursor =
            mode === 'draw' || stateRef.current.appendUnlocked ? 'crosshair' : 'grab';
          setHoverVertexIdx(null);
        }
      } else {
        setSnapPreviewCoord(null);
        setHoverVertexIdx(null);
        if (map.getLayer('completed-walks-hit-layer')) {
          const walkHits = map.queryRenderedFeatures(e.point, {
            layers: ['completed-walks-hit-layer', 'planned-walks-casing-layer'],
          });
          canvas.style.cursor = walkHits.length > 0 ? 'pointer' : 'grab';
        }
      }
    };

    const onMouseUp = (e: maplibregl.MapMouseEvent) => {
      if (dragVertexRef.current?.active) {
        const finalCoords = dragVertexRef.current.currentCoords;
        dragVertexRef.current = null;
        map.dragPan.enable();
        canvas.style.cursor = 'pointer';
        stateRef.current.onUpdateDraftCoords(finalCoords, true);
        pointerDownPos = null;
        return;
      }

      if (
        !pointerDownPos ||
        e.originalEvent.button !== 0 ||
        e.originalEvent.ctrlKey ||
        e.originalEvent.shiftKey ||
        e.originalEvent.metaKey
      ) {
        pointerDownPos = null;
        return;
      }

      const dx = e.point.x - pointerDownPos.x;
      const dy = e.point.y - pointerDownPos.y;
      const distPx = Math.hypot(dx, dy);
      pointerDownPos = null;

      if (distPx > 5) return;

      const {
        editorMode: mode,
        appendUnlocked: canAppend,
        draftCoords: coords,
        dataset: ds,
        onUpdateDraftCoords: updateDraft,
        onSelectWalk: selectWalk,
      } = stateRef.current;

      if (mode === 'draw' || (mode === 'edit' && canAppend)) {
        const handleHits = map.queryRenderedFeatures(e.point, {
          layers: ['editor-vertices-layer', 'editor-midpoints-layer'],
        });
        if (handleHits.length > 0) return;

        let newPt: [number, number] = [
          Number(e.lngLat.lng.toFixed(6)),
          Number(e.lngLat.lat.toFixed(6)),
        ];
        if (e.originalEvent.altKey) {
          const snap = findNearestVertexSnap(newPt, ds.walks, 50);
          if (snap) newPt = snap;
        }
        updateDraft([...coords, newPt], true);
      } else if (mode === 'view') {
        const walkHits = map.queryRenderedFeatures(e.point, {
          layers: ['planned-walks-casing-layer', 'completed-walks-hit-layer'],
        });
        if (walkHits.length > 0) {
          const wId = walkHits[0].properties?.id;
          if (wId) selectWalk(String(wId));
        } else {
          selectWalk(null);
        }
      }
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    mapRef.current = map;
    mapRefOut.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      mapRefOut.current = null;
    };
  }, []);

  // Switch tile provider dynamically and re-sync all custom layers reliably
  const prevProviderRef = useRef<TileProviderId>(tileProvider);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (prevProviderRef.current !== tileProvider) {
      prevProviderRef.current = tileProvider;
      const nextStyle = resolveTileStyleOrUrl(tileProvider);
      map.setStyle(nextStyle);

      let attempts = 0;
      const restoreAfterStyleChange = () => {
        if (!mapRef.current) return;
        const ok = ensureCustomSourcesAndLayers(map);
        if (ok && map.getLayer('completed-walks-layer')) {
          syncReferenceOverlays(map);
          syncWalksAndEditorData(map);
          syncStylePaintProperties(map);
        } else if (attempts < 60) {
          attempts++;
          setTimeout(restoreAfterStyleChange, 50);
        }
      };
      map.once('style.load', restoreAfterStyleChange);
      setTimeout(restoreAfterStyleChange, 50);
    }
  }, [
    tileProvider,
    resolveTileStyleOrUrl,
    ensureCustomSourcesAndLayers,
    syncReferenceOverlays,
    syncWalksAndEditorData,
    syncStylePaintProperties,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncStylePaintProperties(map);
  }, [
    syncStylePaintProperties,
    animState.active,
    dataset.settings.completedWalkColor,
    dataset.settings.completedWalkWidth,
    dataset.settings.completedWalkOpacity,
    dataset.settings.subwayWalkColor,
    dataset.settings.subwayWalkWidth,
    dataset.settings.subwayWalkOpacity,
    dataset.settings.plannedWalkColor,
    dataset.settings.boroughLineColor,
    dataset.settings.boroughLineWidth,
    dataset.settings.colorMode,
  ]);

  // Sync Reference Overlays whenever visibility or GeoJSONs change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncReferenceOverlays(map);
  }, [
    syncReferenceOverlays,
    dataset.settings.showBoroughLines,
    dataset.settings.showSubwayLines,
    dataset.settings.showCommuterRail,
    boroughGeoJson,
    subwayGeoJson,
    railGeoJson,
  ]);

  // Sync Walks, Planned Measure Overlays, Animation, and Editor Handles whenever walks/visibility/animation change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncWalksAndEditorData(map);
  }, [
    syncWalksAndEditorData,
    dataset.walks,
    dataset.manualLayers,
    dataset.settings.colorMode,
    dataset.settings.completedWalkColor,
    dataset.settings.subwayWalkColor,
    dataset.settings.plannedWalkColor,
    visibleYears,
    showSubwayWalks,
    showPlannedWalks,
    searchQuery,
    selectedWalkId,
    editorMode,
    draftCoords,
    draftStatus,
    draftTitle,
    animState,
  ]);

  // Update Snap Preview Ring
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ensureCustomSourcesAndLayers(map)) return;
    const snapSrc = map.getSource('snap-preview-src') as maplibregl.GeoJSONSource | undefined;
    if (!snapSrc) return;
    if (snapPreviewCoord) {
      snapSrc.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: snapPreviewCoord },
          },
        ],
      });
    } else {
      snapSrc.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [ensureCustomSourcesAndLayers, snapPreviewCoord]);

  return (
    <div className="map-canvas-wrapper">
      <div
        ref={containerRef}
        className="maplibre-container"
        onContextMenu={(e) => e.preventDefault()}
      />

      {/* Phone Screenshot Framing Guide Overlay */}
      {viewportFrame.enabled && (
        <div className="viewport-frame-overlay">
          <div className={`viewport-frame-box aspect-${viewportFrame.aspect}`}>
            {viewportFrame.includeBanner && (
              <div className="viewport-frame-banner">
                <span>
                  {selectedWalkId
                    ? dataset.walks.find((w) => w.id === selectedWalkId)?.title || 'NYC Walk Plan'
                    : draftTitle || 'NYC Walk Route'}
                </span>
                <span className="banner-miles">
                  {selectedWalkId
                    ? `${dataset.walks.find((w) => w.id === selectedWalkId)?.distanceMiles || 0} mi`
                    : ''}
                </span>
              </div>
            )}
            <div className="viewport-frame-corner tl" />
            <div className="viewport-frame-corner tr" />
            <div className="viewport-frame-corner bl" />
            <div className="viewport-frame-corner br" />
          </div>
        </div>
      )}

      {/* Subtle Editor HUD Pill */}
      {(editorMode === 'draw' || editorMode === 'edit') && (
        <div className="editor-floating-hud">
          <span className="hud-badge">
            {editorMode === 'draw' ? 'DRAWING ROUTE' : 'EDITING ROUTE'}
          </span>
          <span>
            <strong>Click</strong> to add point • <strong>Click &amp; Drag</strong> map to pan •{' '}
            <strong>Drag dot</strong> to move • <strong>Right-click dot</strong> to delete • Hold{' '}
            <strong>Alt</strong> to snap
          </span>
          {hoverVertexIdx !== null && (
            <span className="vertex-pill">Vertex #{hoverVertexIdx + 1}</span>
          )}
        </div>
      )}
    </div>
  );
};
