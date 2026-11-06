import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
  WalkDataset,
  WalkItem,
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
} from '../utils/geo';

export interface AnimationState {
  active: boolean;
  playing: boolean;
  mode: 'chronological' | 'single';
  currentWalkIndex: number;
  currentWalkProgress: number; // 0..1
  speed: number;
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
  onBearingChange: (bearing: number) => void;
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
  onBearingChange,
  viewportFrame,
  animState,
  mapRefOut,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [styleLoadedCounter, setStyleLoadedCounter] = useState(0);
  const [snapPreviewCoord, setSnapPreviewCoord] = useState<[number, number] | null>(null);
  const [hoverVertexIdx, setHoverVertexIdx] = useState<number | null>(null);

  // Refs for latest props inside MapLibre event listeners
  const stateRef = useRef({
    editorMode,
    appendUnlocked,
    draftCoords,
    dataset,
    selectedWalkId,
    onUpdateDraftCoords,
    onSelectWalk,
  });
  stateRef.current = {
    editorMode,
    appendUnlocked,
    draftCoords,
    dataset,
    selectedWalkId,
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

    map.on('rotate', () => {
      onBearingChange(Math.round(map.getBearing()));
    });

    map.on('style.load', () => {
      ensureCustomSourcesAndLayers(map);
      setStyleLoadedCounter((c) => c + 1);
    });

    // Pointer tracking to distinguish clean click (< 5px movement) from pan drag
    let pointerDownPos: { x: number; y: number } | null = null;

    const canvas = map.getCanvas();

    const onMouseDown = (e: maplibregl.MapMouseEvent) => {
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
      const { editorMode: mode, dataset: ds, draftCoords: coords } = stateRef.current;

      // Handle active vertex dragging
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
        const walkHits = map.queryRenderedFeatures(e.point, {
          layers: ['completed-walks-hit-layer', 'planned-walks-casing-layer'],
        });
        canvas.style.cursor = walkHits.length > 0 ? 'pointer' : 'grab';
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

      if (!pointerDownPos || e.originalEvent.button !== 0) return;
      const dx = e.point.x - pointerDownPos.x;
      const dy = e.point.y - pointerDownPos.y;
      const distPx = Math.hypot(dx, dy);
      pointerDownPos = null;

      // If user dragged > 5px, it was a map pan — do NOT add a point or select
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
        // Ignore if clicked directly on an existing vertex or midpoint
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

  // Switch tile provider dynamically
  const prevProviderRef = useRef<TileProviderId>(tileProvider);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (prevProviderRef.current !== tileProvider) {
      prevProviderRef.current = tileProvider;
      const nextStyle = resolveTileStyleOrUrl(tileProvider);
      map.setStyle(nextStyle);
    }
  }, [tileProvider, resolveTileStyleOrUrl]);

