// Live map (Meta map runtime, per the maps reference).
//
// The vendored control renders its `places` as a static GeoJSON snapshot,
// so the vehicle is NOT one of its places: a snapshot pin would sit at the
// position from mount time while the vehicle flies on — which is exactly
// what made the map look frozen. Instead the vehicle (rotating triangle)
// and the flown track live in our own GeoJSON source on the underlying
// MapLibre instance, updated via setData() on every telemetry change, and
// the camera follows the vehicle (until the user drags the map).
//
// The control's public handle exposes neither the instance nor click
// coordinates, but its view component receives a `selection` object whose
// `map` field is the MapLibre instance (set on map-ready). We locate it by
// walking the holder's React fiber tree, then attach: map click (tap-to-
// Goto), the live source/layers, and follow-panning. A watchdog interval
// re-discovers and re-attaches after every remount, so a slow style load
// no longer permanently disables tap/live updates. If the instance never
// appears (~20 s), we fall back to snapshot pins that remount whenever the
// vehicle crosses a ~25 m grid cell, so the marker still tracks coarsely.
//
// Home and target stay as control places: home never moves, and a new
// target remounts anyway (which also moves its pin).

import { useEffect, useRef, useState } from "react";
import "./assets/hatch-maps.js";
import "./assets/hatch-maps.css";
import { mountMap, type MapHandle, type MapPlace } from "./map_helpers.mjs";

export interface LatLon { lat: number; lon: number }

/** One flown-track point; altM is its relative altitude in metres. */
export interface TrackPoint extends LatLon { altM?: number }

interface MapPanelProps {
  vehicle: LatLon | null;
  headingDeg: number | null;
  altRelM: number | null;
  home: LatLon | null;
  target: LatLon | null;
  track: TrackPoint[];
  recenterSignal: number;
  onTap?: (p: LatLon) => void;
  onTapReady?: (ready: boolean) => void;
}

interface GeoJsonSourceLike {
  setData: (data: unknown) => void;
}

interface MapLibreLike {
  on: (event: string, cb: (e: { lngLat?: { lat: number; lng: number } }) => void) => void;
  off: (event: string, cb: (e: { lngLat?: { lat: number; lng: number } }) => void) => void;
  getSource: (id: string) => GeoJsonSourceLike | undefined;
  addSource: (id: string, spec: unknown) => void;
  getLayer: (id: string) => unknown;
  addLayer: (spec: unknown) => void;
  hasImage: (id: string) => boolean;
  addImage: (id: string, image: unknown, options?: { pixelRatio?: number }) => void;
  getCenter: () => { lat: number; lng: number };
  easeTo: (opts: { center?: [number, number]; duration?: number; pitch?: number }) => void;
  setPitch?: (pitch: number) => void;
  project: (lngLat: [number, number]) => { x: number; y: number };
}

const LIVE_SOURCE = "gcs-live";
const VEHICLE_LAYER = "gcs-vehicle";
const TRACK_LAYER = "gcs-track";
const VEHICLE_IMAGE = "gcs-aircraft";

