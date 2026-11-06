import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import * as turf from '@turf/turf';
import {
  Map as MapIcon,
  Plus,
  Compass,
  Camera,
  Play,
  Pause,
  RotateCcw,
  Download,
  Upload,
  Sliders,
  Layers,
  CheckCircle2,
  Edit3,
  Trash2,
  Undo2,
  Redo2,
  ArrowLeftRight,
  Search,
  ChevronDown,
  ChevronRight,
  Train,
  Sparkles,
  HardDrive,
  Globe,
  FileDown,
  X,
  Eye,
  EyeOff,
  Lock,
  Unlock,
} from 'lucide-react';
import {
  WalkDataset,
  WalkItem,
  TileProviderId,
  TILE_PROVIDER_OPTIONS,
  YEAR_PALETTE,
} from './types/walks';
import { computeLineMiles, getAutoYearGroup, resolveWalkColor } from './utils/geo';
import { MapCanvas, AnimationState, ViewportFrameConfig } from './components/MapCanvas';
import { exportMapScreenshot } from './utils/screenshotExport';
import { exportDatasetToKmzBlob, parseKmzFileToWalks } from './utils/clientKmz';

const IS_STATIC_BUILD = import.meta.env.VITE_STATIC_EXPORT === 'true';

export const App: React.FC = () => {
  const [dataset, setDataset] = useState<WalkDataset | null>(null);
  const [boroughGeoJson, setBoroughGeoJson] = useState<any>(null);
  const [subwayGeoJson, setSubwayGeoJson] = useState<any>(null);
  const [railGeoJson, setRailGeoJson] = useState<any>(null);
  const [staticMode, setStaticMode] = useState<boolean>(IS_STATIC_BUILD);
  const [bundledOpenProviders, setBundledOpenProviders] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved');

  // Map & Layer Visibility States
  const [tileProvider, setTileProvider] = useState<TileProviderId>(
    IS_STATIC_BUILD ? 'openfreemap-liberty' : 'google-roadmap'
  );
  const [sidebarTab, setSidebarTab] = useState<'layers' | 'styles' | 'export'>('layers');
  const [visibleYears, setVisibleYears] = useState<Record<string, boolean>>({});
  const [expandedYears, setExpandedYears] = useState<Record<string, boolean>>({
    '2026': true,
    planned: true,
  });
  const [showSubwayWalks, setShowSubwayWalks] = useState<boolean>(true);
  const [showPlannedWalks, setShowPlannedWalks] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedWalkId, setSelectedWalkId] = useState<string | null>(null);

  // Rotation & Screenshot Framing States
  const [bearing, setBearing] = useState<number>(0);
  const [showScreenshotPanel, setShowScreenshotPanel] = useState<boolean>(false);
  const [viewportFrame, setViewportFrame] = useState<ViewportFrameConfig>({
    enabled: false,
    aspect: 'phone-portrait',
    includeBanner: true,
  });

  // Route Drawing & Editing States
  const [editorMode, setEditorMode] = useState<'view' | 'draw' | 'edit'>('view');
  const [appendUnlocked, setAppendUnlocked] = useState<boolean>(true);
  const [draftWalkId, setDraftWalkId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState<string>('');
  const [draftDate, setDraftDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [draftStatus, setDraftStatus] = useState<'planned' | 'completed'>('planned');
  const [draftIsSubway, setDraftIsSubway] = useState<boolean>(false);
  const [draftManualLayerId, setDraftManualLayerId] = useState<string>('');
  const [draftNotes, setDraftNotes] = useState<string>('');
  const [draftCoords, setDraftCoords] = useState<[number, number][]>([]);
  const [historyStack, setHistoryStack] = useState<[number, number][][]>([]);
  const [redoStack, setRedoStack] = useState<[number, number][][]>([]);

  // New Manual Layer Input
  const [newLayerName, setNewLayerName] = useState<string>('');
  const [newLayerColor, setNewLayerColor] = useState<string>('#8b5cf6');

  // Animation Studio States
  const [animState, setAnimState] = useState<AnimationState>({
    active: false,
    playing: false,
    mode: 'chronological',
    currentWalkIndex: 0,
    currentWalkProgress: 1,
    cooldownProgress: 0,
    speed: 2,
    hotFadeEnabled: true,
    hotColor: '#FF1744',
    fadeTailWalks: 8,
  });

  // Tile Cache & Static Export Status
  const [tileCacheStats, setTileCacheStats] = useState<
    Record<string, { count: number; sizeMB: number }>
  >({});
  const [prefetchInfo, setPrefetchInfo] = useState<any>(null);
  const [prefetchProvider, setPrefetchProvider] = useState<TileProviderId>('google-roadmap');
  const [prefetchMaxZoom, setPrefetchMaxZoom] = useState<number>(15);
  const [staticBuildResult, setStaticBuildResult] = useState<string | null>(null);
  const [isBuildingStatic, setIsBuildingStatic] = useState<boolean>(false);

  const mapRef = useRef<maplibregl.Map | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<any>(null);

  // Rotate map directly from UI controls without fighting map drag rotation
  const rotateMapFromUI = useCallback((nextBearing: number, smooth = false) => {
    setBearing(nextBearing);
    const map = mapRef.current;
    if (!map) return;
    if (smooth) {
      map.easeTo({ bearing: nextBearing, duration: 220 });
    } else {
      map.jumpTo({ bearing: nextBearing });
    }
  }, []);

  // Load initial data
  useEffect(() => {
    async function initLoad() {
      try {
        // Check if static manifest exists
        try {
          const mfRes = await fetch('./data/static-manifest.json');
          if (mfRes.ok) {
            const mf = await mfRes.json();
            if (mf.staticMode) {
              setStaticMode(true);
              setBundledOpenProviders(mf.bundledOpenProviders || []);
              setTileProvider('openfreemap-liberty');
            }
          }
        } catch {
          // Not a static build
        }

        // Load walks dataset (try API first, fallback to ./data/walks.json)
        let walksData: WalkDataset | null = null;
        if (!IS_STATIC_BUILD) {
          try {
            const apiRes = await fetch('/api/walks');
            if (apiRes.ok) {
              walksData = await apiRes.json();
            }
          } catch {
            // Fallback to static file
          }
        }
        if (!walksData) {
          const staticRes = await fetch('./data/walks.json');
          walksData = await staticRes.json();
          if (!IS_STATIC_BUILD) setStaticMode(true);
        }

        if (walksData) {
          setDataset(walksData);
          const yrs: Record<string, boolean> = {};
          for (const w of walksData.walks) {
            if (w.status === 'completed' && !w.isSubwayWalk) {
              yrs[getAutoYearGroup(w)] = true;
            }
          }
          setVisibleYears(yrs);
        }

        // Load Borough Boundaries & Transit Overlays
        const [bRes, subRes, railRes] = await Promise.allSettled([
          fetch('./data/borough-lines.geojson'),
          fetch('./data/transit-subway.geojson'),
          fetch('./data/transit-rail.geojson'),
        ]);

        if (bRes.status === 'fulfilled' && bRes.value.ok) {
          setBoroughGeoJson(await bRes.value.json());
        }
        if (subRes.status === 'fulfilled' && subRes.value.ok) {
          setSubwayGeoJson(await subRes.value.json());
        }
        if (railRes.status === 'fulfilled' && railRes.value.ok) {
          setRailGeoJson(await railRes.value.json());
        }
      } catch (err) {
        console.error('Failed to load walks data:', err);
      }
    }
    initLoad();
  }, []);

  // Persist dataset changes to local server (instant in-memory update + debounced disk save)
  const persistDataset = useCallback(
    (nextDataset: WalkDataset) => {
      setDataset(nextDataset);
      if (staticMode) return;
      setSaveStatus('saving');
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(async () => {
        try {
          const res = await fetch('/api/walks', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nextDataset),
          });
          if (res.ok) {
            setSaveStatus('saved');
          } else {
            setSaveStatus('error');
          }
        } catch {
          setSaveStatus('error');
        }
      }, 300);
    },
    [staticMode]
  );

  // Poll tile cache status when on Export/Cache tab
  useEffect(() => {
    if (staticMode || sidebarTab !== 'export') return;
    let timer: any;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/tiles-status');
        if (res.ok) {
          const data = await res.json();
          setTileCacheStats(data.providers || {});
          setPrefetchInfo(data.prefetch || null);
        }
      } catch {
        // ignore
      }
    };
    fetchStatus();
    timer = setInterval(fetchStatus, 1500);
    return () => clearInterval(timer);
  }, [staticMode, sidebarTab]);

  // Keyboard shortcuts for Undo (Ctrl+Z), Redo (Ctrl+Y), Backspace (delete last vertex), Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (editorMode !== 'draw' && editorMode !== 'edit') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        handleRedo();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (draftCoords.length > 1) {
          e.preventDefault();
          handleUpdateDraftCoords(draftCoords.slice(0, -1), true);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  // Handle Draft Coordinate Updates with History Stack
  const handleUpdateDraftCoords = useCallback(
    (nextCoords: [number, number][], pushHistory = true) => {
      if (pushHistory) {
        setHistoryStack((prev) => [...prev.slice(-40), draftCoords]);
        setRedoStack([]);
      }
      setDraftCoords(nextCoords);
    },
    [draftCoords]
  );

  const handleUndo = () => {
    if (historyStack.length === 0) return;
    const previous = historyStack[historyStack.length - 1];
    setRedoStack((r) => [...r, draftCoords]);
    setHistoryStack((h) => h.slice(0, -1));
    setDraftCoords(previous);
  };

  const handleRedo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setHistoryStack((h) => [...h, draftCoords]);
    setRedoStack((r) => r.slice(0, -1));
    setDraftCoords(next);
  };

  const handleReverseDraft = () => {
    if (draftCoords.length < 2) return;
    handleUpdateDraftCoords([...draftCoords].reverse(), true);
  };

  // Start Drawing a New Walk
  const startNewWalk = (initialStatus: 'planned' | 'completed') => {
    setSelectedWalkId(null);
    setDraftWalkId(null);
    setDraftStatus(initialStatus);
    setDraftDate(new Date().toISOString().slice(0, 10));
    setDraftTitle(initialStatus === 'planned' ? 'New Planned Walk' : 'New NYC Walk');
    setDraftIsSubway(false);
    setDraftManualLayerId('');
    setDraftNotes('');
    setDraftCoords([]);
    setHistoryStack([]);
    setRedoStack([]);
    setAppendUnlocked(true);
    setEditorMode('draw');
  };

  // Start Editing an Existing Walk
  const startEditingWalk = (walk: WalkItem) => {
    setSelectedWalkId(walk.id);
    setDraftWalkId(walk.id);
    setDraftStatus(walk.status);
    setDraftDate(walk.date || new Date().toISOString().slice(0, 10));
    setDraftTitle(walk.title);
    setDraftIsSubway(walk.isSubwayWalk);
    setDraftManualLayerId(walk.manualLayerId || '');
    setDraftNotes(walk.notes || '');
    setDraftCoords(walk.coordinates);
    setHistoryStack([]);
    setRedoStack([]);
    setAppendUnlocked(false); // Default to vertex tweaking so accidental map clicks don't append unless unlocked
    setEditorMode('edit');
  };

  // Save Draft Walk
  const saveDraftWalk = () => {
    if (!dataset) return;
    if (draftCoords.length < 2) {
      alert('Please add at least 2 points on the map to form a walk line.');
      return;
    }

    const miles = computeLineMiles(draftCoords);
    const yr = draftDate && draftDate.length >= 4 ? draftDate.substring(0, 4) : '2026';

    let nextWalks: WalkItem[];
    let savedId = draftWalkId;

    if (editorMode === 'edit' && draftWalkId) {
      nextWalks = dataset.walks.map((w) =>
        w.id === draftWalkId
          ? {
              ...w,
              title: draftTitle.trim() || 'Untitled Walk',
              date: draftDate,
              year: yr,
              status: draftStatus,
              isSubwayWalk: draftIsSubway,
              manualLayerId: draftManualLayerId,
              notes: draftNotes,
              distanceMiles: miles,
              coordinates: draftCoords,
            }
          : w
      );
    } else {
      savedId = `walk-${Date.now()}`;
      const newWalk: WalkItem = {
        id: savedId,
        title: draftTitle.trim() || 'Untitled Walk',
        date: draftDate,
        year: yr,
        status: draftStatus,
        isSubwayWalk: draftIsSubway,
        manualLayerId: draftManualLayerId,
        notes: draftNotes,
        distanceMiles: miles,
        coordinates: draftCoords,
      };
      nextWalks = [...dataset.walks, newWalk];
      // Ensure year is visible
      const yg = getAutoYearGroup(newWalk);
      setVisibleYears((prev) => ({ ...prev, [yg]: true }));
    }

    // Sort chronologically
    nextWalks.sort((a, b) => {
      const da = a.date || '9999-99-99';
      const db = b.date || '9999-99-99';
      return da.localeCompare(db);
    });

    persistDataset({ ...dataset, walks: nextWalks });
    setEditorMode('view');
    setSelectedWalkId(savedId);
  };

  // Mark a Planned Walk as Completed with 1 click
  const markPlannedWalkCompleted = (walk: WalkItem) => {
    if (!dataset) return;
    const defaultDate = walk.date || new Date().toISOString().slice(0, 10);
    const chosenDate = window.prompt(
      `Mark "${walk.title}" (${walk.distanceMiles} mi) as Completed!\nEnter walk date (YYYY-MM-DD):`,
      defaultDate
    );
    if (chosenDate === null) return;
    const cleanDate = chosenDate.trim() || defaultDate;
    const yr = cleanDate.substring(0, 4) || '2026';

    const nextWalks = dataset.walks.map((w) =>
      w.id === walk.id
        ? {
            ...w,
            status: 'completed' as const,
            date: cleanDate,
            year: yr,
            manualLayerId: w.manualLayerId === 'other' ? '' : w.manualLayerId,
          }
        : w
    );
    const yg = yr === '2020' || yr === '2021' ? '2020 / 2021' : yr;
    setVisibleYears((prev) => ({ ...prev, [yg]: true }));
    persistDataset({ ...dataset, walks: nextWalks });
  };

  // Delete a Walk
  const deleteWalk = (walkId: string) => {
    if (!dataset) return;
    const target = dataset.walks.find((w) => w.id === walkId);
    if (!target) return;
    if (!window.confirm(`Delete walk "${target.title}" (${target.distanceMiles} mi)?`)) return;
    const nextWalks = dataset.walks.filter((w) => w.id !== walkId);
    persistDataset({ ...dataset, walks: nextWalks });
    if (selectedWalkId === walkId) setSelectedWalkId(null);
    if (editorMode !== 'view') setEditorMode('view');
  };

  // Zoom to a specific walk on the map
  const flyToWalk = (walk: WalkItem) => {
    setSelectedWalkId(walk.id);
    const map = mapRef.current;
    if (!map || walk.coordinates.length < 2) return;
    const bbox = turf.bbox(turf.lineString(walk.coordinates)) as [number, number, number, number];
    map.fitBounds(bbox, {
      padding: 80,
      bearing: map.getBearing(),
      duration: 650,
    });
  };

  // Animation Loop
  const completedWalksChronological = useMemo(() => {
    if (!dataset) return [];
    return dataset.walks
      .filter((w) => w.status === 'completed')
      .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  }, [dataset]);

  useEffect(() => {
    if (!animState.active || !animState.playing) return;
    let rafId: number;
    let lastTime = performance.now();

    const step = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      setAnimState((prev) => {
        if (!prev.playing) return prev;
        if (prev.mode === 'single') {
          if (prev.currentWalkProgress < 1) {
            const nextProg = prev.currentWalkProgress + dt * 0.35 * prev.speed;
            if (nextProg >= 1) {
              if (!prev.hotFadeEnabled) {
                return { ...prev, currentWalkProgress: 1, cooldownProgress: 1, playing: false };
              }
              return { ...prev, currentWalkProgress: 1, cooldownProgress: 0 };
            }
            return { ...prev, currentWalkProgress: nextProg, cooldownProgress: 0 };
          } else {
            // Extra cooldown seconds at the end so the single walk fades from hot to cool
            const nextCool = (prev.cooldownProgress || 0) + dt * 0.45;
            if (nextCool >= 1) {
              return { ...prev, cooldownProgress: 1, playing: false };
            }
            return { ...prev, cooldownProgress: nextCool };
          }
        } else {
          // Chronological replay across all completed walks
          const lastIdx = Math.max(0, completedWalksChronological.length - 1);
          const fadeWindow = Math.max(1, prev.fadeTailWalks || 8);

          // If all walks have drawn, run the end cooldown phase so the last walks fade out
          if (prev.currentWalkIndex >= lastIdx && prev.currentWalkProgress >= 1) {
            if (!prev.hotFadeEnabled) {
              return { ...prev, cooldownProgress: fadeWindow, playing: false };
            }
            // Advance cooldown at the walk rate (or ~2.5s minimum duration)
            const coolRate = Math.max(2.2 * prev.speed, fadeWindow / 2.5);
            const nextCool = (prev.cooldownProgress || 0) + dt * coolRate;
            if (nextCool >= fadeWindow) {
              return {
                ...prev,
                currentWalkIndex: lastIdx,
                currentWalkProgress: 1,
                cooldownProgress: fadeWindow,
                playing: false,
              };
            }
            return {
              ...prev,
              currentWalkIndex: lastIdx,
              currentWalkProgress: 1,
              cooldownProgress: nextCool,
            };
          }

          const nextProg = prev.currentWalkProgress + dt * 2.2 * prev.speed;
          if (nextProg >= 1) {
            if (prev.currentWalkIndex + 1 >= completedWalksChronological.length) {
              if (!prev.hotFadeEnabled) {
                return {
                  ...prev,
                  currentWalkIndex: lastIdx,
                  currentWalkProgress: 1,
                  cooldownProgress: fadeWindow,
                  playing: false,
                };
              }
              // Enter the post-animation cooldown phase while keeping playing = true
              return {
                ...prev,
                currentWalkIndex: lastIdx,
                currentWalkProgress: 1,
                cooldownProgress: 0,
              };
            }
            return {
              ...prev,
              currentWalkIndex: prev.currentWalkIndex + 1,
              currentWalkProgress: 0,
              cooldownProgress: 0,
            };
          }
          return { ...prev, currentWalkProgress: nextProg, cooldownProgress: 0 };
        }
      });

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [animState.active, animState.playing, completedWalksChronological.length]);

  // Derived Statistics & Grouped Walks
  const stats = useMemo(() => {
    if (!dataset) {
      return {
        completedCount: 0,
        completedMiles: 0,
        subwayCount: 0,
        subwayMiles: 0,
        plannedCount: 0,
        plannedMiles: 0,
        yearGroups: [] as { year: string; walks: WalkItem[]; totalMiles: number }[],
        subwayWalks: [] as WalkItem[],
        plannedWalks: [] as WalkItem[],
      };
    }

    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = (w: WalkItem) =>
      !q || `${w.date} ${w.title} ${w.notes}`.toLowerCase().includes(q);

    const completed = dataset.walks.filter((w) => w.status === 'completed');
    const subway = completed.filter((w) => w.isSubwayWalk && matchesSearch(w));
    const planned = dataset.walks.filter((w) => w.status === 'planned' && matchesSearch(w));

    const yearMap = new Map<string, WalkItem[]>();
    for (const w of completed) {
      if (w.isSubwayWalk) continue;
      if (!matchesSearch(w)) continue;
      const yg = getAutoYearGroup(w);
      if (!yearMap.has(yg)) yearMap.set(yg, []);
      yearMap.get(yg)!.push(w);
    }

    const yearGroups = Array.from(yearMap.entries())
      .map(([year, list]) => ({
        year,
        walks: list.sort((a, b) => (b.date || '').localeCompare(a.date || '')),
        totalMiles: Number(list.reduce((acc, w) => acc + w.distanceMiles, 0).toFixed(1)),
      }))
      .sort((a, b) => b.year.localeCompare(a.year));

    return {
      completedCount: completed.length,
      completedMiles: Number(completed.reduce((s, w) => s + w.distanceMiles, 0).toFixed(1)),
      subwayCount: completed.filter((w) => w.isSubwayWalk).length,
      subwayMiles: Number(
        completed
          .filter((w) => w.isSubwayWalk)
          .reduce((s, w) => s + w.distanceMiles, 0)
          .toFixed(1)
      ),
      plannedCount: dataset.walks.filter((w) => w.status === 'planned').length,
      plannedMiles: Number(
        dataset.walks
          .filter((w) => w.status === 'planned')
          .reduce((s, w) => s + w.distanceMiles, 0)
          .toFixed(1)
      ),
      yearGroups,
      subwayWalks: subway,
      plannedWalks: planned,
    };
  }, [dataset, searchQuery]);

  const selectedWalk = useMemo(
    () => dataset?.walks.find((w) => w.id === selectedWalkId) || null,
    [dataset, selectedWalkId]
  );

  const draftLiveMiles = useMemo(() => computeLineMiles(draftCoords), [draftCoords]);

  // Export KMZ handler
  const handleExportKmz = async () => {
    if (!dataset) return;
    const blob = await exportDatasetToKmzBlob(dataset, boroughGeoJson);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Walks.kmz';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Import KMZ handler
  const handleImportKmz = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dataset) return;
    try {
      const imported = await parseKmzFileToWalks(file);
      if (imported.length === 0) {
        alert('No LineString walks found in that file.');
        return;
      }
      const replaceAll = window.confirm(
        `Parsed ${imported.length} walks from "${file.name}".\n\nClick OK to APPEND new walks to your map, or Cancel to abort.`
      );
      if (!replaceAll) return;
      const existingKeys = new Set(dataset.walks.map((w) => `${w.date}|${w.title}`));
      const uniqueNew = imported.filter((w) => !existingKeys.has(`${w.date}|${w.title}`));
      const nextWalks = [...dataset.walks, ...uniqueNew];
      persistDataset({ ...dataset, walks: nextWalks });
      alert(`Imported ${uniqueNew.length} new walks (${imported.length - uniqueNew.length} duplicates skipped).`);
    } catch (err: any) {
      alert(`Failed to import KMZ: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  };

  // Trigger Static Site Build
  const handleBuildStaticSite = async () => {
    setIsBuildingStatic(true);
    setStaticBuildResult(null);
    try {
      const res = await fetch('/api/export/static', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeCachedOpenTiles: true }),
      });
      const data = await res.json();
      if (data.ok) {
        setStaticBuildResult(data.outputPath);
      } else {
        alert(`Static build error: ${data.error}`);
      }
    } catch (err: any) {
      alert(`Failed to build static site: ${err.message}`);
    } finally {
      setIsBuildingStatic(false);
    }
  };

  if (!dataset) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <h2>Loading NYC Walks Map...</h2>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {/* Top Header Bar */}
      <header className="top-bar">
        <div className="brand-block">
          <div className="brand-icon">
            <MapIcon size={20} />
          </div>
          <div>
            <h1>NYC Walks Tracker</h1>
            <div className="stats-pills">
              <span className="stat-pill primary">
                <strong>{stats.completedMiles.toLocaleString()} mi</strong> ({stats.completedCount}{' '}
                walks)
              </span>
              <span className="stat-pill teal">
                <Train size={12} /> Subway: <strong>{stats.subwayMiles} mi</strong> (
                {stats.subwayCount})
              </span>
              <span className="stat-pill orange">
                Planned: <strong>{stats.plannedMiles} mi</strong> ({stats.plannedCount})
              </span>
              {!staticMode && (
                <span className={`save-indicator ${saveStatus}`}>
                  {saveStatus === 'saving'
                    ? 'Saving...'
                    : saveStatus === 'saved'
                    ? 'Saved locally'
                    : 'Offline'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Center Map Controls: Tile Switcher + 360° Rotation */}
        <div className="top-controls-group">
          <div className="control-item">
            <label>Base Map</label>
            <select
              value={tileProvider}
              onChange={(e) => setTileProvider(e.target.value as TileProviderId)}
              className="tile-select"
            >
              {TILE_PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.name} [{opt.badge}]
                </option>
              ))}
            </select>
          </div>

          <div className="rotation-control">
            <button
              className="icon-btn"
              title="Reset North (0°)"
              onClick={() => rotateMapFromUI(0, true)}
            >
              <Compass
                size={16}
                style={{ transform: `rotate(${-bearing}deg)`, transition: 'transform 0.1s' }}
              />
              <span>{((Math.round(bearing) % 360) + 360) % 360}°</span>
            </button>
            <input
              type="range"
              min={-180}
              max={180}
              step={1}
              value={bearing > 180 ? bearing - 360 : bearing < -180 ? bearing + 360 : bearing}
              onChange={(e) => rotateMapFromUI(Number(e.target.value), false)}
              className="bearing-slider"
              title="Rotate Map (-180° to +180°)"
            />
            <button
              className="mini-btn"
              title="Align with Manhattan Street Grid (+29°)"
              onClick={() => rotateMapFromUI(29, true)}
            >
              Manhattan 29°
            </button>
          </div>
        </div>

        {/* Right Action Toolbar */}
        <div className="top-actions">
          {!staticMode && editorMode === 'view' && (
            <>
              <button
                className="action-btn planned-btn"
                onClick={() => startNewWalk('planned')}
                title="Plan a route with 0.25-mi graduation ticks and 1-mile badges"
              >
                <Plus size={15} /> Plan Walk
              </button>
              <button
                className="action-btn primary-btn"
                onClick={() => startNewWalk('completed')}
                title="Trace a completed walk"
              >
                <Plus size={15} /> Log Walk
              </button>
            </>
          )}

          <button
            className={`action-btn ${showScreenshotPanel ? 'active' : ''}`}
            onClick={() => {
              const next = !showScreenshotPanel;
              setShowScreenshotPanel(next);
              setViewportFrame((vf) => ({ ...vf, enabled: next }));
            }}
            title="Frame & Export Phone Screenshot or PDF"
          >
            <Camera size={15} /> Screenshot / Print
          </button>

          <button
            className={`action-btn ${animState.active ? 'active' : ''}`}
            onClick={() =>
              setAnimState((prev) => ({
                ...prev,
                active: !prev.active,
                playing: !prev.active,
                mode: 'chronological',
                currentWalkIndex: 0,
                currentWalkProgress: 0,
                cooldownProgress: 0,
              }))
            }
            title="Replay walks chronologically"
          >
            <Sparkles size={15} /> Animate
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="workspace-body">
        {/* Left Sidebar */}
        <aside className="sidebar">
          {editorMode === 'draw' || editorMode === 'edit' ? (
            /* Route Drawing & Editing Panel */
            <div className="editor-panel">
              <div className="editor-panel-header">
                <h3>{editorMode === 'draw' ? 'Draw Walk Route' : 'Edit Walk Route'}</h3>
                <div className="live-mileage-box">
                  <span className="mileage-num">{draftLiveMiles.toFixed(2)}</span>
                  <span className="mileage-unit">miles</span>
                  <span className="vertex-count">({draftCoords.length} pts)</span>
                </div>
              </div>

              <div className="form-group">
                <label>Route Mode</label>
                <div className="segmented-toggle">
                  <button
                    type="button"
                    className={draftStatus === 'planned' ? 'active planned' : ''}
                    onClick={() => setDraftStatus('planned')}
                  >
                    Planned (Mile Markers)
                  </button>
                  <button
                    type="button"
                    className={draftStatus === 'completed' ? 'active completed' : ''}
                    onClick={() => setDraftStatus('completed')}
                  >
                    Completed Walk
                  </button>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Walk Date</label>
                  <input
                    type="date"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Manual Layer</label>
                  <select
                    value={draftManualLayerId}
                    onChange={(e) => setDraftManualLayerId(e.target.value)}
                  >
                    <option value="">Auto by Year ({draftDate.slice(0, 4) || '2026'})</option>
                    {dataset.manualLayers.map((ml) => (
                      <option key={ml.id} value={ml.id}>
                        {ml.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label>Walk Title</label>
                <input
                  type="text"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  placeholder="e.g. Astoria to Flushing Zig Zag"
                />
              </div>

              <div className="form-group checkbox-inline">
                <label>
                  <input
                    type="checkbox"
                    checked={draftIsSubway}
                    onChange={(e) => setDraftIsSubway(e.target.checked)}
                  />
                  <span>Part of 100% NYC Subway Walk (Teal)</span>
                </label>
              </div>

              <div className="form-group">
                <label>Notes (Optional)</label>
                <textarea
                  rows={2}
                  value={draftNotes}
                  onChange={(e) => setDraftNotes(e.target.value)}
                  placeholder="Optional route notes..."
                />
              </div>

              <div className="editor-tools-section">
                <label>Geometry &amp; Vertex Controls</label>
                <div className="tool-btn-grid">
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={handleUndo}
                    disabled={historyStack.length === 0}
                    title="Undo (Ctrl+Z)"
                  >
                    <Undo2 size={14} /> Undo
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={handleRedo}
                    disabled={redoStack.length === 0}
                    title="Redo (Ctrl+Y)"
                  >
                    <Redo2 size={14} /> Redo
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={handleReverseDraft}
                    disabled={draftCoords.length < 2}
                    title="Reverse Start & End direction"
                  >
                    <ArrowLeftRight size={14} /> Reverse
                  </button>
                  <button
                    type="button"
                    className="tool-btn"
                    onClick={() =>
                      draftCoords.length > 0 &&
                      handleUpdateDraftCoords(draftCoords.slice(0, -1), true)
                    }
                    disabled={draftCoords.length === 0}
                    title="Remove last vertex (Backspace)"
                  >
                    <Trash2 size={14} /> Pop Last
                  </button>
                </div>

                {editorMode === 'edit' && (
                  <button
                    type="button"
                    className={`append-mode-btn ${appendUnlocked ? 'unlocked' : 'locked'}`}
                    onClick={() => setAppendUnlocked(!appendUnlocked)}
                  >
                    {appendUnlocked ? (
                      <>
                        <Unlock size={14} /> Map Clicks Append New Points (Active)
                      </>
                    ) : (
                      <>
                        <Lock size={14} /> Map Clicks Locked (Drag/Insert Vertices Only)
                      </>
                    )}
                  </button>
                )}

                <ul className="editor-tips">
                  <li>
                    <strong>Click &amp; Drag Map</strong> anywhere to pan smoothly without dropping a
                    point.
                  </li>
                  <li>
                    <strong>Drag any white dot</strong> to adjust a vertex;{' '}
                    <strong>drag blue midpoint dots</strong> to insert a new vertex.
                  </li>
                  <li>
                    <strong>Right-click any vertex dot</strong> to delete it.
                  </li>
                  <li>
                    Hold <strong>Alt</strong> to magnetically snap to existing walks.
                  </li>
                </ul>
              </div>

              <div className="editor-footer-actions">
                <button type="button" className="save-walk-btn" onClick={saveDraftWalk}>
                  <CheckCircle2 size={16} /> Save Walk ({draftLiveMiles.toFixed(2)} mi)
                </button>
                <div className="secondary-editor-btns">
                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={() => setEditorMode('view')}
                  >
                    Cancel
                  </button>
                  {editorMode === 'edit' && draftWalkId && (
                    <button
                      type="button"
                      className="delete-btn"
                      onClick={() => deleteWalk(draftWalkId)}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Normal Sidebar with Tabs: Layers / Uniform Styles / Cache & Exports */
            <>
              <div className="sidebar-tabs">
                <button
                  className={sidebarTab === 'layers' ? 'active' : ''}
                  onClick={() => setSidebarTab('layers')}
                >
                  <Layers size={15} /> Walks &amp; Layers
                </button>
                <button
                  className={sidebarTab === 'styles' ? 'active' : ''}
                  onClick={() => setSidebarTab('styles')}
                >
                  <Sliders size={15} /> Styles
                </button>
                <button
                  className={sidebarTab === 'export' ? 'active' : ''}
                  onClick={() => setSidebarTab('export')}
                >
                  <HardDrive size={15} /> {staticMode ? 'Export' : 'Cache & Export'}
                </button>
              </div>

              {sidebarTab === 'layers' && (
                <div className="sidebar-content">
                  {/* Search Box */}
                  <div className="search-box">
                    <Search size={15} />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter walks by name or date (e.g. Astoria, 2024-05)..."
                    />
                    {searchQuery && (
                      <button className="clear-search" onClick={() => setSearchQuery('')}>
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  {/* Built-in Reference Overlays */}
                  <div className="layer-section">
                    <div className="section-title">BUILT-IN MAP OVERLAYS</div>
                    <label className="overlay-toggle-row">
                      <input
                        type="checkbox"
                        checked={dataset.settings.showBoroughLines}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              showBoroughLines: e.target.checked,
                            },
                          })
                        }
                      />
                      <span
                        className="color-dot"
                        style={{ background: dataset.settings.boroughLineColor || '#E65100' }}
                      />
                      <span className="overlay-name">NYC Borough Boundaries</span>
                    </label>

                    <label className="overlay-toggle-row">
                      <input
                        type="checkbox"
                        checked={dataset.settings.showSubwayLines}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              showSubwayLines: e.target.checked,
                            },
                          })
                        }
                      />
                      <span className="color-dot" style={{ background: '#0097A7' }} />
                      <span className="overlay-name">NYC Subway Lines (MTA)</span>
                    </label>

                    <label className="overlay-toggle-row">
                      <input
                        type="checkbox"
                        checked={dataset.settings.showCommuterRail}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              showCommuterRail: e.target.checked,
                            },
                          })
                        }
                      />
                      <span className="color-dot" style={{ background: '#7E57C2' }} />
                      <span className="overlay-name">LIRR &amp; Metro-North Lines</span>
                    </label>
                  </div>

                  {/* Planned Walks (Measure Mode) */}
                  <div className="layer-section">
                    <div className="layer-group-header">
                      <button
                        className="expand-btn"
                        onClick={() =>
                          setExpandedYears((p) => ({ ...p, planned: !p.planned }))
                        }
                      >
                        {expandedYears.planned ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </button>
                      <input
                        type="checkbox"
                        checked={showPlannedWalks}
                        onChange={(e) => setShowPlannedWalks(e.target.checked)}
                      />
                      <span
                        className="color-dot"
                        style={{ background: dataset.settings.plannedWalkColor || '#FF6D00' }}
                      />
                      <span
                        className="group-title"
                        onClick={() =>
                          setExpandedYears((p) => ({ ...p, planned: !p.planned }))
                        }
                      >
                        Planned Walks (Graduated)
                      </span>
                      <span className="group-meta">
                        {stats.plannedWalks.length} • {stats.plannedMiles} mi
                      </span>
                    </div>

                    {expandedYears.planned && (
                      <div className="walk-list">
                        {stats.plannedWalks.map((w) => (
                          <div
                            key={w.id}
                            className={`walk-row ${selectedWalkId === w.id ? 'selected' : ''}`}
                            onClick={() => flyToWalk(w)}
                          >
                            <div className="walk-row-main">
                              <span className="walk-title">{w.title}</span>
                              <span className="walk-sub">
                                {w.date ? `${w.date} • ` : ''}
                                <strong>{w.distanceMiles} mi</strong> (0.25mi ticks)
                              </span>
                            </div>
                            {!staticMode && (
                              <div
                                className="walk-row-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  className="mini-action complete"
                                  title="Mark Planned Walk as Completed"
                                  onClick={() => markPlannedWalkCompleted(w)}
                                >
                                  <CheckCircle2 size={14} /> Done
                                </button>
                                <button
                                  className="mini-action"
                                  title="Edit Route"
                                  onClick={() => startEditingWalk(w)}
                                >
                                  <Edit3 size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 100% NYC Subway Walks Collection */}
                  <div className="layer-section">
                    <div className="layer-group-header">
                      <button
                        className="expand-btn"
                        onClick={() =>
                          setExpandedYears((p) => ({ ...p, subway: !p.subway }))
                        }
                      >
                        {expandedYears.subway ? (
                          <ChevronDown size={15} />
                        ) : (
                          <ChevronRight size={15} />
                        )}
                      </button>
                      <input
                        type="checkbox"
                        checked={showSubwayWalks}
                        onChange={(e) => setShowSubwayWalks(e.target.checked)}
                      />
                      <span
                        className="color-dot"
                        style={{ background: dataset.settings.subwayWalkColor || '#0097A7' }}
                      />
                      <span
                        className="group-title"
                        onClick={() =>
                          setExpandedYears((p) => ({ ...p, subway: !p.subway }))
                        }
                      >
                        100% NYC Subway Walks
                      </span>
                      <span className="group-meta">
                        {stats.subwayWalks.length} • {stats.subwayMiles} mi
                      </span>
                    </div>

                    {expandedYears.subway && (
                      <div className="walk-list">
                        {stats.subwayWalks.map((w) => (
                          <div
                            key={w.id}
                            className={`walk-row ${selectedWalkId === w.id ? 'selected' : ''}`}
                            onClick={() => flyToWalk(w)}
                          >
                            <div className="walk-row-main">
                              <span className="walk-title">{w.title}</span>
                              <span className="walk-sub">
                                {w.date} • <strong>{w.distanceMiles} mi</strong>
                              </span>
                            </div>
                            {!staticMode && (
                              <div
                                className="walk-row-actions"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  className="mini-action"
                                  title="Edit Walk"
                                  onClick={() => startEditingWalk(w)}
                                >
                                  <Edit3 size={14} />
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Auto-Year Layers */}
                  <div className="layer-section">
                    <div className="section-title-row">
                      <span>COMPLETED WALKS BY YEAR (AUTO-LAYERS)</span>
                      <div className="tiny-links">
                        <button
                          onClick={() => {
                            const next: Record<string, boolean> = {};
                            stats.yearGroups.forEach((g) => (next[g.year] = true));
                            setVisibleYears(next);
                          }}
                        >
                          All
                        </button>
                        <button
                          onClick={() => {
                            const next: Record<string, boolean> = {};
                            stats.yearGroups.forEach((g) => (next[g.year] = false));
                            setVisibleYears(next);
                          }}
                        >
                          None
                        </button>
                      </div>
                    </div>

                    {stats.yearGroups.map((grp) => {
                      const isVis = visibleYears[grp.year] !== false;
                      const isExp = !!expandedYears[grp.year];
                      const dotColor =
                        dataset.settings.colorMode === 'year'
                          ? YEAR_PALETTE[grp.year] || dataset.settings.completedWalkColor
                          : dataset.settings.completedWalkColor;

                      return (
                        <div key={grp.year} className="year-group-block">
                          <div className="layer-group-header">
                            <button
                              className="expand-btn"
                              onClick={() =>
                                setExpandedYears((p) => ({ ...p, [grp.year]: !p[grp.year] }))
                              }
                            >
                              {isExp ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>
                            <input
                              type="checkbox"
                              checked={isVis}
                              onChange={(e) =>
                                setVisibleYears((p) => ({
                                  ...p,
                                  [grp.year]: e.target.checked,
                                }))
                              }
                            />
                            <span className="color-dot" style={{ background: dotColor }} />
                            <span
                              className="group-title"
                              onClick={() =>
                                setExpandedYears((p) => ({ ...p, [grp.year]: !p[grp.year] }))
                              }
                            >
                              {grp.year}
                            </span>
                            <span className="group-meta">
                              {grp.walks.length} walks • {grp.totalMiles} mi
                            </span>
                          </div>

                          {isExp && (
                            <div className="walk-list">
                              {grp.walks.map((w) => (
                                <div
                                  key={w.id}
                                  className={`walk-row ${
                                    selectedWalkId === w.id ? 'selected' : ''
                                  }`}
                                  onClick={() => flyToWalk(w)}
                                >
                                  <div className="walk-row-main">
                                    <span className="walk-title">{w.title}</span>
                                    <span className="walk-sub">
                                      {w.date} • <strong>{w.distanceMiles} mi</strong>
                                    </span>
                                  </div>
                                  {!staticMode && (
                                    <div
                                      className="walk-row-actions"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <button
                                        className="mini-action"
                                        title="Edit Walk"
                                        onClick={() => startEditingWalk(w)}
                                      >
                                        <Edit3 size={14} />
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Manual Custom Layers */}
                  <div className="layer-section">
                    <div className="section-title">MANUAL CUSTOM LAYERS</div>
                    {dataset.manualLayers.map((ml) => {
                      const count = dataset.walks.filter((w) => w.manualLayerId === ml.id).length;
                      return (
                        <div key={ml.id} className="overlay-toggle-row">
                          <input
                            type="checkbox"
                            checked={ml.visible}
                            onChange={(e) => {
                              const nextLayers = dataset.manualLayers.map((l) =>
                                l.id === ml.id ? { ...l, visible: e.target.checked } : l
                              );
                              persistDataset({ ...dataset, manualLayers: nextLayers });
                            }}
                          />
                          <input
                            type="color"
                            value={ml.color}
                            disabled={staticMode}
                            onChange={(e) => {
                              const nextLayers = dataset.manualLayers.map((l) =>
                                l.id === ml.id ? { ...l, color: e.target.value } : l
                              );
                              persistDataset({ ...dataset, manualLayers: nextLayers });
                            }}
                            className="mini-color-input"
                          />
                          <span className="overlay-name">{ml.name}</span>
                          <span className="group-meta">{count} walks</span>
                        </div>
                      );
                    })}

                    {!staticMode && (
                      <div className="add-manual-layer-row">
                        <input
                          type="color"
                          value={newLayerColor}
                          onChange={(e) => setNewLayerColor(e.target.value)}
                          className="mini-color-input"
                        />
                        <input
                          type="text"
                          value={newLayerName}
                          onChange={(e) => setNewLayerName(e.target.value)}
                          placeholder="New manual layer name..."
                        />
                        <button
                          onClick={() => {
                            if (!newLayerName.trim()) return;
                            const id = `layer-${Date.now()}`;
                            persistDataset({
                              ...dataset,
                              manualLayers: [
                                ...dataset.manualLayers,
                                {
                                  id,
                                  name: newLayerName.trim(),
                                  color: newLayerColor,
                                  visible: true,
                                },
                              ],
                            });
                            setNewLayerName('');
                          }}
                        >
                          Add
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {sidebarTab === 'styles' && (
                <div className="sidebar-content styles-tab">
                  <div className="layer-section">
                    <div className="section-title">COMPLETED WALKS COLOR MODE</div>
                    <div className="segmented-toggle">
                      <button
                        className={dataset.settings.colorMode === 'uniform' ? 'active' : ''}
                        onClick={() =>
                          persistDataset({
                            ...dataset,
                            settings: { ...dataset.settings, colorMode: 'uniform' },
                          })
                        }
                      >
                        Uniform Color
                      </button>
                      <button
                        className={dataset.settings.colorMode === 'year' ? 'active' : ''}
                        onClick={() =>
                          persistDataset({
                            ...dataset,
                            settings: { ...dataset.settings, colorMode: 'year' },
                          })
                        }
                      >
                        Color By Year
                      </button>
                    </div>
                  </div>

                  <div className="layer-section">
                    <div className="section-title">UNIFORM COMPLETED WALKS STYLE</div>
                    <div className="style-control-row">
                      <label>Line Color</label>
                      <input
                        type="color"
                        value={dataset.settings.completedWalkColor}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              completedWalkColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="style-control-row">
                      <label>Line Width ({dataset.settings.completedWalkWidth} px)</label>
                      <input
                        type="range"
                        min={1}
                        max={8}
                        step={0.2}
                        value={dataset.settings.completedWalkWidth}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              completedWalkWidth: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </div>
                    <div className="style-control-row">
                      <label>
                        Opacity ({Math.round(dataset.settings.completedWalkOpacity * 100)}%)
                      </label>
                      <input
                        type="range"
                        min={0.2}
                        max={1}
                        step={0.05}
                        value={dataset.settings.completedWalkOpacity}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              completedWalkOpacity: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="layer-section">
                    <div className="section-title">100% NYC SUBWAY WALKS (EXCEPTION STYLE)</div>
                    <div className="style-control-row">
                      <label>Subway Walk Color</label>
                      <input
                        type="color"
                        value={dataset.settings.subwayWalkColor}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              subwayWalkColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="style-control-row">
                      <label>Line Width ({dataset.settings.subwayWalkWidth} px)</label>
                      <input
                        type="range"
                        min={1}
                        max={8}
                        step={0.2}
                        value={dataset.settings.subwayWalkWidth}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              subwayWalkWidth: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="layer-section">
                    <div className="section-title">PLANNED WALKS (GRADUATED MEASURE MODE)</div>
                    <div className="style-control-row">
                      <label>Core Line Color</label>
                      <input
                        type="color"
                        value={dataset.settings.plannedWalkColor}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              plannedWalkColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <p className="helper-note">
                      Planned walks automatically render with high-contrast outer casing, 0.25-mile
                      graduation ticks, and 1-mile distance badges for mobile screenshots.
                    </p>
                  </div>

                  <div className="layer-section">
                    <div className="section-title">BOROUGH BOUNDARY FEATURE STYLE</div>
                    <div className="style-control-row">
                      <label>Boundary Color</label>
                      <input
                        type="color"
                        value={dataset.settings.boroughLineColor}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              boroughLineColor: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="style-control-row">
                      <label>Boundary Width ({dataset.settings.boroughLineWidth} px)</label>
                      <input
                        type="range"
                        min={1}
                        max={6}
                        step={0.5}
                        value={dataset.settings.boroughLineWidth}
                        onChange={(e) =>
                          persistDataset({
                            ...dataset,
                            settings: {
                              ...dataset.settings,
                              boroughLineWidth: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {sidebarTab === 'export' && (
                <div className="sidebar-content export-tab">
                  {/* KMZ Round-Trip Export / Import */}
                  <div className="layer-section">
                    <div className="section-title">GOOGLE MY MAPS (.KMZ) ROUND-TRIP</div>
                    <p className="helper-note">
                      Export all walks and borough boundaries to a clean, normalized{' '}
                      <code>Walks.kmz</code> file that imports directly into Google My Maps.
                    </p>
                    <div className="export-btn-stack">
                      <button className="full-btn primary" onClick={handleExportKmz}>
                        <Download size={15} /> Export Walks.kmz
                      </button>
                      {!staticMode && (
                        <>
                          <button
                            className="full-btn"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            <Upload size={15} /> Import .KMZ / .KML File
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".kmz,.kml"
                            style={{ display: 'none' }}
                            onChange={handleImportKmz}
                          />
                        </>
                      )}
                    </div>
                  </div>

                  {/* Static Website Builder */}
                  {!staticMode && (
                    <div className="layer-section">
                      <div className="section-title">SHAREABLE STATIC WEBSITE BUILDER</div>
                      <p className="helper-note">
                        Builds a self-contained <code>dist-static/</code> folder with{' '}
                        <code>index.html</code>, your walks, transit overlays, and open map tiles —
                        ready to upload to any static host with zero backend process.
                      </p>
                      <button
                        className="full-btn accent"
                        onClick={handleBuildStaticSite}
                        disabled={isBuildingStatic}
                      >
                        <Globe size={15} />{' '}
                        {isBuildingStatic
                          ? 'Building dist-static/...'
                          : 'Build Static Website (dist-static/)'}
                      </button>
                      {staticBuildResult && (
                        <div className="build-success-box">
                          <strong>Static Site Ready!</strong>
                          <span>Output folder: {staticBuildResult}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Local Disk Tile Cacher */}
                  {!staticMode && (
                    <div className="layer-section">
                      <div className="section-title">LOCAL DISK TILE CACHE (NYC + RYE + NASSAU)</div>
                      <p className="helper-note">
                        Every tile you view is automatically saved to <code>./tile_cache/</code>.
                        You can also pre-download the full NYC + Rye/Westchester + Nassau bounding
                        box offline:
                      </p>

                      <div className="form-group">
                        <label>Provider to Pre-Cache</label>
                        <select
                          value={prefetchProvider}
                          onChange={(e) => setPrefetchProvider(e.target.value as TileProviderId)}
                        >
                          {TILE_PROVIDER_OPTIONS.filter((o) => !o.isVectorStyle).map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label>Zoom Range (11 to {prefetchMaxZoom})</label>
                        <select
                          value={prefetchMaxZoom}
                          onChange={(e) => setPrefetchMaxZoom(Number(e.target.value))}
                        >
                          <option value={14}>Zoom 11–14 (~650 tiles, Fast Overview)</option>
                          <option value={15}>Zoom 11–15 (~2,600 tiles, Street Level)</option>
                          <option value={16}>Zoom 11–16 (~10,400 tiles, Detailed)</option>
                        </select>
                      </div>

                      {prefetchInfo?.running ? (
                        <div className="prefetch-progress-box">
                          <div className="progress-header">
                            <span>
                              Caching {prefetchInfo.provider}: {prefetchInfo.completed} /{' '}
                              {prefetchInfo.total}
                            </span>
                            <button
                              onClick={() =>
                                fetch('/api/tiles-prefetch/cancel', { method: 'POST' })
                              }
                            >
                              Stop
                            </button>
                          </div>
                          <div className="progress-bar-track">
                            <div
                              className="progress-bar-fill"
                              style={{
                                width: `${Math.round(
                                  (prefetchInfo.completed / Math.max(1, prefetchInfo.total)) * 100
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <button
                          className="full-btn"
                          onClick={() =>
                            fetch('/api/tiles-prefetch', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({
                                provider: prefetchProvider,
                                minZoom: 11,
                                maxZoom: prefetchMaxZoom,
                              }),
                            })
                          }
                        >
                          <FileDown size={15} /> Pre-Download NYC Metro Tiles
                        </button>
                      )}

                      <div className="cache-stats-list">
                        {Object.entries(tileCacheStats).map(([key, st]) =>
                          st.count > 0 ? (
                            <div key={key} className="cache-stat-row">
                              <span>{key}</span>
                              <span>
                                {st.count.toLocaleString()} tiles ({st.sizeMB} MB)
                              </span>
                            </div>
                          ) : null
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </aside>

        {/* Map Area */}
        <main className="map-stage">
          <MapCanvas
            dataset={dataset}
            boroughGeoJson={boroughGeoJson}
            subwayGeoJson={subwayGeoJson}
            railGeoJson={railGeoJson}
            tileProvider={tileProvider}
            staticMode={staticMode}
            bundledOpenProviders={bundledOpenProviders}
            visibleYears={visibleYears}
            showSubwayWalks={showSubwayWalks}
            showPlannedWalks={showPlannedWalks}
            searchQuery={searchQuery}
            selectedWalkId={selectedWalkId}
            onSelectWalk={setSelectedWalkId}
            editorMode={editorMode}
            appendUnlocked={appendUnlocked}
            draftCoords={draftCoords}
            draftStatus={draftStatus}
            draftTitle={draftTitle}
            onUpdateDraftCoords={handleUpdateDraftCoords}
            bearing={bearing}
            onBearingChangeFromMap={setBearing}
            viewportFrame={viewportFrame}
            animState={animState}
            mapRefOut={mapRef}
          />

          {/* Selected Walk Floating Inspector Card (Never fights with editing!) */}
          {editorMode === 'view' && selectedWalk && (
            <div className="walk-inspector-card">
              <div className="inspector-header">
                <span
                  className="inspector-color-badge"
                  style={{
                    background: resolveWalkColor(
                      selectedWalk,
                      dataset.settings,
                      dataset.manualLayers
                    ),
                  }}
                />
                <div className="inspector-titles">
                  <h4>{selectedWalk.title}</h4>
                  <span>
                    {selectedWalk.date || 'No date'} •{' '}
                    <strong>{selectedWalk.distanceMiles} miles</strong> •{' '}
                    {selectedWalk.status === 'planned'
                      ? 'Planned (Graduated)'
                      : selectedWalk.isSubwayWalk
                      ? 'Subway Walk'
                      : `Year ${getAutoYearGroup(selectedWalk)}`}
                  </span>
                </div>
                <button className="close-inspector" onClick={() => setSelectedWalkId(null)}>
                  <X size={15} />
                </button>
              </div>
              {selectedWalk.notes && <p className="inspector-notes">{selectedWalk.notes}</p>}
              <div className="inspector-actions">
                {!staticMode && (
                  <>
                    <button
                      className="insp-btn primary"
                      onClick={() => startEditingWalk(selectedWalk)}
                    >
                      <Edit3 size={14} /> Edit Route / Details
                    </button>
                    {selectedWalk.status === 'planned' && (
                      <button
                        className="insp-btn success"
                        onClick={() => markPlannedWalkCompleted(selectedWalk)}
                      >
                        <CheckCircle2 size={14} /> Mark Completed
                      </button>
                    )}
                  </>
                )}
                <button
                  className="insp-btn"
                  onClick={() =>
                    setAnimState((prev) => ({
                      ...prev,
                      active: true,
                      playing: true,
                      mode: 'single',
                      currentWalkIndex: 0,
                      currentWalkProgress: 0,
                      cooldownProgress: 0,
                      speed: 1.5,
                    }))
                  }
                >
                  <Play size={14} /> Animate Walk
                </button>
              </div>
            </div>
          )}

          {/* Phone Screenshot / PDF Framing Floating Toolbar */}
          {showScreenshotPanel && (
            <div className="floating-screenshot-bar">
              <div className="ss-group">
                <label>Crop Frame</label>
                <select
                  value={viewportFrame.enabled ? viewportFrame.aspect : 'none'}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === 'none') {
                      setViewportFrame((vf) => ({ ...vf, enabled: false }));
                    } else {
                      setViewportFrame((vf) => ({
                        ...vf,
                        enabled: true,
                        aspect: val as ViewportFrameConfig['aspect'],
                      }));
                    }
                  }}
                >
                  <option value="phone-portrait">Phone Portrait (9:16)</option>
                  <option value="phone-tall">Modern Phone Tall (9:19.5)</option>
                  <option value="square">Square (1:1)</option>
                  <option value="landscape">Widescreen (16:9)</option>
                  <option value="none">Full Map Window</option>
                </select>
              </div>

              <label className="ss-check">
                <input
                  type="checkbox"
                  checked={viewportFrame.includeBanner}
                  onChange={(e) =>
                    setViewportFrame((vf) => ({ ...vf, includeBanner: e.target.checked }))
                  }
                />
                <span>Include Title &amp; Mileage Banner</span>
              </label>

              <button
                className="ss-export-btn primary"
                onClick={() => {
                  if (!mapRef.current) return;
                  const title = selectedWalk
                    ? `${selectedWalk.date ? selectedWalk.date + ' — ' : ''}${selectedWalk.title}`
                    : 'NYC Walks Map';
                  const milesText = selectedWalk
                    ? `${selectedWalk.distanceMiles} mi`
                    : `${stats.completedMiles.toLocaleString()} mi total`;
                  exportMapScreenshot(mapRef.current, 'png', viewportFrame, {
                    title,
                    subtitle: '',
                    milesText,
                  });
                }}
              >
                <Download size={14} /> Save PNG Screenshot
              </button>

              <button
                className="ss-export-btn"
                onClick={() => {
                  if (!mapRef.current) return;
                  const title = selectedWalk
                    ? `${selectedWalk.date ? selectedWalk.date + ' — ' : ''}${selectedWalk.title}`
                    : 'NYC Walks Map';
                  const milesText = selectedWalk
                    ? `${selectedWalk.distanceMiles} mi`
                    : `${stats.completedMiles.toLocaleString()} mi total`;
                  exportMapScreenshot(mapRef.current, 'pdf', viewportFrame, {
                    title,
                    subtitle: '',
                    milesText,
                  });
                }}
              >
                <FileDown size={14} /> Save PDF
              </button>

              <button
                className="close-ss-btn"
                onClick={() => {
                  setShowScreenshotPanel(false);
                  setViewportFrame((vf) => ({ ...vf, enabled: false }));
                }}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {/* Chronological & Single-Walk Animation Studio Bar */}
          {animState.active && (
            <div className="floating-animation-bar">
              <div className="anim-top-row">
                <button
                  className="anim-play-btn"
                  onClick={() =>
                    setAnimState((p) => {
                      const lastIdx = Math.max(0, completedWalksChronological.length - 1);
                      const isAtEnd =
                        p.mode === 'single'
                          ? p.currentWalkProgress >= 1
                          : p.currentWalkIndex >= lastIdx && p.currentWalkProgress >= 1;
                      if (!p.playing && isAtEnd) {
                        return {
                          ...p,
                          currentWalkIndex: 0,
                          currentWalkProgress: 0,
                          cooldownProgress: 0,
                          playing: true,
                        };
                      }
                      return { ...p, playing: !p.playing };
                    })
                  }
                >
                  {animState.playing ? <Pause size={16} /> : <Play size={16} />}
                </button>

                <button
                  className="anim-icon-btn"
                  title="Restart Animation"
                  onClick={() =>
                    setAnimState((p) => ({
                      ...p,
                      currentWalkIndex: 0,
                      currentWalkProgress: 0,
                      cooldownProgress: 0,
                      playing: true,
                    }))
                  }
                >
                  <RotateCcw size={15} />
                </button>

                <div className="anim-scrubber-col">
                  {animState.mode === 'chronological' ? (
                    <>
                      <div className="anim-info-row">
                        <span>
                          <strong>
                            Walk {animState.currentWalkIndex + 1} /{' '}
                            {completedWalksChronological.length}
                          </strong>
                          :{' '}
                          {completedWalksChronological[animState.currentWalkIndex]?.date || ''}{' '}
                          {completedWalksChronological[animState.currentWalkIndex]?.title || ''}
                        </span>
                        <span className="anim-miles-counter">
                          {completedWalksChronological
                            .slice(0, animState.currentWalkIndex + 1)
                            .reduce((acc, w, idx) => {
                              if (idx === animState.currentWalkIndex) {
                                return acc + w.distanceMiles * animState.currentWalkProgress;
                              }
                              return acc + w.distanceMiles;
                            }, 0)
                            .toFixed(1)}{' '}
                          mi walked
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, completedWalksChronological.length - 1)}
                        value={animState.currentWalkIndex}
                        onChange={(e) =>
                          setAnimState((p) => ({
                            ...p,
                            currentWalkIndex: Number(e.target.value),
                            currentWalkProgress: 1,
                            cooldownProgress: 0,
                          }))
                        }
                      />
                    </>
                  ) : (
                    <>
                      <div className="anim-info-row">
                        <span>
                          <strong>Single Walk Trace</strong>: {selectedWalk?.title || 'Walk'}
                        </span>
                        <span className="anim-miles-counter">
                          {(
                            (selectedWalk?.distanceMiles || 0) * animState.currentWalkProgress
                          ).toFixed(2)}{' '}
                          / {selectedWalk?.distanceMiles || 0} mi
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(animState.currentWalkProgress * 100)}
                        onChange={(e) =>
                          setAnimState((p) => ({
                            ...p,
                            currentWalkProgress: Number(e.target.value) / 100,
                            cooldownProgress: 0,
                          }))
                        }
                      />
                    </>
                  )}
                </div>

                <select
                  value={animState.speed}
                  onChange={(e) =>
                    setAnimState((p) => ({ ...p, speed: Number(e.target.value) }))
                  }
                  className="anim-speed-select"
                  title="Playback Speed"
                >
                  <option value={0.5}>0.5x</option>
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                  <option value={5}>5x</option>
                  <option value={12}>12x</option>
                  <option value={25}>25x</option>
                </select>

                <button
                  className="close-ss-btn"
                  onClick={() => setAnimState((p) => ({ ...p, active: false, playing: false }))}
                >
                  <X size={15} />
                </button>
              </div>

              {/* Hot-to-Cool Fade Controls Row */}
              <div className="anim-hotfade-row">
                <label className="hotfade-toggle">
                  <input
                    type="checkbox"
                    checked={animState.hotFadeEnabled}
                    onChange={(e) =>
                      setAnimState((p) => ({ ...p, hotFadeEnabled: e.target.checked }))
                    }
                  />
                  <span>Hot Trail Fade</span>
                </label>

                {animState.hotFadeEnabled && (
                  <>
                    <div className="hotfade-control">
                      <span>Hot Color:</span>
                      <input
                        type="color"
                        value={animState.hotColor}
                        onChange={(e) =>
                          setAnimState((p) => ({ ...p, hotColor: e.target.value }))
                        }
                        className="mini-color-input"
                      />
                    </div>

                    <div className="hotfade-control fade-slider-wrap">
                      <span>Cooldown Tail: {animState.fadeTailWalks} walks</span>
                      <input
                        type="range"
                        min={1}
                        max={40}
                        step={1}
                        value={animState.fadeTailWalks}
                        onChange={(e) =>
                          setAnimState((p) => ({
                            ...p,
                            fadeTailWalks: Number(e.target.value),
                          }))
                        }
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
};