  // Sync external bearing changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (Math.abs(map.getBearing() - bearing) > 1) {
      map.rotateTo(bearing, { duration: 180 });
    }
  }, [bearing]);

  // Ensure all GeoJSON sources and layers exist on the map
  function ensureCustomSourcesAndLayers(map: maplibregl.Map) {
    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const sources = [
      'borough-lines-src',
      'transit-rail-src',
      'transit-subway-src',
      'completed-walks-src',
      'selected-walk-src',
      'planned-lines-src',
      'planned-ticks-src',
      'planned-markers-src',
      'editor-line-src',
      'editor-midpoints-src',
      'editor-vertices-src',
      'snap-preview-src',
    ];

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

    // 4. Completed Walks (Wide invisible hit area + crisp rendered line)
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
          'line-opacity': 0.28,
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
  }

  // Update Borough, Subway, and Commuter Rail Overlay Sources
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const emptyFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const boroughSrc = map.getSource('borough-lines-src') as maplibregl.GeoJSONSource | undefined;
    if (boroughSrc) {
      if (dataset.settings.showBoroughLines && boroughGeoJson) {
        const styledFeatures = (boroughGeoJson.features || []).map((f: any) => ({
          ...f,
          properties: {
            ...f.properties,
            color: dataset.settings.boroughLineColor || '#E65100',
            width: dataset.settings.boroughLineWidth || 2.5,
          },
        }));
        boroughSrc.setData({ type: 'FeatureCollection', features: styledFeatures });
      } else {
        boroughSrc.setData(emptyFC);
      }
    }

    const subwaySrc = map.getSource('transit-subway-src') as maplibregl.GeoJSONSource | undefined;
    if (subwaySrc) {
      subwaySrc.setData(
        dataset.settings.showSubwayLines && subwayGeoJson ? subwayGeoJson : emptyFC
      );
    }

    const railSrc = map.getSource('transit-rail-src') as maplibregl.GeoJSONSource | undefined;
    if (railSrc) {
      railSrc.setData(dataset.settings.showCommuterRail && railGeoJson ? railGeoJson : emptyFC);
    }
  }, [
    styleLoadedCounter,
    dataset.settings.showBoroughLines,
    dataset.settings.boroughLineColor,
    dataset.settings.boroughLineWidth,
    dataset.settings.showSubwayLines,
    dataset.settings.showCommuterRail,
    boroughGeoJson,
    subwayGeoJson,
    railGeoJson,
  ]);

  // Update Walks, Planned Graduated Measure Overlays, and Editor Handles
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const q = searchQuery.trim().toLowerCase();
    const completedFeatures: GeoJSON.Feature[] = [];
    const plannedForMeasure: {
      id: string;
      title: string;
      coordinates: [number, number][];
      color?: string;
    }[] = [];

    const visibleManualSet = new Set(
      dataset.manualLayers.filter((l) => l.visible).map((l) => l.id)
    );

    const editingWalkId = editorMode === 'edit' ? selectedWalkId : null;

    // Sort walks chronologically for animation
    const completedWalksList = dataset.walks.filter((w) => w.status === 'completed');

    dataset.walks.forEach((walk) => {
      // Skip the walk currently open in the vertex editor so it doesn't double-render
      if (walk.id === editingWalkId) return;

      if (q) {
        const hay = `${walk.date} ${walk.title} ${walk.notes}`.toLowerCase();
        if (!hay.includes(q)) return;
      }

      if (walk.manualLayerId && !visibleManualSet.has(walk.manualLayerId)) {
        return;
      }

      if (walk.status === 'planned') {
        if (!showPlannedWalks) return;
        plannedForMeasure.push({
          id: walk.id,
          title: walk.title,
          coordinates: walk.coordinates,
          color: walk.styleOverride?.color || dataset.settings.plannedWalkColor || '#FF6D00',
        });
        return;
      }

      // Completed walk visibility
      if (walk.isSubwayWalk) {
        if (!showSubwayWalks) return;
      } else {
        const yg = getAutoYearGroup(walk);
        if (visibleYears[yg] === false) return;
      }

      let coords = walk.coordinates;

      // Handle Animation slicing
      if (animState.active) {
        if (animState.mode === 'single') {
          if (walk.id !== selectedWalkId) return;
          coords = sliceCoordinatesByProgress(walk.coordinates, animState.currentWalkProgress);
        } else {
          const cIdx = completedWalksList.findIndex((cw) => cw.id === walk.id);
          if (cIdx > animState.currentWalkIndex) return;
          if (cIdx === animState.currentWalkIndex) {
            coords = sliceCoordinatesByProgress(walk.coordinates, animState.currentWalkProgress);
          }
        }
      }

      if (!coords || coords.length < 2) return;

      const color = resolveWalkColor(walk, dataset.settings, dataset.manualLayers);
      const width = resolveWalkWidth(walk, dataset.settings);
      const opacity = walk.isSubwayWalk
        ? dataset.settings.subwayWalkOpacity ?? 0.9
        : dataset.settings.completedWalkOpacity ?? 0.9;

      completedFeatures.push({
        type: 'Feature',
        properties: {
          id: walk.id,
          title: walk.title,
          date: walk.date,
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

    // If drawing/editing a Planned walk, also render live graduated 0.25-mi ticks and 1-mi badges!
    if ((editorMode === 'draw' || editorMode === 'edit') && draftCoords.length >= 2) {
      if (draftStatus === 'planned') {
        plannedForMeasure.push({
          id: 'draft-planned',
          title: draftTitle || 'Planned Route',
          coordinates: draftCoords,
          color: dataset.settings.plannedWalkColor || '#FF6D00',
        });
      }
    }

    const completedSrc = map.getSource('completed-walks-src') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (completedSrc) {
      completedSrc.setData({ type: 'FeatureCollection', features: completedFeatures });
    }

    // Selected Walk Highlight (when in View mode)
    const selectedSrc = map.getSource('selected-walk-src') as
      | maplibregl.GeoJSONSource
      | undefined;
    if (selectedSrc) {
      const selWalk =
        editorMode === 'view' && selectedWalkId
          ? dataset.walks.find((w) => w.id === selectedWalkId)
          : null;
      if (selWalk && selWalk.coordinates.length >= 2) {
        selectedSrc.setData({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {
                id: selWalk.id,
                color: resolveWalkColor(selWalk, dataset.settings, dataset.manualLayers),
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

    if (editorMode === 'draw' || editorMode === 'edit') {
      if (editorLineSrc) {
        editorLineSrc.setData(
          draftCoords.length >= 2
            ? {
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    properties: {},
                    geometry: { type: 'LineString', coordinates: draftCoords },
                  },
                ],
              }
            : { type: 'FeatureCollection', features: [] }
        );
      }

      if (editorMidSrc) {
        const mids: GeoJSON.Feature[] = [];
        for (let i = 0; i < draftCoords.length - 1; i++) {
          const a = draftCoords[i];
          const b = draftCoords[i + 1];
          mids.push({
            type: 'Feature',
            properties: { afterIndex: i },
            geometry: {
              type: 'Point',
              coordinates: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
            },
          });
        }
        editorMidSrc.setData({ type: 'FeatureCollection', features: mids });
      }

      if (editorVertSrc) {
        const verts: GeoJSON.Feature[] = draftCoords.map((c, idx) => ({
          type: 'Feature',
          properties: {
            index: idx,
            role:
              idx === 0
                ? 'start'
                : idx === draftCoords.length - 1
                ? 'end'
                : 'mid',
          },
          geometry: { type: 'Point', coordinates: c },
        }));
        editorVertSrc.setData({ type: 'FeatureCollection', features: verts });
      }
    } else {
      editorLineSrc?.setData({ type: 'FeatureCollection', features: [] });
      editorMidSrc?.setData({ type: 'FeatureCollection', features: [] });
      editorVertSrc?.setData({ type: 'FeatureCollection', features: [] });
    }
  }, [
    styleLoadedCounter,
    dataset,
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
    if (!map || !map.isStyleLoaded()) return;
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
  }, [styleLoadedCounter, snapPreviewCoord]);

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