// Walk the React fiber tree rooted at the holder element (the map control
// creates its own React root there) and return the MapLibre instance held
// in the internal `selection` object, or null when not (yet) present.
function findMapLibreInstance(holder: HTMLElement): MapLibreLike | null {
  try {
    const key = Object.keys(holder).find((k) => k.startsWith("__reactContainer$"));
    if (!key) return null;
    const root = (holder as unknown as Record<string, unknown>)[key];
    if (!root || typeof root !== "object") return null;
    const seen = new Set<object>();
    const stack: unknown[] = [root];
    while (stack.length > 0) {
      const fiber = stack.pop();
      if (!fiber || typeof fiber !== "object" || seen.has(fiber)) continue;
      seen.add(fiber);
      const f = fiber as {
        memoizedProps?: { selection?: { map?: unknown } };
        pendingProps?: { selection?: { map?: unknown } };
        child?: unknown;
        sibling?: unknown;
      };
      const sel = f.memoizedProps?.selection ?? f.pendingProps?.selection;
      const map = sel?.map as MapLibreLike | null | undefined;
      if (
        map &&
        typeof map.on === "function" &&
        typeof map.getSource === "function" &&
        typeof map.addSource === "function"
      ) {
        return map;
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  } catch {
    return null;
  }
  return null;
}

function haversineM(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Triangle aircraft glyph pointing up (= north / heading 0), drawn once to
// an offscreen canvas and registered as a MapLibre icon image. The symbol
// layer rotates it by the vehicle's live heading.
function makeVehicleImage(): ImageData | null {
  try {
    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.beginPath();
    ctx.moveTo(48, 8); // nose
    ctx.lineTo(84, 84); // right wing corner
    ctx.lineTo(48, 66); // tail notch
    ctx.lineTo(12, 84); // left wing corner
    ctx.closePath();
    ctx.fillStyle = "#22d3ee";
    ctx.strokeStyle = "#0b1116";
    ctx.lineWidth = 6;
    ctx.lineJoin = "round";
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  } catch {
    return null;
  }
}

function buildLiveData(vehicle: LatLon | null, headingDeg: number | null, track: TrackPoint[]) {
  const features: unknown[] = [];
  if (track.length > 1) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: track.map((p) => [p.lon, p.lat]),
      },
      properties: { kind: "track" },
    });
  }
  if (vehicle) {
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] },
      properties: { kind: "vehicle", heading: headingDeg ?? 0 },
    });
  }
  return { type: "FeatureCollection", features };
}

const OBLIQUE_PITCH = 55;

