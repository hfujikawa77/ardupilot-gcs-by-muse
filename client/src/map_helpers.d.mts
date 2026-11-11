// Types for the bundled map helper (map_helpers.mjs, copied from the
// platform map runtime per the maps reference).
export interface MapPlace {
  label: string;
  lat: number;
  lng: number;
}
export interface MapHandle {
  destroy(): void;
  selectPlace(index: number | null): void;
}
export interface MountMapOptions {
  places?: MapPlace[];
  center?: { lat: number; lng: number };
  zoom?: number;
  // The bundled runtime resolves every name itself: the Meta vector
  // styles (light / dark / grayscale, served from fbcdn) plus its own
  // built-in raster presets — "bing-hybrid" / "bing-aerial" (Microsoft
  // tile hosts) and "esri-clarity" (ArcGIS) — which it turns into a
  // raster style without touching fbcdn.
  baseStyle?:
    | "light" | "dark" | "grayscale"
    | "bing-hybrid" | "bing-aerial" | "esri-clarity";
}
export declare function mountMap(
  container: HTMLElement,
  options: MountMapOptions,
  onUnavailable: () => void,
): MapHandle | null;
