// WebGL-free 2D fallback map, used only when the bundled MapLibre
// control cannot initialize on this device. On the user's PC the GL
// context creation itself fails at the driver level (chrome://gpu log:
// "eglCreateContext: Requested version is not supported", AMD Radeon
// driver 31.0.12014.6 via ANGLE/D3D11, logged at the exact moment the
// map was tried) — the runtime's generic WebGL probe can pass while
// MapLibre's real context request fails, so the parent judges by the
// actual initialization result and lands here. This component needs no
// WebGL at all: real raster tiles as <img> elements (the same Bing tile
// templates the map runtime's own bing-hybrid / bing-aerial presets
// use), with the vehicle, track, home and target drawn as DOM/SVG
// overlays in Web-Mercator screen space.
//
// Gestures: one-pointer drag pans, tap sets the Goto target, wheel and
// buttons zoom — and two-pointer pinch zooms (continuous, fractional
// zoom) and rotates (the map north turns with the fingers; tiles,
// track, pins and the vehicle marker all rotate together because every
// screen position goes through the same rotated world->screen
// projection). A compass button appears while the map is rotated and
// resets north-up.
//
// Oblique view in 2D mode: a real GL pitch is impossible here, so the
// oblique toggle applies the same geometry the GL overlay uses, in
// pure 2D math. The ground plane is foreshortened along the screen's
// vertical axis by cos(55°) — every world->screen projection (tiles,
// pins, track, vehicle ground point, tap/gesture inverses) goes
// through that one affine transform, so the whole sheet tilts as one
// piece — and altitude becomes vertical screen lift: each track point
// and the vehicle are drawn at ground − alt × px-per-metre × sin(55°),
// with a faint dashed ground projection, vertical posts, and the
// vehicle floating on its altitude post with a ground shadow ellipse,
// mirroring MapPanel's GL oblique overlay.

import { useEffect, useRef, useState } from "react";
import type { LatLon, MissionPoint, TrackPoint } from "./MapPanel";

interface TileMap2DProps {
  vehicle: LatLon | null;
  headingDeg: number | null;
  altRelM: number | null;
  home: LatLon | null;
  target: LatLon | null;
  track: TrackPoint[];
  recenterSignal: number;
  onTap?: (p: LatLon) => void;
  onTapReady?: (ready: boolean) => void;
  onTilesFailed?: () => void;
  missionPoints?: MissionPoint[];
  missionSelected?: number | null;
  onMissionPointMove?: (index: number, p: LatLon) => void;
  onMissionPointSelect?: (index: number) => void;
}

const TILE = 256;
const MIN_ZOOM = 3;
const MAX_ZOOM = 19;
// Oblique view geometry, matching MapPanel's GL oblique view: pitch
// 55°, the ground plane foreshortens by cos(pitch) along the view axis
// and altitude lifts by sin(pitch).
const OBLIQUE_PITCH = 55;
const OBLIQUE_COS = Math.cos((OBLIQUE_PITCH * Math.PI) / 180);
const OBLIQUE_SIN = Math.sin((OBLIQUE_PITCH * Math.PI) / 180);

function project(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const world = TILE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * world,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world,
  };
}

function unproject(x: number, y: number, zoom: number): LatLon {
  const world = TILE * 2 ** zoom;
  const lon = (x / world) * 360 - 180;
  const n = Math.PI * (1 - (2 * y) / world);
  const lat = (Math.atan(Math.sinh(n)) * 180) / Math.PI;
  return { lat, lon };
}