export function MapPanel({
  vehicle, headingDeg, altRelM, home, target, track, recenterSignal, onTap, onTapReady,
}: MapPanelProps) {
  const holderRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<MapHandle | null>(null);
  const sigRef = useRef<string>("");
  const mountAtRef = useRef(0);
  const attachedMapRef = useRef<MapLibreLike | null>(null);
  const lastDataJsonRef = useRef("");
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onTapReadyRef = useRef(onTapReady);
  onTapReadyRef.current = onTapReady;
  const [unavailable, setUnavailable] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  // Oblique (pitched) view: the vehicle leaves the GeoJSON symbol layer
  // and is drawn by the screen-space overlay below, floating above its
  // ground projection on an altitude post.
  const [oblique, setOblique] = useState(false);
  const obliqueRef = useRef(false);
  obliqueRef.current = oblique;
  const altRef = useRef(altRelM);
  altRef.current = altRelM;
  const headingRef = useRef(headingDeg);
  headingRef.current = headingDeg;
  const overlayRef = useRef<SVGSVGElement>(null);
  const ovGroundRef = useRef<SVGEllipseElement>(null);
  const ovPostRef = useRef<SVGLineElement>(null);
  const ovCraftRef = useRef<SVGPolygonElement>(null);
  const ovLabelRef = useRef<SVGTextElement>(null);
  const ovTrackGroundRef = useRef<SVGPathElement>(null);
  const ovTrackPostsRef = useRef<SVGPathElement>(null);
  const ovTrackAirRef = useRef<SVGPathElement>(null);

  // Latest live payload, rebuilt from the newest props on every render so
  // the watchdog interval and the data-push effect always see fresh data.
  // In oblique mode the vehicle AND the track leave the GeoJSON layers:
  // the overlay draws the vehicle on its altitude post and the track as
  // a true 3D path (each point lifted by its own altitude), instead of
  // the ground-hugging 2D line the flat view uses.
  const liveDataRef = useRef(buildLiveData(vehicle, headingDeg, track));
  liveDataRef.current = buildLiveData(
    oblique ? null : vehicle, headingDeg, oblique ? [] : track,
  );
  const vehicleRef = useRef(vehicle);
  vehicleRef.current = vehicle;
  const trackRef = useRef(track);
  trackRef.current = track;

  // ---- altitude-post overlay (oblique view only) ----
  // Ground point = the vehicle's lat/lon projected to screen space; the
  // craft is drawn straight above it by alt * groundScale * sin(pitch),
  // which is how a vertical post projects in the tilted view. Drawn
  // imperatively on the map's render events so it stays glued during
  // pans, zooms and the pitch animation itself.
  const drawOverlayRef = useRef(() => undefined as void);
  drawOverlayRef.current = () => {
    const svg = overlayRef.current;
    const map = attachedMapRef.current;
    const v = vehicleRef.current;
    const trk = trackRef.current;
    if (!svg) return;
    if (!map || !obliqueRef.current || typeof map.project !== "function" || (!v && trk.length < 2)) {
      svg.style.display = "none";
      return;
    }
    try {
      const sinPitch = Math.sin((OBLIQUE_PITCH * Math.PI) / 180);
      // Screen pixels per ground metre at a given lat/lon (local scale).
      const pxPerMeterAt = (lat: number, lon: number, gx: number, gy: number) => {
        const north = map.project([lon, lat + 100 / 111320]);
        return Math.hypot(north.x - gx, north.y - gy) / 100;
      };
      svg.style.display = "";

      // ---- 3D track: ground projection (faint) + altitude posts +
      // the lifted path through each point's own altitude ----
      const tGround = ovTrackGroundRef.current;
      const tPosts = ovTrackPostsRef.current;
      const tAir = ovTrackAirRef.current;
      if (trk.length > 1 && tGround && tPosts && tAir) {
        let groundD = "";
        let airD = "";
        let postsD = "";
        trk.forEach((p, i) => {
          const g = map.project([p.lon, p.lat]);
          const lift = Math.min(
            600, Math.max(0, p.altM ?? 0) * pxPerMeterAt(p.lat, p.lon, g.x, g.y) * sinPitch,
          );
          const ax = g.x;
          const ay = g.y - lift;
          groundD += `${i === 0 ? "M" : "L"}${g.x.toFixed(1)},${g.y.toFixed(1)}`;
          airD += `${i === 0 ? "M" : "L"}${ax.toFixed(1)},${ay.toFixed(1)}`;
          // A post every ~15th point (and at the end) keeps the column
          // readable without turning the path into a fence.
          if (lift > 5 && (i % 15 === 0 || i === trk.length - 1)) {
            postsD += `M${g.x.toFixed(1)},${g.y.toFixed(1)}L${ax.toFixed(1)},${ay.toFixed(1)}`;
          }
        });
        tGround.setAttribute("d", groundD);
        tAir.setAttribute("d", airD);
        tPosts.setAttribute("d", postsD);
        tGround.style.display = "";
        tAir.style.display = "";
        tPosts.style.display = postsD ? "" : "none";
      } else {
        if (tGround) tGround.style.display = "none";
        if (tAir) tAir.style.display = "none";
        if (tPosts) tPosts.style.display = "none";
      }

      // ---- vehicle on its altitude post ----
      const setVehDisplay = (d: string) => {
        if (ovGroundRef.current) ovGroundRef.current.style.display = d;
        if (ovPostRef.current) ovPostRef.current.style.display = d;
        if (ovCraftRef.current) ovCraftRef.current.style.display = d;
        if (ovLabelRef.current) ovLabelRef.current.style.display = d;
      };
      if (!v) {
        setVehDisplay("none");
        return;
      }
      setVehDisplay("");
      const ground = map.project([v.lon, v.lat]);
      const pxPerMeter = pxPerMeterAt(v.lat, v.lon, ground.x, ground.y);
      const alt = Math.max(0, altRef.current ?? 0);
      const postPx = Math.min(500, alt * pxPerMeter * sinPitch);
      const top = { x: ground.x, y: ground.y - postPx };
      ovGroundRef.current?.setAttribute("cx", String(ground.x));
      ovGroundRef.current?.setAttribute("cy", String(ground.y));
      const post = ovPostRef.current;
      if (post) {
        post.setAttribute("x1", String(ground.x));
        post.setAttribute("y1", String(ground.y));
        post.setAttribute("x2", String(top.x));
        post.setAttribute("y2", String(top.y));
        post.style.display = postPx > 6 ? "" : "none";
      }
      const craft = ovCraftRef.current;
      if (craft) {
        craft.setAttribute(
          "points",
          `${top.x},${top.y - 15} ${top.x + 12},${top.y + 13} ${top.x},${top.y + 7} ${top.x - 12},${top.y + 13}`,
        );
        craft.setAttribute("transform", `rotate(${headingRef.current ?? 0} ${top.x} ${top.y})`);
      }
      const label = ovLabelRef.current;
      if (label) {
        label.setAttribute("x", String(top.x + 14));
        label.setAttribute("y", String(top.y - 6));
        label.textContent = `${alt.toFixed(1)} m`;
        label.style.display = postPx > 6 ? "" : "none";
      }
    } catch {
      svg.style.display = "none";
    }
  };
  const renderCbRef = useRef(() => {
    drawOverlayRef.current();
  });

  const clickCbRef = useRef((e: { lngLat?: { lat: number; lng: number } }) => {
    if (e.lngLat) onTapRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
  const dragCbRef = useRef(() => {
    // A user pan means "stop following me" (QGC behaves the same way).
    if (followRef.current) setFollow(false);
  });

  const detach = () => {
    const map = attachedMapRef.current;
    if (map) {
      try { map.off("click", clickCbRef.current); } catch { /* gone */ }
      try { map.off("dragstart", dragCbRef.current); } catch { /* gone */ }
      try { map.off("render", renderCbRef.current); } catch { /* gone */ }
    }
    if (overlayRef.current) overlayRef.current.style.display = "none";
    attachedMapRef.current = null;
    lastDataJsonRef.current = "";
    onTapReadyRef.current?.(false);
  };

  // ---- mount the vendored control (static places: home + target only;
  // in fallback mode the vehicle joins them as a coarse snapshot pin) ----
  useEffect(() => {
    if (!vehicle || unavailable) return;
    const cell = fallback
      ? [Math.round(vehicle.lat * 4444), Math.round(vehicle.lon * 4444)]
      : null;
    const sig = JSON.stringify({ t: target, h: home, fb: fallback, cell });
    if (sig === sigRef.current && handleRef.current) return;
    sigRef.current = sig;
    const el = holderRef.current;
    if (!el) return;
    detach();
    handleRef.current?.destroy();
    handleRef.current = null;
    const places: MapPlace[] = [];
    if (fallback) places.push({ label: "機体", lat: vehicle.lat, lng: vehicle.lon });
    if (home) places.push({ label: "ホーム", lat: home.lat, lng: home.lon });
    if (target) places.push({ label: "目標", lat: target.lat, lng: target.lon });
    const focus = target ?? vehicle;
    const handle = mountMap(
      el,
      {
        places,
        center: { lat: focus.lat, lng: focus.lon },
        zoom: target ? 16 : 17,
        baseStyle: "dark",
      },
      () => setUnavailable(true),
    );
    handleRef.current = handle;
    if (handle) mountAtRef.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, home, target, unavailable, fallback]);

  // ---- watchdog: discover the MapLibre instance, attach handlers and
  // the live source/layers, keep the live data fresh, and follow ----
  useEffect(() => {
    if (unavailable || fallback) return;
    const timer = setInterval(() => {
      const el = holderRef.current;
      if (!el || !handleRef.current) return;
      let map = attachedMapRef.current;
      if (!map) {
        map = findMapLibreInstance(el);
        if (!map) {
          if (mountAtRef.current && Date.now() - mountAtRef.current > 20000) {
            setFallback(true);
          }
          return;
        }
        try {
          map.on("click", clickCbRef.current);
          map.on("dragstart", dragCbRef.current);
          map.on("render", renderCbRef.current);
          if (obliqueRef.current) {
            try { map.setPitch?.(OBLIQUE_PITCH); } catch { /* style may cap pitch */ }
          }
          if (!map.hasImage(VEHICLE_IMAGE)) {
            const img = makeVehicleImage();
            if (img) map.addImage(VEHICLE_IMAGE, img, { pixelRatio: 2 });
          }
          if (!map.getSource(LIVE_SOURCE)) {
            map.addSource(LIVE_SOURCE, { type: "geojson", data: liveDataRef.current });
          }
          if (!map.getLayer(TRACK_LAYER)) {
            map.addLayer({
              id: TRACK_LAYER, type: "line", source: LIVE_SOURCE,
              filter: ["==", ["get", "kind"], "track"],
              layout: { "line-cap": "round", "line-join": "round" },
              paint: { "line-color": "#22d3ee", "line-width": 2.5, "line-opacity": 0.6 },
            });
          }
          if (!map.getLayer(VEHICLE_LAYER)) {
            map.addLayer({
              id: VEHICLE_LAYER, type: "symbol", source: LIVE_SOURCE,
              filter: ["==", ["get", "kind"], "vehicle"],
              layout: {
                "icon-image": VEHICLE_IMAGE,
                "icon-size": 0.55,
                "icon-rotate": ["get", "heading"],
                "icon-rotation-alignment": "map",
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            });
          }
        } catch {
          // Style not fully loaded yet; retry on the next tick without
          // marking the map as attached.
          try { map.off("click", clickCbRef.current); } catch { /* ignore */ }
          try { map.off("render", renderCbRef.current); } catch { /* ignore */ }
          return;
        }
        attachedMapRef.current = map;
        onTapReadyRef.current?.(true);
      }
      // Self-heal: a style reload (tile/style refetch, network hiccup)
      // silently drops our source, layers and icon image while the map
      // instance itself survives. Without this check the watchdog kept
      // calling setData on a missing source (a no-op) and the vehicle
      // marker/track never came back — the map looked frozen for the
      // rest of the session even though telemetry kept flowing.
      try {
        if (!map.getSource(LIVE_SOURCE)) {
          if (!map.hasImage(VEHICLE_IMAGE)) {
            const img = makeVehicleImage();
            if (img) map.addImage(VEHICLE_IMAGE, img, { pixelRatio: 2 });
          }
          map.addSource(LIVE_SOURCE, { type: "geojson", data: liveDataRef.current });
          lastDataJsonRef.current = "";
        }
        if (!map.getLayer(TRACK_LAYER)) {
          map.addLayer({
            id: TRACK_LAYER, type: "line", source: LIVE_SOURCE,
            filter: ["==", ["get", "kind"], "track"],
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#22d3ee", "line-width": 2.5, "line-opacity": 0.6 },
          });
        }
        if (!map.getLayer(VEHICLE_LAYER)) {
          map.addLayer({
            id: VEHICLE_LAYER, type: "symbol", source: LIVE_SOURCE,
            filter: ["==", ["get", "kind"], "vehicle"],
            layout: {
              "icon-image": VEHICLE_IMAGE,
              "icon-size": 0.55,
              "icon-rotate": ["get", "heading"],
              "icon-rotation-alignment": "map",
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
          });
        }
      } catch { /* style mid-reload; next tick retries */ }
      // Push fresh geometry whenever it changed.
      const data = liveDataRef.current;
      const json = JSON.stringify(data);
      if (json !== lastDataJsonRef.current) {
        lastDataJsonRef.current = json;
        try {
          map.getSource(LIVE_SOURCE)?.setData(data);
        } catch { /* style reloading; next tick retries */ }
      }
      // Follow: re-center smoothly once the vehicle drifts from center.
      const v = vehicleRef.current;
      if (v && followRef.current) {
        try {
          const c = map.getCenter();
          if (haversineM({ lat: c.lat, lon: c.lng }, v) > 12) {
            map.easeTo({ center: [v.lon, v.lat], duration: 500 });
          }
        } catch { /* map mid-teardown */ }
      }
    }, 400);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unavailable, fallback]);

  // Redraw the oblique overlay (3D track + vehicle post) whenever its
  // inputs change (map render events cover camera motion between
  // telemetry updates).
  useEffect(() => {
    drawOverlayRef.current();
  }, [vehicle, headingDeg, altRelM, oblique, track]);

  const toggleOblique = () => {
    const next = !oblique;
    setOblique(next);
    const map = attachedMapRef.current;
    if (map) {
      try { map.easeTo({ pitch: next ? OBLIQUE_PITCH : 0, duration: 600 }); } catch { /* ignore */ }
    }
    if (!next && overlayRef.current) overlayRef.current.style.display = "none";
  };

  // "機体にセンタリング" (and any recenter request): follow on + jump now.
  useEffect(() => {
    if (recenterSignal === 0) return;
    setFollow(true);
    const map = attachedMapRef.current;
    const v = vehicleRef.current;
    if (map && v) {
      try { map.easeTo({ center: [v.lon, v.lat], duration: 500 }); } catch { /* ignore */ }
    }
  }, [recenterSignal]);

  useEffect(() => () => {
    detach();
    handleRef.current?.destroy();
    handleRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (unavailable) {
    return (
      <div className="flex h-full min-h-[150px] flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-sm">地図を表示できません</div>
        <div className="mono text-xs" style={{ color: "var(--dim)" }}>
          {vehicle
            ? `機体位置: ${vehicle.lat.toFixed(6)}, ${vehicle.lon.toFixed(6)}`
            : "機体位置: 未取得"}
        </div>
        <div className="max-w-sm text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
          目標地点は Goto タブの緯度・経度入力、または「現在位置を入力」「ホームを入力」ボタンで指定できます。
        </div>
      </div>
    );
  }
  if (!vehicle) {
    return (
      <div className="flex h-full min-h-[150px] flex-col items-center justify-center gap-2 p-4 text-center">
        <div className="text-sm" style={{ color: "var(--dim)" }}>
          GPS測位を待っています…
        </div>
        <div className="text-xs" style={{ color: "var(--dim)" }}>
          位置が取得できると地図に機体・ホーム・目標が表示されます
        </div>
      </div>
    );
  }
  return (
    <div className="relative h-full">
      <div ref={holderRef} className="map-holder" aria-label="機体位置の地図" />
      {/* oblique-view overlay: the 3D track (ground projection + altitude
          posts + the lifted path) and the vehicle floating on its own
          altitude post above its ground projection */}
      <svg
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ display: "none", zIndex: 4 }}
        aria-hidden="true"
      >
        <path
          ref={ovTrackGroundRef} fill="none" stroke="var(--accent)"
          strokeWidth="1" strokeDasharray="3 4" opacity="0.35"
        />
        <path
          ref={ovTrackPostsRef} fill="none" stroke="var(--accent)"
          strokeWidth="1" opacity="0.45"
        />
        <path
          ref={ovTrackAirRef} fill="none" stroke="var(--accent)"
          strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" opacity="0.95"
        />
        <line
          ref={ovPostRef} stroke="var(--accent)" strokeWidth="1.5"
          strokeDasharray="4 3" opacity="0.9"
        />
        <ellipse
          ref={ovGroundRef} rx="12" ry="5"
          fill="rgba(0,0,0,0.4)" stroke="var(--accent)" strokeWidth="1.2"
        />
        <polygon
          ref={ovCraftRef} points="0,-15 12,13 0,7 -12,13"
          fill="#22d3ee" stroke="#0b1116" strokeWidth="1.5" strokeLinejoin="round"
        />
        <text
          ref={ovLabelRef} fontSize="11" fill="#22d3ee"
          style={{ paintOrder: "stroke", stroke: "rgba(11,17,22,0.85)", strokeWidth: 3 }}
        />
      </svg>
      {!fallback && (
        <button
          type="button"
          className={`btn absolute bottom-2 right-2 !px-2 !py-1 text-[11px] ${oblique ? "active" : ""}`}
          style={{ background: "rgba(13,21,28,0.92)", zIndex: 5 }}
          aria-pressed={oblique}
          aria-label="斜めビュー（ピッチ表示）の切り替え"
          onClick={toggleOblique}
        >
          {oblique ? "斜めビュー中（3D軌跡・高度ポスト）" : "斜めビュー"}
        </button>
      )}
      <button
        type="button"
        className={`btn absolute bottom-2 left-2 !px-2 !py-1 text-[11px] ${follow ? "active" : ""}`}
        style={{ background: "rgba(13,21,28,0.92)", zIndex: 5 }}
        aria-pressed={follow}
        aria-label="機体追従の切り替え"
        onClick={() => {
          const next = !follow;
          setFollow(next);
          if (next) {
            const map = attachedMapRef.current;
            const v = vehicleRef.current;
            if (map && v) {
              try { map.easeTo({ center: [v.lon, v.lat], duration: 500 }); } catch { /* ignore */ }
            }
          }
        }}
      >
        {follow ? "追従中（タップで解除）" : "機体を追従"}
      </button>
      {fallback && (
        <div
          className="mono pointer-events-none absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-[10px]"
          style={{ background: "rgba(11,17,22,0.75)", color: "var(--dim)" }}
        >
          ピン更新モード
        </div>
      )}
    </div>
  );
}
