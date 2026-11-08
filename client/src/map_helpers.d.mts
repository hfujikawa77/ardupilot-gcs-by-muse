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
  baseStyle?: "light" | "dark" | "grayscale";
}
export declare function mountMap(
  container: HTMLElement,
  options: MountMapOptions,
  onUnavailable: () => void,
): MapHandle | null;
