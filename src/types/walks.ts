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

export type TileProviderId =
  | 'google-roadmap'
  | 'google-terrain'
  | 'google-hybrid'
  | 'google-satellite'
  | 'openfreemap-liberty'
  | 'openfreemap-positron'
  | 'carto-voyager'
  | 'carto-light'
  | 'carto-dark'
  | 'osm'
  | 'esri-sat';

export interface TileProviderOption {
  id: TileProviderId;
  name: string;
  badge: string;
  isOpenShareable: boolean;
  isVectorStyle?: boolean;
  vectorStyleUrl?: string;
  directTileUrl?: string;
}

export const TILE_PROVIDER_OPTIONS: TileProviderOption[] = [
  {
    id: 'google-roadmap',
    name: 'Google Maps (Roadmap)',
    badge: 'Local Cache',
    isOpenShareable: false,
    directTileUrl: 'https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}&scale=2',
  },
  {
    id: 'google-terrain',
    name: 'Google Maps (Terrain)',
    badge: 'Local Cache',
    isOpenShareable: false,
    directTileUrl: 'https://mt1.google.com/vt/lyrs=p&x={x}&y={y}&z={z}&scale=2',
  },
  {
    id: 'google-hybrid',
    name: 'Google Maps (Hybrid)',
    badge: 'Local Cache',
    isOpenShareable: false,
    directTileUrl: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}&scale=2',
  },
  {
    id: 'google-satellite',
    name: 'Google Maps (Satellite)',
    badge: 'Local Cache',
    isOpenShareable: false,
    directTileUrl: 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}&scale=2',
  },
  {
    id: 'openfreemap-liberty',
    name: 'OpenFreeMap Liberty (Vector)',
    badge: 'Open Vector (Rotates Labels)',
    isOpenShareable: true,
    isVectorStyle: true,
    vectorStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  },
  {
    id: 'openfreemap-positron',
    name: 'OpenFreeMap Positron (Vector)',
    badge: 'Open Vector (Rotates Labels)',
    isOpenShareable: true,
    isVectorStyle: true,
    vectorStyleUrl: 'https://tiles.openfreemap.org/styles/positron',
  },
  {
    id: 'carto-voyager',
    name: 'Carto Voyager (Detailed Open)',
    badge: 'Open Shareable',
    isOpenShareable: true,
    directTileUrl: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
  },
  {
    id: 'carto-light',
    name: 'Carto Positron Light',
    badge: 'Open Shareable',
    isOpenShareable: true,
    directTileUrl: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png',
  },
  {
    id: 'carto-dark',
    name: 'Carto Dark Matter',
    badge: 'Open Shareable',
    isOpenShareable: true,
    directTileUrl: 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  },
  {
    id: 'osm',
    name: 'OpenStreetMap Standard',
    badge: 'Open Shareable',
    isOpenShareable: true,
    directTileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  },
  {
    id: 'esri-sat',
    name: 'Esri World Imagery',
    badge: 'Open Shareable',
    isOpenShareable: true,
    directTileUrl:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  },
];

export const YEAR_PALETTE: Record<string, string> = {
  '2020': '#8E24AA',
  '2021': '#8E24AA',
  '2020 / 2021': '#8E24AA',
  '2022': '#3949AB',
  '2023': '#039BE5',
  '2024': '#43A047',
  '2025': '#FB8C00',
  '2026': '#E53935',
  '2027': '#D81B60',
};
