import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { Hud } from "./Hud";
import { MapPanel, type LatLon } from "./MapPanel";
import { Stick } from "./Joystick";

type Status = ApiResponse<typeof api, "getStatus">;
type TabId = "fly" | "goto" | "stick" | "telemetry" | "log";

const TABS: { id: TabId; label: string }[] = [
  { id: "fly", label: "飛行" },
  { id: "goto", label: "Goto" },
  { id: "stick", label: "スティック" },
  { id: "telemetry", label: "テレメトリ" },
  { id: "log", label: "ログ・接続" },
];
// Modes in which ArduCopter actually applies MANUAL_CONTROL / pilot
// stick input. In GUIDED / AUTO / RTL / LAND etc. the vehicle flies its
// own navigation and stick input is silently ignored — the classic
// "スティック操作しても動かない" trap after a GUIDED takeoff.
const STICK_EFFECTIVE_MODES = [
  "STABILIZE", "ACRO", "ALT_HOLD", "LOITER", "POSHOLD", "DRIFT", "SPORT", "FLOWHOLD",
];
const TAKEOFF_ALT_PRESETS = [2, 5, 10, 15, 20, 30, 50];
const GOTO_ALT_PRESETS = [5, 10, 15, 20, 30, 50, 80];
const FIX_TEXT = ["NO GPS", "NO FIX", "2D FIX", "3D FIX", "DGPS", "RTK FLOAT", "RTK FIX"];

const fmt = (v: number | null, d = 1) => (v === null || Number.isNaN(v) ? "—" : v.toFixed(d));

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

function applyDeadband(v: number, db: number): number {
  const a = Math.abs(v);
  if (a <= db) return 0;
  return Math.sign(v) * Math.min(1, (a - db) / (1 - db));
}

// QGC-style slide-to-confirm for consequential commands (arm / takeoff /
// goto / land): drag the thumb all the way to the right end and the
// command fires in that single action. Releasing early springs the thumb
// back and nothing is sent, so the mis-tap protection stays. Keyboard:
// focus the thumb and use arrow keys (→ pushes it along, reaching the
// end fires; ← pulls it back).
function SlideConfirm({
  label, ariaLabel, disabled, danger, onConfirm,
}: {
  label: string; ariaLabel: string; disabled?: boolean; danger?: boolean;
  onConfirm: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const firedRef = useRef(false);
  const [frac, setFrac] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fired, setFired] = useState(false);
  const FIRE_AT = 0.92;

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    setFired(true);
    setFrac(1);
    onConfirm();
    setTimeout(() => {
      firedRef.current = false;
      setFired(false);
      setFrac(0);
    }, 900);
  }, [onConfirm]);

  const updateFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const thumb = 38;
    const travel = Math.max(1, rect.width - thumb);
    const f = Math.max(0, Math.min(1, (clientX - rect.left - thumb / 2) / travel));
    setFrac(f);
    if (f >= FIRE_AT) fire();
  };

  const endDrag = () => {
    pointerId.current = null;
    setDragging(false);
    if (!firedRef.current) setFrac(0);
  };

  return (
    <div
      ref={trackRef}
      className="relative h-[42px] select-none overflow-hidden rounded-lg"
      style={{
        background: danger ? "rgba(244,83,74,0.10)" : "var(--surface-2)",
        border: `1px solid ${fired ? "var(--ok)" : danger ? "var(--danger)" : "var(--border)"}`,
        opacity: disabled ? 0.4 : 1,
        touchAction: "none",
      }}
      aria-disabled={disabled}
    >
      {/* progress fill */}
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `calc(38px + ${frac} * (100% - 38px))`,
          background: fired
            ? "rgba(61,220,132,0.25)"
            : danger ? "rgba(244,83,74,0.22)" : "rgba(34,211,238,0.16)",
          transition: dragging ? "none" : "width 0.18s ease-out",
        }}
      />
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center pl-[38px] text-xs font-bold tracking-wide"
        style={{ color: fired ? "var(--ok)" : danger ? "#ff8d85" : "var(--text)" }}
      >
        {fired ? "送信しました" : label}
      </span>
      <div
        role="slider"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(frac * 100)}
        aria-valuetext={fired ? "実行済み" : `スライド ${Math.round(frac * 100)}%`}
        tabIndex={disabled ? -1 : 0}
        className="absolute inset-y-0 left-0 flex w-[38px] items-center justify-center rounded-lg text-base font-bold"
        style={{
          left: `calc(${frac} * (100% - 38px))`,
          background: danger ? "rgba(244,83,74,0.85)" : "var(--accent)",
          color: "#0b1116",
          cursor: disabled ? "not-allowed" : "grab",
          transition: dragging ? "none" : "left 0.18s ease-out",
          outlineOffset: 2,
        }}
        onPointerDown={(e) => {
          if (disabled) return;
          pointerId.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          updateFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (pointerId.current !== e.pointerId) return;
          updateFromClientX(e.clientX);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowRight" || e.key === "ArrowUp") {
            e.preventDefault();
            const f = Math.min(1, frac + 0.12);
            setFrac(f);
            if (f >= FIRE_AT) fire();
          } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
            e.preventDefault();
            setFrac(Math.max(0, frac - 0.12));
          } else if (e.key === "Home") {
            e.preventDefault();
            setFrac(0);
          }
        }}
      >
        »
      </div>
    </div>
  );
}