function quadkey(tx: number, ty: number, zoom: number): string {
  let key = "";
  for (let i = zoom; i > 0; i--) {
    const bit = 2 ** (i - 1);
    let digit = 0;
    if ((tx & bit) !== 0) digit += 1;
    if ((ty & bit) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}

function tileUrl(tx: number, ty: number, zoom: number, aerial: boolean): string {
  const kind = aerial ? "a" : "h";
  return `https://t${(tx + ty) % 4}.tiles.virtualearth.net/tiles/${kind}${quadkey(tx, ty, zoom)}.jpeg?g=587&mkt=en-gb&n=z`;
}

// Rotate a screen-space offset by `deg` degrees CLOCKWISE as seen on
// screen (y axis points down): east (1,0) turns toward south (0,1).
function rot(x: number, y: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: c * x - s * y, y: s * x + c * y };
}

function normDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

interface GestureStart {
  dist: number;
  angleDeg: number;
  zoom: number;
  rotation: number;
  // World point (at `zoom`) that sat under the fingers' midpoint when
  // the gesture started; it stays glued to the midpoint while pinching.
  anchorWorld: { x: number; y: number };
}

export function TileMap2D({
  vehicle, headingDeg, altRelM, home, target, track, recenterSignal, onTap, onTapReady, onTilesFailed,
  missionPoints, missionSelected, onMissionPointMove, onMissionPointSelect,
}: TileMap2DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [center, setCenter] = useState<LatLon | null>(null);
  // Fractional: pinch zoom is continuous; the tile layer renders an
  // integer tile zoom scaled by 2^(zoom - tileZoom).
  const [zoom, setZoom] = useState(17);
  // Display rotation in degrees, clockwise on screen (0 = north up).
  const [rotation, setRotation] = useState(0);
  // Oblique view (pseudo-pitch, see the header comment): the ground
  // plane foreshortens by OBLIQUE_COS and altitude lifts by
  // OBLIQUE_SIN. kRef mirrors the active foreshortening factor for
  // the gesture handlers, which read refs rather than state.
  const [oblique, setOblique] = useState(false);
  const obliqueRef = useRef(false);
  obliqueRef.current = oblique;
  const kRef = useRef(1);
  kRef.current = oblique ? OBLIQUE_COS : 1;
  const [aerial, setAerial] = useState(false);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  const centerRef = useRef(center);
  centerRef.current = center;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const rotationRef = useRef(rotation);
  rotationRef.current = rotation;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const dragRef = useRef<{
    pointerId: number; startX: number; startY: number; moved: boolean;
  } | null>(null);
  // All active pointers (client coords), for pinch / rotate gestures.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<GestureStart | null>(null);
  // True from the moment a second pointer lands until every pointer is
  // up again, so a pinch never ends as a tap or a pan commit.
  const pinchedRef = useRef(false);
  // Active mission-marker drag (the marker captures its own pointer and
  // stops propagation, so the container pan/pinch never sees it).
  const wpDragRef = useRef<{ index: number; pointerId: number } | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;
  const onTilesFailedRef = useRef(onTilesFailed);
  onTilesFailedRef.current = onTilesFailed;
  const tileOkRef = useRef(0);
  const tileErrRef = useRef(0);
  const tileFailedSentRef = useRef(false);

  // Container size (tiles are laid out to cover it exactly).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Initial center: the vehicle (or home) as soon as we know it.
  useEffect(() => {
    if (center === null) {
      const c = vehicle ?? home;
      if (c) setCenter(c);
    }
  }, [center, vehicle, home]);

  // Tap-to-Goto is available immediately in this mode.
  useEffect(() => {
    onTapReady?.(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow: re-centre once the vehicle drifts well off the middle.
  useEffect(() => {
    if (!vehicle || !center || !follow || size.w === 0) return;
    const c = project(center.lat, center.lon, zoom);
    const v = project(vehicle.lat, vehicle.lon, zoom);
    if (Math.abs(v.x - c.x) > size.w * 0.3 || Math.abs(v.y - c.y) > size.h * 0.3) {
      setCenter(vehicle);
    }
  }, [vehicle, center, follow, zoom, size]);

  // "機体にセンタリング" (and any recenter request): follow on + jump now.
  useEffect(() => {
    if (recenterSignal === 0) return;
    setFollow(true);
    if (vehicle) setCenter(vehicle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterSignal]);

  // If no tile ever loads and several fail, the tile host is unreachable
  // from this device too — tell the parent to show the text fallback.
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        !tileFailedSentRef.current &&
        tileOkRef.current === 0 &&
        tileErrRef.current >= 4
      ) {
        tileFailedSentRef.current = true;
        onTilesFailedRef.current?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Wheel zoom (needs a non-passive listener to prevent page scroll).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + (e.deltaY < 0 ? 1 : -1))));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (!center || size.w === 0 || size.h === 0) {
    // No placeholder copy while the first tiles are on their way; the
    // empty panel is the loading state.
    return <div ref={containerRef} className="relative h-full w-full overflow-hidden" />;
  }

  // ---- world <-> screen projection (rotation- and oblique-aware) ----
  // World px are at the current (fractional) zoom, where 1 world px is
  // 1 screen px before rotation/foreshortening. The oblique factor k
  // compresses the rotated vertical axis (k = cos(pitch) in oblique
  // view, 1 flat); screenToWorld divides it back out, so taps, pans
  // and pinch anchors stay glued to the ground in both views. The
  // drag offset is applied by callers on top of these results.
  const k = oblique ? OBLIQUE_COS : 1;
  const cPx = project(center.lat, center.lon, zoom);
  const worldToScreen = (wx: number, wy: number): { x: number; y: number } => {
    const r = rot(wx - cPx.x, wy - cPx.y, rotation);
    return { x: size.w / 2 + r.x, y: size.h / 2 + r.y * k };
  };
  const screenToWorld = (sx: number, sy: number): { x: number; y: number } => {
    const r = rot(sx - size.w / 2, (sy - size.h / 2) / k, -rotation);
    return { x: cPx.x + r.x, y: cPx.y + r.y };
  };
  // Screen-space lift (px) for an altitude at a given latitude: the
  // local Mercator scale (world px per metre, measured northward like
  // MapPanel's GL overlay) times sin(pitch) — zero in the flat view.
  const liftPx = (lat: number, lon: number, altM: number): number => {
    if (!oblique || altM <= 0) return 0;
    const a = project(lat, lon, zoom);
    const b = project(lat + 100 / 111320, lon, zoom);
    const pxPerMeter = Math.abs(b.y - a.y) / 100;
    return Math.min(600, altM * pxPerMeter * OBLIQUE_SIN);
  };
  const toScreen = (p: LatLon): { x: number; y: number } => {
    const w = project(p.lat, p.lon, zoom);
    const s = worldToScreen(w.x, w.y);
    return { x: s.x + drag.dx, y: s.y + drag.dy };
  };

  // ---- tile coverage: bounding box of the rotated viewport ----
  const tileZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
  const tileScale = 2 ** (zoom - tileZoom); // world px per tile-zoom px
  const tileWorld = TILE * tileScale; // tile edge length in world px
  const maxTile = 2 ** tileZoom - 1;
  const corners = [
    screenToWorld(0, 0),
    screenToWorld(size.w, 0),
    screenToWorld(0, size.h),
    screenToWorld(size.w, size.h),
  ];
  const minWx = Math.min(...corners.map((c) => c.x));
  const maxWx = Math.max(...corners.map((c) => c.x));
  const minWy = Math.min(...corners.map((c) => c.y));
  const maxWy = Math.max(...corners.map((c) => c.y));
  const tx0 = Math.max(0, Math.floor(minWx / tileWorld));
  const tx1 = Math.min(maxTile, Math.floor(maxWx / tileWorld));
  const ty0 = Math.max(0, Math.floor(minWy / tileWorld));
  const ty1 = Math.min(maxTile, Math.floor(maxWy / tileWorld));
  const tiles: { key: string; url: string; x: number; y: number }[] = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const s = worldToScreen(tx * tileWorld, ty * tileWorld);
      tiles.push({
        key: `${tileZoom}-${tx}-${ty}-${aerial ? "a" : "h"}`,
        url: tileUrl(tx, ty, tileZoom, aerial),
        x: s.x,
        y: s.y,
      });
    }
  }

  const inView = (s: { x: number; y: number }, m = 60) =>
    s.x > -m && s.y > -m && s.x < size.w + m && s.y < size.h + m;

  // Track geometry: each point's ground projection plus, in oblique
  // view, its altitude-lifted twin (the pair is filtered together so
  // the two polylines always describe the same points).
  const trackPts = track
    .map((p) => {
      const g = toScreen(p);
      const lift = liftPx(p.lat, p.lon, p.altM ?? 0);
      return { g, a: { x: g.x, y: g.y - lift }, lift };
    })
    .filter(({ g }) => inView(g, 400));
  const trackLine = trackPts.map(({ g }) => `${g.x.toFixed(1)},${g.y.toFixed(1)}`).join(" ");
  const trackAirLine = trackPts.map(({ a }) => `${a.x.toFixed(1)},${a.y.toFixed(1)}`).join(" ");
  const trackPosts = trackPts.filter(
    (t, i) => t.lift > 5 && (i % 15 === 0 || i === trackPts.length - 1),
  );
  // Vehicle: ground projection and (oblique) lifted position.
  const vehGround = vehicle ? toScreen(vehicle) : null;
  const vehLift = vehicle ? liftPx(vehicle.lat, vehicle.lon, altRelM ?? 0) : 0;
  const vehS = vehGround ? { x: vehGround.x, y: vehGround.y - vehLift } : null;
  const homeS = home ? toScreen(home) : null;
  const tgtS = target ? toScreen(target) : null;
  // Mission editor overlay: the route line through the points (in
  // editor order) plus numbered, draggable markers.
  const missionPts = (missionPoints ?? []).map((p) => ({ p, s: toScreen(p) }));
  const missionLine = missionPts.map(({ s }) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`).join(" ");

  const pin = (s: { x: number; y: number }, color: string, label: string) => (
    <div
      className="pointer-events-none absolute"
      style={{ left: s.x, top: s.y, transform: "translate(-50%, -100%)", zIndex: 3 }}
    >
      <div
        style={{
          width: 14, height: 14, margin: "0 auto",
          borderRadius: "50% 50% 50% 0",
          transform: "rotate(-45deg)",
          background: color, border: "2px solid #0b1116",
        }}
      />
      <div
        className="mono mt-0.5 whitespace-nowrap text-center text-[10px]"
        style={{ color, textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
      >
        {label}
      </div>
    </div>
  );

  // ---- gesture helpers ----
  const pointerPair = (): [{ x: number; y: number }, { x: number; y: number }] | null => {
    const pts = [...pointersRef.current.values()];
    const a = pts[0];
    const b = pts[1];
    return a && b ? [a, b] : null;
  };
  const pairMetrics = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    dist: Math.hypot(b.x - a.x, b.y - a.y),
    // atan2 with y down measures clockwise on screen — the direction
    // the fingers visually turn.
    angleDeg: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  });

  const startGesture = () => {
    const pair = pointerPair();
    const ctr = centerRef.current;
    const sz = sizeRef.current;
    if (!pair || !ctr || sz.w === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const m = pairMetrics(pair[0], pair[1]);
    const midScreen = { x: m.mid.x - rect.left, y: m.mid.y - rect.top };
    const z = zoomRef.current;
    const cw = project(ctr.lat, ctr.lon, z);
    const off = rot(midScreen.x - sz.w / 2, (midScreen.y - sz.h / 2) / kRef.current, -rotationRef.current);
    gestureRef.current = {
      dist: Math.max(10, m.dist),
      angleDeg: m.angleDeg,
      zoom: z,
      rotation: rotationRef.current,
      anchorWorld: { x: cw.x + off.x, y: cw.y + off.y },
    };
  };

  const applyGesture = () => {
    const g = gestureRef.current;
    const pair = pointerPair();
    const sz = sizeRef.current;
    if (!g || !pair || sz.w === 0) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const m = pairMetrics(pair[0], pair[1]);
    const newZoom = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, g.zoom + Math.log2(Math.max(10, m.dist) / g.dist)),
    );
    const newRotation = normDeg(g.rotation + normDeg(m.angleDeg - g.angleDeg));
    // The anchored world point (rescaled to the new zoom) must land
    // exactly under the current midpoint.
    const sf = 2 ** (newZoom - g.zoom);
    const anchor = { x: g.anchorWorld.x * sf, y: g.anchorWorld.y * sf };
    const midScreen = { x: m.mid.x - rect.left, y: m.mid.y - rect.top };
    const off = rot(midScreen.x - sz.w / 2, (midScreen.y - sz.h / 2) / kRef.current, -newRotation);
    const newCenterWorld = { x: anchor.x - off.x, y: anchor.y - off.y };
    setZoom(newZoom);
    setRotation(newRotation);
    setCenter(unproject(newCenterWorld.x, newCenterWorld.y, newZoom));
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{ touchAction: "none", background: "#0d151c", cursor: "grab" }}
      role="application"
      aria-label="機体位置の2D地図（WebGL不要のフォールバック表示）"
      onPointerDown={(e) => {
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        if (followRef.current) setFollow(false);
        if (pointersRef.current.size === 1) {
          dragRef.current = {
            pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false,
          };
        } else if (pointersRef.current.size === 2) {
          // Second finger: cancel any pan in progress and snapshot the
          // pinch/rotate gesture from the current view state.
          pinchedRef.current = true;
          dragRef.current = null;
          setDrag({ dx: 0, dy: 0 });
          startGesture();
        }
      }}
      onPointerMove={(e) => {
        if (!pointersRef.current.has(e.pointerId)) return;
        pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointersRef.current.size >= 2) {
          applyGesture();
          return;
        }
        const d = dragRef.current;
        if (!d || d.pointerId !== e.pointerId) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
        if (d.moved) setDrag({ dx, dy });
      }}
      onPointerUp={(e) => {
        const wasPinch = pinchedRef.current;
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size === 1) {
          // One finger remains after a pinch: re-anchor a fresh pan on
          // it (marked moved, so lifting it fires neither tap nor pan).
          const rest = [...pointersRef.current.entries()][0];
          if (rest) {
            dragRef.current = {
              pointerId: rest[0], startX: rest[1].x, startY: rest[1].y, moved: true,
            };
          }
          gestureRef.current = null;
          return;
        }
        if (pointersRef.current.size > 0) return;
        pinchedRef.current = false;
        gestureRef.current = null;
        const d = dragRef.current;
        dragRef.current = null;
        if (!d || wasPinch) return;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        if (d.moved) {
          // Commit the pan: the world point under the centre shifts by
          // the drag distance, back through the oblique foreshortening
          // and the display rotation.
          const back = rot(drag.dx, drag.dy / k, -rotation);
          const next = unproject(cPx.x - back.x, cPx.y - back.y, zoom);
          setCenter(next);
          setDrag({ dx: 0, dy: 0 });
        } else if (onTapRef.current) {
          const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
          onTapRef.current(unproject(w.x, w.y, zoom));
        }
      }}
      onPointerCancel={(e) => {
        pointersRef.current.delete(e.pointerId);
        if (pointersRef.current.size === 0) {
          pinchedRef.current = false;
          gestureRef.current = null;
          dragRef.current = null;
          setDrag({ dx: 0, dy: 0 });
        } else if (pointersRef.current.size === 1) {
          const rest = [...pointersRef.current.entries()][0];
          if (rest) {
            dragRef.current = {
              pointerId: rest[0], startX: rest[1].x, startY: rest[1].y, moved: true,
            };
          }
          gestureRef.current = null;
        }
      }}
    >
      {/* tiles: each is placed at its projected screen position and
          transformed around its own top-left corner by the same
          affine map the projection uses — rotation, plus the
          oblique view's vertical foreshortening (matrix with
          a=cosR, b=k·sinR, c=−sinR, d=k·cosR; k=1 flat, where this
          is exactly the old plain rotation) — so the whole sheet
          (and every overlay computed through the same projection)
          turns and tilts as one piece */}
      <div className="absolute inset-0">
        {tiles.map((t) => (
          <img
            key={t.key}
            src={t.url}
            alt=""
            draggable={false}
            width={tileWorld}
            height={tileWorld}
            style={{
              position: "absolute", left: 0, top: 0, display: "block",
              transform: `translate(${t.x + drag.dx}px, ${t.y + drag.dy}px) matrix(${Math.cos((rotation * Math.PI) / 180)}, ${(k * Math.sin((rotation * Math.PI) / 180)).toFixed(5)}, ${(-Math.sin((rotation * Math.PI) / 180)).toFixed(5)}, ${(k * Math.cos((rotation * Math.PI) / 180)).toFixed(5)}, 0, 0)`,
              transformOrigin: "0 0",
            }}
            onLoad={() => { tileOkRef.current += 1; }}
            onError={() => { tileErrRef.current += 1; }}
          />
        ))}
        {(trackPts.length > 1 || (oblique && vehGround) || missionPts.length > 1) && (
          <svg
            className="pointer-events-none absolute inset-0"
            width={size.w}
            height={size.h}
            aria-hidden="true"
            style={{ zIndex: 2 }}
          >
            {missionPts.length > 1 && (
              <polyline
                points={missionLine} fill="none" stroke="#f5b83d"
                strokeWidth="2" strokeDasharray="6 4" strokeLinejoin="round"
                strokeLinecap="round" opacity="0.9"
              />
            )}
            {/* oblique 3D track: faint dashed ground projection,
                altitude posts, then the lifted path (the flat view
                draws just the ground line, as before) */}
            {oblique && trackPts.length > 1 && (
              <polyline
                points={trackLine} fill="none" stroke="#22d3ee"
                strokeWidth="1" strokeDasharray="3 4" opacity="0.35"
              />
            )}
            {oblique && trackPosts.map((t, i) => (
              <line
                key={i}
                x1={t.g.x} y1={t.g.y} x2={t.a.x} y2={t.a.y}
                stroke="#22d3ee" strokeWidth="1" opacity="0.45"
              />
            ))}
            {trackPts.length > 1 && (
              <polyline
                points={oblique ? trackAirLine : trackLine} fill="none" stroke="#22d3ee"
                strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"
                opacity={oblique ? 0.95 : 0.65}
              />
            )}
            {/* vehicle altitude post + ground shadow (oblique only) */}
            {oblique && vehGround && vehLift > 6 && (
              <>
                <line
                  x1={vehGround.x} y1={vehGround.y} x2={vehGround.x} y2={vehGround.y - vehLift}
                  stroke="#22d3ee" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.9"
                />
                <ellipse
                  cx={vehGround.x} cy={vehGround.y} rx="12" ry={5 * k}
                  fill="rgba(0,0,0,0.4)" stroke="#22d3ee" strokeWidth="1.2"
                />
              </>
            )}
          </svg>
        )}
        {homeS && inView(homeS) && pin(homeS, "#3ddc84", "ホーム")}
        {tgtS && inView(tgtS) && pin(tgtS, "#f5b83d", "目標")}
        {missionPts.map(({ p, s }) => {
          if (!inView(s)) return null;
          const selected = missionSelected != null && missionSelected === p.index;
          return (
            <div
              key={p.index}
              role="button"
              aria-label={`ウェイポイント ${p.label}（ドラッグで移動）`}
              className="mono absolute flex items-center justify-center rounded-full text-[12px] font-bold"
              style={{
                left: s.x, top: s.y, width: 24, height: 24,
                transform: "translate(-50%, -50%)",
                background: "rgba(245,184,61,0.92)", color: "#0b1116",
                border: `2px solid ${selected ? "#ffffff" : "#0b1116"}`,
                boxShadow: "0 2px 8px rgba(0,0,0,0.55)",
                zIndex: selected ? 6 : 5, cursor: "grab", touchAction: "none",
                userSelect: "none", WebkitUserSelect: "none",
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
                wpDragRef.current = { index: p.index, pointerId: e.pointerId };
                onMissionPointSelect?.(p.index);
              }}
              onPointerMove={(e) => {
                const d = wpDragRef.current;
                if (!d || d.pointerId !== e.pointerId) return;
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                const w = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
                onMissionPointMove?.(d.index, unproject(w.x, w.y, zoom));
              }}
              onPointerUp={(e) => {
                e.stopPropagation();
                if (wpDragRef.current?.pointerId === e.pointerId) wpDragRef.current = null;
              }}
              onPointerCancel={(e) => {
                if (wpDragRef.current?.pointerId === e.pointerId) wpDragRef.current = null;
              }}
            >
              {p.label}
            </div>
          );
        })}
        {vehS && inView(vehS) && (
          <div
            className="pointer-events-none absolute"
            style={{ left: vehS.x, top: vehS.y, transform: "translate(-50%, -50%)", zIndex: 4 }}
          >
            <svg
              width="34" height="34" viewBox="0 0 96 96" aria-hidden="true"
              style={{ transform: `rotate(${(headingDeg ?? 0) + rotation}deg)`, display: "block" }}
            >
              <path
                d="M48 8 L84 84 L48 66 L12 84 Z"
                fill="#22d3ee" stroke="#0b1116" strokeWidth="6" strokeLinejoin="round"
              />
            </svg>
            {altRelM != null && (
              <div
                className="mono absolute whitespace-nowrap text-[10px]"
                style={{ left: 20, top: -4, color: "#22d3ee", textShadow: "0 1px 3px rgba(0,0,0,0.9)" }}
              >
                {altRelM.toFixed(1)} m
              </div>
            )}
          </div>
        )}
      </div>

      {/* basemap flavour: hybrid (aerial + baked-in labels) or pure aerial */}
      <div
        className="absolute left-2 top-2 flex overflow-hidden"
        style={{ zIndex: 5, border: "1px solid var(--border)", borderRadius: 8, background: "rgba(13,21,28,0.92)" }}
        role="group"
        aria-label="2D地図の種類"
      >
        <button
          type="button"
          className="!px-2 !py-1 text-[11px]"
          style={{
            background: !aerial ? "rgba(34,211,238,0.14)" : "transparent",
            color: !aerial ? "var(--accent)" : "var(--text)",
            border: "none", cursor: "pointer",
          }}
          aria-pressed={!aerial}
          aria-label="ラベル付き航空写真"
          onClick={() => setAerial(false)}
        >
          地図
        </button>
        <button
          type="button"
          className="!px-2 !py-1 text-[11px]"
          style={{
            background: aerial ? "rgba(34,211,238,0.14)" : "transparent",
            color: aerial ? "var(--accent)" : "var(--text)",
            border: "none", borderLeft: "1px solid var(--border)", cursor: "pointer",
          }}
          aria-pressed={aerial}
          aria-label="航空写真のみ"
          onClick={() => setAerial(true)}
        >
          航空写真
        </button>
      </div>

      {/* zoom controls — sits below the app-level 機体にセンタリング
          button (also top-right), which it used to overlap on phones */}
      <div
        className="absolute right-2 top-11 flex flex-col overflow-hidden"
        style={{ zIndex: 5, border: "1px solid var(--border)", borderRadius: 8, background: "rgba(13,21,28,0.92)" }}
        role="group"
        aria-label="2D地図のズーム"
      >
        <button
          type="button"
          className="!px-2 !py-1 text-sm"
          style={{ background: "transparent", color: "var(--text)", border: "none", cursor: "pointer" }}
          aria-label="拡大"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 1))}
        >
          ＋
        </button>
        <button
          type="button"
          className="!px-2 !py-1 text-sm"
          style={{ background: "transparent", color: "var(--text)", border: "none", borderTop: "1px solid var(--border)", cursor: "pointer" }}
          aria-label="縮小"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 1))}
        >
          －
        </button>
      </div>

      {/* compass / north reset: appears only while the map is rotated */}
      {Math.abs(rotation) > 0.5 && (
        <button
          type="button"
          className="btn absolute right-2 top-[6.75rem] !px-2 !py-1 text-[11px]"
          style={{ background: "rgba(13,21,28,0.92)", zIndex: 5 }}
          aria-label="北を上に戻す（地図の回転をリセット）"
          onClick={() => setRotation(0)}
        >
          <span
            aria-hidden="true"
            style={{ display: "inline-block", transform: `rotate(${rotation}deg)`, marginRight: 4 }}
          >
            ↑
          </span>
          北を上に戻す
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
          if (next && vehicle) setCenter(vehicle);
        }}
      >
        {follow ? "追従中（タップで解除）" : "機体を追従"}
      </button>
      {/* Oblique view in 2D mode: a pseudo-pitch rendered without
          WebGL — the ground plane foreshortens and the track/vehicle
          lift by altitude on posts (see the header comment). Same
          spot and labels as the GL view's toggle. */}
      <button
        type="button"
        className={`btn absolute bottom-2 right-2 !px-2 !py-1 text-[11px] ${oblique ? "active" : ""}`}
        style={{ background: "rgba(13,21,28,0.92)", zIndex: 5 }}
        aria-pressed={oblique}
        aria-label="斜めビュー（ピッチ表示）の切り替え"
        onClick={() => setOblique((o) => !o)}
      >
        {oblique ? "斜めビュー中（3D軌跡・高度ポスト）" : "斜めビュー"}
      </button>
      <div
        className="mono pointer-events-none absolute bottom-10 right-2 rounded px-1.5 py-0.5 text-[10px]"
        style={{ background: "rgba(11,17,22,0.75)", color: "var(--dim)", zIndex: 5 }}
      >
        2D地図モード · © Microsoft Corporation
      </div>
    </div>
  );
}