function Readout({ label, value, unit, accent, small }: {
  label: string; value: string; unit?: string; accent?: boolean; small?: boolean;
}) {
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: "var(--surface-2)" }}>
      <div className="text-[10px] tracking-widest" style={{ color: "var(--dim)" }}>{label}</div>
      <div
        className={`mono leading-tight ${small ? "text-[13px]" : "text-lg"}`}
        style={{ color: accent ? "var(--accent)" : "var(--text)" }}
      >
        {value}
        {unit && <span className="ml-1 text-[11px]" style={{ color: "var(--dim)" }}>{unit}</span>}
      </div>
    </div>
  );
}

export function App() {
  // Supplies the joystick payload that rides along on the status poll
  // (assigned in the joystick section below). The poll is the most
  // reliable recurring channel out of the page — it keeps running on
  // focus/visibility refetches even when plain timers are throttled —
  // so the latest stick state also travels on it as a resilience path.
  const joyTransportRef = useRef<
    () => { enabled: boolean; pitch: number; roll: number; yaw: number; throttle: number } | undefined
  >(() => undefined);
  const statusQ = useQuery({
    queryKey: ["gcsStatus"],
    queryFn: () => {
      const joy = joyTransportRef.current();
      return api.getStatus(joy ? { joy } : {});
    },
    refetchInterval: 300,
    // Keep polling even when the webview reports itself unfocused /
    // backgrounded: inside the Muse shell the artifact iframe can lose
    // "focus" while the user is still looking at it, and the default
    // behaviour pauses refetchInterval there — the display then sits on
    // a stale snapshot forever, which is exactly the repeated
    // 「表示が変わってない」 report.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });
  const s: Status | undefined = statusQ.data;
  const connected = s?.conn === "connected";

  // ---- liveness: backup poll + visible update clock ----
  // refetchInterval alone proved not to be enough in the shell webview
  // (timers/focus events are unreliable there), so a plain interval also
  // forces a refetch every 1.5 s, and focus/visibility kicks refetch at
  // once. A 500 ms local tick re-renders the status strip so the
  // "last updated" clock and the stale warning below stay honest even
  // between polls — and so the user can SEE the display is alive (or
  // that it genuinely stopped, via the stale warning) instead of
  // guessing from hover-frozen telemetry values.
  const refetchRef = useRef(statusQ.refetch);
  refetchRef.current = statusQ.refetch;
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const poll = setInterval(() => {
      void refetchRef.current();
    }, 1500);
    const tick = setInterval(() => setNowTick((v) => v + 1), 500);
    const kick = () => void refetchRef.current();
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", kick);
    };
  }, []);
  const dataAgeMs = statusQ.dataUpdatedAt
    ? Date.now() - statusQ.dataUpdatedAt
    : null;
  const dataStale = dataAgeMs !== null && dataAgeMs > 5000;
  const updatedClock = statusQ.dataUpdatedAt
    ? new Date(statusQ.dataUpdatedAt).toLocaleTimeString("ja-JP")
    : "—";

  const [tab, setTab] = useState<TabId>("fly");
  const [hostInput, setHostInput] = useState("127.0.0.1");
  const [portInput, setPortInput] = useState("5760");
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const userDisconnectedRef = useRef(false);
  const lastConnectAttemptRef = useRef(0);

  const [takeoffAlt, setTakeoffAlt] = useState("10");
  const [gotoLat, setGotoLat] = useState("");
  const [gotoLon, setGotoLon] = useState("");
  const [gotoAlt, setGotoAlt] = useState("10");
  const [mapTarget, setMapTarget] = useState<LatLon | null>(null);
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [hudOpen, setHudOpen] = useState(true);
  const [tapReady, setTapReady] = useState(false);

  // ---- joystick state ----
  const axesRef = useRef({ lx: 0, ly: 0, rx: 0, ry: 0 });
  const deadbandRef = useRef(0.1);
  const [joyEnabled, setJoyEnabled] = useState(false);
  const [deadband, setDeadband] = useState(0.1);
  const [joyOut, setJoyOut] = useState({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 });
  deadbandRef.current = deadband;

  const computeAxes = useCallback(() => {
    const db = deadbandRef.current;
    const a = axesRef.current;
    return {
      pitch: applyDeadband(a.ry, db),
      roll: applyDeadband(a.rx, db),
      yaw: applyDeadband(a.lx, db),
      throttle: Math.max(0, Math.min(1, 0.5 + applyDeadband(a.ly, db) / 2)),
    };
  }, []);

  // ---- joystick streaming: single-flight, latest-wins sender ----
  // The action channel's round trip can take far longer than a naive
  // send interval. The old code fired a request every 120 ms without
  // waiting, so stick positions queued up and reached the bridge seconds
  // late, in stale order — and whenever the queue starved, the bridge's
  // staleness failsafe neutralised the stream. That is exactly the
  // "sticks don't react / commands feel delayed" behaviour. Now at most
  // one request is ever in flight and it always carries the LATEST axes:
  // deflection latency is bounded by one round trip, releasing the stick
  // is never stuck behind a backlog, and an idle heartbeat (~2 s) keeps
  // the bridge-side stream alive while nothing is moving.
  const joyEnabledRef = useRef(false);
  joyEnabledRef.current = joyEnabled;
  const joyNeedsDisableRef = useRef(false);
  const joyInFlightRef = useRef(false);
  const joyAckedRef = useRef<{
    enabled: boolean; pitch: number; roll: number; yaw: number; throttle: number;
  } | null>(null);
  const joyLastSentAtRef = useRef(0);

  const pumpJoystickRef = useRef(() => undefined as void);
  pumpJoystickRef.current = () => {
    if (joyInFlightRef.current) return;
    const desired = joyEnabledRef.current
      ? { enabled: true, ...computeAxes() }
      : { enabled: false, pitch: 0, roll: 0, yaw: 0, throttle: 0.5 };
    const acked = joyAckedRef.current;
    const same =
      acked !== null &&
      acked.enabled === desired.enabled &&
      Math.abs(acked.pitch - desired.pitch) < 0.002 &&
      Math.abs(acked.roll - desired.roll) < 0.002 &&
      Math.abs(acked.yaw - desired.yaw) < 0.002 &&
      Math.abs(acked.throttle - desired.throttle) < 0.002;
    const heartbeatDue =
      desired.enabled && Date.now() - joyLastSentAtRef.current > 2000;
    if (same && !heartbeatDue) return;
    joyInFlightRef.current = true;
    joyLastSentAtRef.current = Date.now();
    void api.setJoystick(desired).then(
      () => {
        joyInFlightRef.current = false;
        joyAckedRef.current = desired;
        // If the desired state moved on while this request was in
        // flight, send the newest state immediately.
        pumpJoystickRef.current();
      },
      () => {
        joyInFlightRef.current = false;
        joyAckedRef.current = null; // force a retry on the next tick
      },
    );
  };

  // Heartbeats are sent on their own clock and may overlap an in-flight
  // change request: they carry the current (usually unchanged) axes, so
  // ordering between them is harmless, and the bridge keeps receiving
  // updates at ~2 s intervals even when one round trip takes longer than
  // that (measured on this channel). Change sends stay single-flight.
  const lastHeartbeatAtRef = useRef(0);
  const sendHeartbeatRef = useRef(() => undefined as void);
  sendHeartbeatRef.current = () => {
    if (!joyEnabledRef.current) return;
    const now = Date.now();
    if (now - lastHeartbeatAtRef.current < 2000) return;
    lastHeartbeatAtRef.current = now;
    void api.setJoystick({ enabled: true, ...computeAxes() }).catch(() => undefined);
  };

  // Pump on a short timer (drives heartbeats, retries, and the numeric
  // readout); stick movement also pumps immediately via onChange below.
  useEffect(() => {
    const id = setInterval(() => {
      pumpJoystickRef.current();
      sendHeartbeatRef.current();
      if (joyEnabledRef.current) setJoyOut(computeAxes());
    }, 120);
    return () => clearInterval(id);
  }, [computeAxes]);

  // Returning to the page (focus / visibility) re-sends the stick state
  // at once: timers may have been throttled while the page was in the
  // background, and the bridge must not be left holding a stale state.
  useEffect(() => {
    const kick = () => {
      lastHeartbeatAtRef.current = 0;
      pumpJoystickRef.current();
      sendHeartbeatRef.current();
    };
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    return () => {
      window.removeEventListener("focus", kick);
      document.removeEventListener("visibilitychange", kick);
    };
  }, []);

  // Once the bridge confirms the joystick is off, the poll no longer
  // needs to carry the disable payload.
  useEffect(() => {
    if (s && !s.joyEnabled) joyNeedsDisableRef.current = false;
  }, [s]);

  joyTransportRef.current = () => {
    if (joyEnabledRef.current) return { enabled: true, ...computeAxes() };
    if (joyNeedsDisableRef.current) {
      return { enabled: false, pitch: 0, roll: 0, yaw: 0, throttle: 0.5 };
    }
    return undefined;
  };

  const toggleJoystick = (next: boolean) => {
    setJoyEnabled(next);
    joyEnabledRef.current = next;
    if (!next) {
      joyNeedsDisableRef.current = true;
      axesRef.current = { lx: 0, ly: 0, rx: 0, ry: 0 };
      setJoyOut({ pitch: 0, roll: 0, yaw: 0, throttle: 0.5 });
    }
    // The pump sends the new desired state (and the disable is never
    // overtaken by an older in-flight enable: single flight, latest wins).
    pumpJoystickRef.current();
  };

  // ---- connection ----
  const doConnect = useCallback(async () => {
    const port = Number.parseInt(portInput, 10) || 5760;
    try {
      const r = await api.connect({ host: hostInput.trim() || "127.0.0.1", port });
      setActionMsg(r.message);
    } catch (e) {
      setActionMsg(`接続エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    void statusQ.refetch();
  }, [hostInput, portInput, statusQ]);

  // Auto-connect on load, and retry (5 s cooldown) after an unexpected
  // drop — but never override an explicit user disconnect.
  useEffect(() => {
    if (!s || s.conn !== "disconnected" || userDisconnectedRef.current) return;
    const now = Date.now();
    if (now - lastConnectAttemptRef.current < 5000) return;
    lastConnectAttemptRef.current = now;
    void doConnect();
  }, [s, doConnect]);

  const run = async (fn: () => Promise<{ ok: boolean; message: string }>) => {
    try {
      const r = await fn();
      setActionMsg(r.message);
    } catch (e) {
      setActionMsg(`エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    void statusQ.refetch();
  };

  // Turning the sticks ON means "I want manual control now". In GUIDED /
  // AUTO / RTL etc. ArduCopter ignores MANUAL_CONTROL entirely, so after a
  // GUIDED takeoff or Goto the sticks felt completely dead even though the
  // stream was flowing. Switch to LOITER (position-holding manual mode)
  // the moment the joystick is enabled in such a mode, so the sticks work
  // as soon as they appear. Fires once per enable transition.
  useEffect(() => {
    if (!joyEnabled || !connected) return;
    const m = s?.mode;
    if (m && !STICK_EFFECTIVE_MODES.includes(m)) {
      setActionMsg(`${m}ではスティックが効かないため、LOITERに自動で切り替えました`);
      void run(() => api.setMode({ mode: "LOITER" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joyEnabled]);

  // Map tap: set the Goto candidate pin and prefill the Goto inputs.
  // The vehicle only moves after the explicit confirm in the Goto tab.
  const onMapTap = useCallback((p: LatLon) => {
    setMapTarget(p);
    setGotoLat(p.lat.toFixed(6));
    setGotoLon(p.lon.toFixed(6));
  }, []);

  const vehicle: LatLon | null =
    s?.lat != null && s?.lon != null ? { lat: s.lat, lon: s.lon } : null;
  const home: LatLon | null =
    s?.homeLat != null && s?.homeLon != null ? { lat: s.homeLat, lon: s.homeLon } : null;
  const distHome = vehicle && home ? haversineM(vehicle, home) : null;
  const lastAck = s?.acks[0];
  const lastMsg = s?.messages[0];
  const modeOptions = s?.modes?.length ? s.modes : [];
  const modeSelectOptions =
    s?.mode && !modeOptions.includes(s.mode) ? [s.mode, ...modeOptions] : modeOptions;

  const battColor =
    s?.battRemainingPct == null ? "var(--text)"
    : s.battRemainingPct < 25 ? "var(--danger)"
    : s.battRemainingPct < 50 ? "var(--warn)" : "var(--ok)";

  const stickEffective = s?.mode ? STICK_EFFECTIVE_MODES.includes(s.mode) : false;

  return (
    <div className="flex h-dvh flex-col gap-2 overflow-hidden p-2 sm:p-3">
      {/* ------- status strip (QGC top bar) ------- */}
      <div className="panel flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
        <span className="flex items-center gap-2">
          <span
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
            style={{
              background:
                s?.conn === "connected" ? "var(--ok)"
                : s?.conn === "connecting" ? "var(--warn)" : "var(--danger)",
            }}
          />
          <span className="mono hidden text-xs md:inline" style={{ color: "var(--dim)" }}>
            {s ? `${s.host}:${s.port}` : "—"}
          </span>
        </span>
        <span className="mono text-xl font-bold tracking-wide sm:text-2xl" style={{ color: "var(--accent)" }}>
          {s?.mode ?? "—"}
        </span>
        <span
          className="mono rounded px-2 py-0.5 text-xs font-bold sm:text-sm"
          style={{
            background: s?.armed ? "rgba(244,83,74,0.18)" : "var(--surface-2)",
            color: s?.armed ? "#ff8d85" : "var(--dim)",
            border: `1px solid ${s?.armed ? "var(--danger)" : "var(--border)"}`,
          }}
        >
          {s?.armed ? "ARMED" : "DISARMED"}
        </span>
        <span className="mono text-xs sm:text-sm">
          GPS{" "}
          <span style={{ color: s?.gpsFix != null && s.gpsFix >= 3 ? "var(--ok)" : "var(--warn)" }}>
            {s?.gpsFix != null ? (FIX_TEXT[s.gpsFix] ?? `FIX${s.gpsFix}`) : "—"}
          </span>
          {s?.gpsSats != null && <span style={{ color: "var(--dim)" }}> ({s.gpsSats}衛星)</span>}
        </span>
        <span className="mono text-xs sm:text-sm" style={{ color: battColor }}>
          {fmt(s?.battVoltageV ?? null, 1)}V
          {s?.battRemainingPct != null && ` / ${s.battRemainingPct}%`}
        </span>
        <span className="mono hidden text-xs lg:inline" style={{ color: "var(--dim)" }}>
          EKF {s?.ekfHealthy == null ? "—" : s.ekfHealthy ? "OK" : "異常"}
        </span>
        <span
          className="mono text-[11px] sm:text-xs"
          style={{ color: dataStale ? "var(--danger)" : "var(--dim)" }}
          aria-live="off"
        >
          {dataStale
            ? `⚠ 更新停止 ${Math.round((dataAgeMs ?? 0) / 1000)}秒`
            : `更新 ${updatedClock}`}
          {" · "}{s?.rxMsgCount ?? 0} msg
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button" className="btn !px-2.5 !py-1 text-xs"
            aria-label="ステータスを今すぐ更新"
            onClick={() => {
              if (dataAgeMs !== null && dataAgeMs > 15000) {
                // The poll channel itself is wedged; a fresh page load
                // is the reliable recovery.
                window.location.reload();
                return;
              }
              void refetchRef.current();
            }}
          >
            更新
          </button>
          {actionMsg && (
            <span className="mono hidden max-w-56 truncate text-xs xl:inline" style={{ color: "var(--dim)" }}>
              {actionMsg}
            </span>
          )}
          {connected || s?.conn === "connecting" ? (
            <button
              type="button" className="btn !px-2.5 !py-1 text-xs"
              onClick={() => {
                userDisconnectedRef.current = true;
                void run(async () => api.disconnect({}));
              }}
            >
              切断
            </button>
          ) : (
            <button
              type="button" className="btn active !px-2.5 !py-1 text-xs"
              onClick={() => {
                userDisconnectedRef.current = false;
                void doConnect();
              }}
            >
              SITLに接続
            </button>
          )}
        </span>
      </div>

      {/* ------- main: map (with overlays) + tabbed side panel ------- */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 lg:grid lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* map area */}
        <div className="panel relative min-h-[150px] flex-1 overflow-hidden lg:flex-none">
          <MapPanel
            vehicle={vehicle} headingDeg={s?.headingDeg ?? null}
            altRelM={s?.altRelM ?? null}
            home={home} target={mapTarget} track={s?.track ?? []}
            recenterSignal={recenterSignal}
            onTap={onMapTap} onTapReady={setTapReady}
          />

          {/* HUD overlay (QGC instrument panel) */}
          <div className="absolute left-2 top-2">
            {hudOpen ? (
              <div className="panel w-[168px] p-2 sm:w-[212px]" style={{ background: "rgba(16,26,33,0.92)" }}>
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="panel-title">HUD / 姿勢</span>
                  <button
                    type="button" className="btn !px-1.5 !py-0 text-[11px]"
                    aria-label="HUDを閉じる"
                    onClick={() => setHudOpen(false)}
                  >
                    －
                  </button>
                </div>
                <Hud rollDeg={s?.rollDeg ?? null} pitchDeg={s?.pitchDeg ?? null} headingDeg={s?.headingDeg ?? null} />
                <div className="mono mt-0.5 flex justify-between text-[10px] sm:text-[11px]" style={{ color: "var(--dim)" }}>
                  <span>ALT {fmt(s?.altRelM ?? null)}m</span>
                  <span>GS {fmt(s?.groundspeedMs ?? null)}m/s</span>
                  <span>THR {fmt(s?.throttlePct ?? null, 0)}%</span>
                </div>
              </div>
            ) : (
              <button
                type="button" className="btn text-xs"
                aria-label="HUDを開く"
                onClick={() => setHudOpen(true)}
              >
                HUD / 姿勢
              </button>
            )}
          </div>

          {/* map top-right controls */}
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1.5">
            <button
              type="button" className="btn !px-2 !py-1 text-xs"
              style={{ background: "rgba(13,21,28,0.92)" }}
              onClick={() => setRecenterSignal((v) => v + 1)}
              disabled={!vehicle}
            >
              機体にセンタリング
            </button>
            <span
              className="mono rounded px-1.5 py-0.5 text-[10px]"
              style={{ background: "rgba(11,17,22,0.8)", color: "var(--dim)" }}
            >
              {tapReady ? "マップをタップで目標を設定" : "タップ指定は準備中"}
            </span>
          </div>

          {/* bottom-center chip stack: stick-mode warning + tapped target */}
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-col items-center gap-1.5">
            {joyEnabled && connected && !stickEffective && (
              <button
                type="button"
                className="btn whitespace-nowrap !px-2.5 !py-1 text-[11px]"
                style={{
                  background: "rgba(46,34,8,0.94)", border: "1px solid var(--warn)",
                  color: "var(--warn)",
                }}
                onClick={() => void run(() => api.setMode({ mode: "LOITER" }))}
              >
                {s?.mode}ではスティックは効きません — タップでLOITERに切替
              </button>
            )}
            {mapTarget && (
              <div
                className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
                style={{ background: "rgba(11,17,22,0.92)", border: "1px solid var(--accent)" }}
              >
                <span className="mono whitespace-nowrap text-[11px] sm:text-xs">
                  目標: {mapTarget.lat.toFixed(5)}, {mapTarget.lon.toFixed(5)}
                  {vehicle && ` · ${fmt(haversineM(vehicle, mapTarget), 0)}m`}
                </span>
                <button
                  type="button" className="btn active !px-2 !py-0.5 whitespace-nowrap text-[11px]"
                  onClick={() => setTab("goto")}
                >
                  Gotoで確認
                </button>
                <button
                  type="button" className="btn !px-2 !py-0.5 text-[11px]"
                  aria-label="目標ピンを消す"
                  onClick={() => setMapTarget(null)}
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* joystick overlay (QGC-style, shown while enabled) */}
          {joyEnabled && (
            <>
              <div className="absolute bottom-2 left-2" style={{ opacity: 0.94, zIndex: 6 }}>
                <Stick
                  label="左: ヨー / スロットル" size={118}
                  horizontalName="ヨー" verticalName="スロットル"
                  onChange={(x, y) => {
                    axesRef.current.lx = x; axesRef.current.ly = y;
                    pumpJoystickRef.current();
                  }}
                />
              </div>
              <div className="absolute bottom-2 right-2" style={{ opacity: 0.94, zIndex: 6 }}>
                <Stick
                  label="右: ロール / ピッチ" size={118}
                  horizontalName="ロール" verticalName="ピッチ"
                  onChange={(x, y) => {
                    axesRef.current.rx = x; axesRef.current.ry = y;
                    pumpJoystickRef.current();
                  }}
                />
              </div>
            </>
          )}
        </div>

        {/* tabbed side panel */}
        <div className="panel flex h-[288px] shrink-0 flex-col overflow-hidden sm:h-[300px] lg:h-auto">
          <div className="flex shrink-0" role="tablist" aria-label="GCSパネル切替" style={{ borderBottom: "1px solid var(--border)" }}>
            {TABS.map((t) => (
              <button
                key={t.id} type="button" role="tab"
                aria-selected={tab === t.id}
                className={`tab-btn ${tab === t.id ? "active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
            {tab === "fly" && (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="panel-title mb-1.5 block" htmlFor="mode-select">フライトモード</label>
                  <select
                    id="mode-select"
                    className="inp mono"
                    aria-label="フライトモード選択"
                    value={s?.mode ?? ""}
                    disabled={!connected || modeSelectOptions.length === 0}
                    onChange={(e) => {
                      const m = e.target.value;
                      if (m && m !== s?.mode) void run(() => api.setMode({ mode: m }));
                    }}
                  >
                    {modeSelectOptions.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px]" style={{ color: "var(--dim)" }}>
                    リストから選ぶと即座にモード変更を送信します。
                  </p>
                </div>
                <div>
                  <div className="panel-title mb-1.5">飛行操作</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {s?.armed ? (
                      <button
                        type="button" className="btn" disabled={!connected}
                        onClick={() => void run(() => api.arm({ armed: false }))}
                      >
                        DISARM
                      </button>
                    ) : (
                      <SlideConfirm
                        label="ARM" ariaLabel="ARM: 右端までスライドで実行" disabled={!connected} danger
                        onConfirm={() => void run(() => api.arm({ armed: true }))}
                      />
                    )}
                    <button
                      type="button" className="btn" disabled={!connected}
                      onClick={() => void run(() => api.setMode({ mode: "RTL" }))}
                    >
                      RTL（帰還）
                    </button>
                    <SlideConfirm
                      label={`離陸 (${takeoffAlt}m)`} ariaLabel={`離陸 (${takeoffAlt}m): 右端までスライドで実行`}
                      disabled={!connected}
                      onConfirm={() =>
                        void run(() => api.takeoff({ altitudeM: Number.parseInt(takeoffAlt, 10) || 10 }))}
                    />
                    <SlideConfirm
                      label="LAND（着陸）" ariaLabel="LAND（着陸）: 右端までスライドで実行"
                      disabled={!connected}
                      onConfirm={() => void run(() => api.setMode({ mode: "LAND" }))}
                    />
                  </div>
                  <label className="mt-2 block">
                    <span className="text-xs" style={{ color: "var(--dim)" }}>離陸高度</span>
                    <select
                      className="inp mono mt-0.5" value={takeoffAlt}
                      aria-label="離陸高度"
                      onChange={(e) => setTakeoffAlt(e.target.value)}
                    >
                      {TAKEOFF_ALT_PRESETS.map((a) => (
                        <option key={a} value={String(a)}>{a} m</option>
                      ))}
                    </select>
                  </label>
                  {lastAck && (
                    <div className="mono mt-2 text-xs" style={{ color: "var(--dim)" }}>
                      直近ACK: {lastAck.commandName} →{" "}
                      <span style={{ color: lastAck.result === 0 ? "var(--ok)" : "var(--warn)" }}>
                        {lastAck.resultText}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "goto" && (
              <div className="flex flex-col gap-3">
                <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                  マップをタップすると、その地点が目標候補として入力されます。
                  内容を確認してから、下のスライダーを右端までスライドすると移動します（タップだけでは飛びません）。
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="text-xs" style={{ color: "var(--dim)" }}>緯度</span>
                    <input className="inp mono mt-0.5" value={gotoLat} inputMode="decimal"
                      onChange={(e) => setGotoLat(e.target.value)} aria-label="目標の緯度" placeholder="-35.363262" />
                  </label>
                  <label className="block">
                    <span className="text-xs" style={{ color: "var(--dim)" }}>経度</span>
                    <input className="inp mono mt-0.5" value={gotoLon} inputMode="decimal"
                      onChange={(e) => setGotoLon(e.target.value)} aria-label="目標の経度" placeholder="149.165237" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs" style={{ color: "var(--dim)" }}>高度</span>
                  <select
                    className="inp mono mt-0.5" value={gotoAlt}
                    aria-label="目標の高度"
                    onChange={(e) => setGotoAlt(e.target.value)}
                  >
                    {GOTO_ALT_PRESETS.map((a) => (
                      <option key={a} value={String(a)}>{a} m</option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button" className="btn" disabled={!vehicle}
                    onClick={() => {
                      if (vehicle) {
                        setGotoLat(vehicle.lat.toFixed(6));
                        setGotoLon(vehicle.lon.toFixed(6));
                        setMapTarget(vehicle);
                      }
                    }}
                  >
                    現在位置を入力
                  </button>
                  <button
                    type="button" className="btn" disabled={!home}
                    onClick={() => {
                      if (home) {
                        setGotoLat(home.lat.toFixed(6));
                        setGotoLon(home.lon.toFixed(6));
                        setMapTarget(home);
                      }
                    }}
                  >
                    ホームを入力
                  </button>
                  {mapTarget && (
                    <button
                      type="button" className="btn"
                      onClick={() => setMapTarget(null)}
                    >
                      目標ピンを消す
                    </button>
                  )}
                </div>
                <SlideConfirm
                  label="この地点へ移動（GUIDED）"
                  ariaLabel="この地点へ移動（GUIDED）: 右端までスライドで実行"
                  disabled={!connected}
                  onConfirm={() => {
                    const lat = Number.parseFloat(gotoLat);
                    const lon = Number.parseFloat(gotoLon);
                    const alt = Number.parseInt(gotoAlt, 10) || 10;
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
                      setActionMsg("緯度・経度を数値で入力してください");
                      return;
                    }
                    setMapTarget({ lat, lon });
                    void run(() => api.guidedGoto({ lat, lon, altM: alt }));
                  }}
                />
                {mapTarget && vehicle && (
                  <div className="mono text-xs" style={{ color: "var(--dim)" }}>
                    目標まで {fmt(haversineM(vehicle, mapTarget), 0)} m
                  </div>
                )}
              </div>
            )}

            {tab === "stick" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="panel-title">バーチャルジョイスティック</span>
                  <button
                    type="button" role="switch" aria-checked={joyEnabled}
                    aria-label="ジョイスティック有効化"
                    className={`btn mono ${joyEnabled ? "active" : ""}`}
                    onClick={() => toggleJoystick(!joyEnabled)}
                  >
                    {joyEnabled ? "ON" : "OFF"}
                  </button>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                  ONにするとスティックがマップ上に表示されます（左=ヨー/スロットル、右=ロール/ピッチ）。
                  有効中は MANUAL_CONTROL を継続送信します。スティックを離すと中立化し
                  （スロットルは中央=ホバリング位置）、入力が途絶えるとサーバー側でも自動で中立化します。
                  スティックが効くのは LOITER / ALT_HOLD / STABILIZE など手動系モードのみです。
                  ONにした時点で GUIDED など手動系でないモードだった場合は、自動で LOITER に切り替わります。
                  {joyEnabled && (
                    <span style={{ color: s?.joyStreaming ? "var(--ok)" : "var(--warn)" }}>
                      {" "}{s?.joyStreaming ? "送信中" : "送信待機中"}
                    </span>
                  )}
                </p>
                {connected && !stickEffective && (
                  <div
                    className="rounded-lg px-3 py-2"
                    style={{ background: "rgba(245,184,61,0.10)", border: "1px solid var(--warn)" }}
                  >
                    <p className="text-xs leading-relaxed" style={{ color: "var(--warn)" }}>
                      現在のモード（{s?.mode}）では、スティック入力は機体に伝わりません。
                      離陸直後の GUIDED も自律飛行モードのため同様です。
                      スティックで操縦するには、手動系モードに切り替えてください。
                    </p>
                    <button
                      type="button" className="btn mt-2 !px-2.5 !py-1 text-xs"
                      onClick={() => void run(() => api.setMode({ mode: "LOITER" }))}
                    >
                      LOITERに切り替える（位置保持つき手動操縦）
                    </button>
                  </div>
                )}
                <div className="mono grid grid-cols-4 text-center text-[11px]" style={{ color: "var(--dim)" }}>
                  <span>YAW {Math.round(joyOut.yaw * 100)}</span>
                  <span>THR {Math.round(joyOut.throttle * 100)}%</span>
                  <span>PITCH {Math.round(joyOut.pitch * 100)}</span>
                  <span>ROLL {Math.round(joyOut.roll * 100)}</span>
                </div>
                <label className="block">
                  <span className="text-xs" style={{ color: "var(--dim)" }}>
                    デッドバンド {Math.round(deadband * 100)}%
                  </span>
                  <input
                    type="range" min={0} max={0.3} step={0.01} value={deadband}
                    className="w-full" aria-label="デッドバンド"
                    onChange={(e) => setDeadband(Number.parseFloat(e.target.value))}
                  />
                </label>
              </div>
            )}

            {tab === "telemetry" && (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-2">
                  <Readout label="相対高度" value={fmt(s?.altRelM ?? null)} unit="m" accent />
                  <Readout label="対地速度" value={fmt(s?.groundspeedMs ?? null)} unit="m/s" />
                  <Readout label="上昇率" value={fmt(s?.climbMs ?? null)} unit="m/s" />
                  <Readout label="スロットル" value={fmt(s?.throttlePct ?? null, 0)} unit="%" />
                  <Readout label="MSL高度" value={fmt(s?.altMslM ?? null)} unit="m" />
                  <Readout label="ホーム距離" value={distHome === null ? "—" : fmt(distHome, 0)} unit="m" />
                  <Readout label="緯度" value={s?.lat != null ? s.lat.toFixed(6) : "—"} small />
                  <Readout label="経度" value={s?.lon != null ? s.lon.toFixed(6) : "—"} small />
                  <Readout label="HDOP" value={fmt(s?.gpsHdop ?? null, 2)} />
                  <Readout label="ロール" value={fmt(s?.rollDeg ?? null, 0)} unit="°" />
                  <Readout label="ピッチ" value={fmt(s?.pitchDeg ?? null, 0)} unit="°" />
                  <Readout label="ヨー" value={fmt(s?.yawDeg ?? null, 0)} unit="°" />
                </div>
                {s && s.rcChannels.length > 0 && (
                  <div>
                    <div className="panel-title mb-1.5">RCチャンネル</div>
                    <div className="flex flex-col gap-1">
                      {s.rcChannels.slice(0, 8).map((v, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="mono w-7 text-[10px]" style={{ color: "var(--dim)" }}>CH{i + 1}</span>
                          <div className="h-1.5 flex-1 rounded" style={{ background: "var(--surface-2)" }}>
                            <div
                              className="h-full rounded"
                              style={{
                                width: `${Math.max(0, Math.min(100, ((v - 1000) / 1000) * 100))}%`,
                                background: "var(--accent)",
                              }}
                            />
                          </div>
                          <span className="mono w-10 text-right text-[10px]" style={{ color: "var(--dim)" }}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === "log" && (
              <div className="flex flex-col gap-3">
                <div>
                  <div className="panel-title mb-1.5">接続設定</div>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="block">
                      <span className="text-xs" style={{ color: "var(--dim)" }}>接続先ホスト</span>
                      <input
                        className="inp mono mt-0.5 w-32" value={hostInput}
                        onChange={(e) => setHostInput(e.target.value)} aria-label="接続先ホスト"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs" style={{ color: "var(--dim)" }}>ポート</span>
                      <input
                        className="inp mono mt-0.5 w-20" value={portInput} inputMode="numeric"
                        onChange={(e) => setPortInput(e.target.value)} aria-label="接続先ポート"
                      />
                    </label>
                    {connected || s?.conn === "connecting" ? (
                      <button
                        type="button" className="btn"
                        onClick={() => {
                          userDisconnectedRef.current = true;
                          void run(async () => api.disconnect({}));
                        }}
                      >
                        切断
                      </button>
                    ) : (
                      <button
                        type="button" className="btn active"
                        onClick={() => {
                          userDisconnectedRef.current = false;
                          void doConnect();
                        }}
                      >
                        SITLに接続
                      </button>
                    )}
                  </div>
                  {s?.lastError && !connected && (
                    <div className="mono mt-1.5 text-xs" style={{ color: "var(--warn)" }}>{s.lastError}</div>
                  )}
                  {!connected && (
                    <p className="mono mt-1.5 text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                      接続すると、このマシン上のMAVLinkブリッジとSITLが自動で起動します（初回は数十秒かかります）。
                      手動で起動する場合は ~/workspace/ardupilot で{" "}
                      <span style={{ color: "var(--text)" }}>
                        Tools/autotest/sim_vehicle.py -v ArduCopter
                      </span>{" "}
                      を実行してください。
                    </p>
                  )}
                </div>
                <div>
                  <div className="panel-title mb-1.5">機体メッセージ</div>
                  <div className="flex flex-col gap-1">
                    {(s?.messages ?? []).length === 0 && (
                      <span className="text-xs" style={{ color: "var(--dim)" }}>メッセージはまだありません</span>
                    )}
                    {(s?.messages ?? []).map((m, i) => (
                      <div key={`${m.at}-${i}`} className="mono flex gap-2 text-xs leading-relaxed">
                        <span style={{ color: "var(--dim)" }}>
                          {new Date(m.at).toLocaleTimeString("ja-JP")}
                        </span>
                        <span
                          className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            background:
                              m.severity <= 3 ? "var(--danger)"
                              : m.severity === 4 ? "var(--warn)" : "var(--accent)",
                          }}
                        />
                        <span className="min-w-0 [overflow-wrap:anywhere]">{m.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------- bottom strip: latest message ------- */}
      <div className="panel flex items-center gap-2 px-3 py-1.5">
        <span className="panel-title shrink-0">MSG</span>
        <span className="mono truncate text-[11px] sm:text-xs" style={{ color: "var(--dim)" }}>
          {lastMsg
            ? `${new Date(lastMsg.at).toLocaleTimeString("ja-JP")}  ${lastMsg.text}`
            : actionMsg ?? "メッセージはまだありません"}
        </span>
        {s?.conn !== "connected" && s?.lastError && (
          <span className="mono ml-auto hidden shrink-0 truncate text-[11px] md:inline" style={{ color: "var(--warn)" }}>
            {s.lastError}
          </span>
        )}
      </div>
    </div>
  );
}
