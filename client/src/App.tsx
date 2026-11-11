import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { Hud } from "./Hud";
import { MapPanel, type LatLon } from "./MapPanel";
import { Stick } from "./Joystick";
import { TelemetryTiles } from "./TelemetryTiles";

type Status = ApiResponse<typeof api, "getStatus">;
type TabId = "fly" | "mission" | "params" | "goto" | "stick" | "telemetry" | "log";

const TABS: { id: TabId; label: string }[] = [
  { id: "fly", label: "飛行" },
  { id: "mission", label: "ミッション" },
  { id: "params", label: "パラメータ" },
  { id: "goto", label: "Goto" },
  { id: "stick", label: "スティック" },
  { id: "telemetry", label: "テレメトリ" },
  { id: "log", label: "ログ・接続" },
];

type MissionItemType = "takeoff" | "waypoint" | "land" | "rtl" | "other";
interface MissionItemState {
  id: number;
  type: MissionItemType;
  command?: number;
  lat: number;
  lon: number;
  altM: number;
}
const MISSION_TYPE_LABELS: Record<MissionItemType, string> = {
  takeoff: "離陸",
  waypoint: "ウェイポイント",
  land: "着陸",
  rtl: "RTL（帰還）",
  other: "その他",
};
// Compact labels for the one-line mission item row.
const MISSION_TYPE_SHORT: Record<MissionItemType, string> = {
  takeoff: "離陸",
  waypoint: "WP",
  land: "着陸",
  rtl: "RTL",
  other: "その他",
};
const MISSION_ALT_PRESETS = [3, 5, 10, 15, 20, 30, 50, 80];
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
    const thumb = 40;
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
          width: `calc(40px + ${frac} * (100% - 40px))`,
          background: fired
            ? "rgba(61,220,132,0.25)"
            : danger ? "rgba(244,83,74,0.22)" : "rgba(34,211,238,0.16)",
          transition: dragging ? "none" : "width 0.18s ease-out",
        }}
      />
      <span
        className="pointer-events-none absolute inset-0 flex items-center justify-center pl-[40px] text-xs font-bold"
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
        className="absolute inset-y-0 left-0 flex w-[40px] items-center justify-center rounded-lg text-base font-bold"
        style={{
          left: `calc(${frac} * (100% - 40px))`,
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

// ---- parameters tab (UXDuck-style: stage edits, write explicitly) ----
// Edits accumulate locally and reach the vehicle only when the user
// slides the write control; each write is confirmed from the vehicle's
// echoed PARAM_VALUE by the bridge, and the row then shows the value
// the vehicle actually holds. Display metadata (names, descriptions,
// units, ranges, enum/bitmask labels) comes from the official ArduPilot
// parameter definitions, lazily loaded from ./paramMeta.
interface VehicleParam { name: string; value: number; ptype: number }
type ParamMetaMap = Record<string, import("./paramMeta").ParamMeta>;

function fmtParamValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number.parseFloat(v.toFixed(6)));
}

function ParamsPanel({ connected, paramState, paramCount, paramTotal }: {
  connected: boolean;
  paramState: string;
  paramCount: number;
  paramTotal: number | null;
}) {
  const [params, setParams] = useState<VehicleParam[] | null>(null);
  const [meta, setMeta] = useState<ParamMetaMap | null>(null);
  const [query, setQuery] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [writing, setWriting] = useState(false);
  const [marks, setMarks] = useState<Record<string, "ok" | "fail">>({});
  const [needsReboot, setNeedsReboot] = useState(false);

  useEffect(() => {
    let alive = true;
    import("./paramMeta")
      .then((m) => { if (alive) setMeta(m.PARAM_META); })
      .catch(() => { if (alive) setMeta({}); });
    return () => { alive = false; };
  }, []);

  const loadList = useCallback(async () => {
    try {
      const r = await api.getParams({});
      if (r.params.length > 0) setParams(r.params);
      return r;
    } catch {
      return null;
    }
  }, []);

  // Show whatever the bridge already holds (e.g. fetched before this
  // tab was opened).
  useEffect(() => { void loadList(); }, [loadList]);

  // Follow the bridge-side fetch through the status snapshot.
  useEffect(() => {
    if (paramState === "fetching") {
      setFetching(true);
      return;
    }
    if (!fetching) return;
    if (paramState === "done") {
      setFetching(false);
      void loadList().then((r) => {
        if (r && r.params.length > 0) setMsg(`パラメータを${r.params.length}件取得しました`);
      });
    } else if (paramState === "error") {
      setFetching(false);
      setMsg("パラメータ取得に失敗しました。接続を確認してもう一度試してください");
    }
  }, [paramState, fetching, loadList]);

  const byName = useMemo(
    () => new Map((params ?? []).map((p) => [p.name, p])),
    [params],
  );

  const parsedEdit = useCallback((name: string): number | null => {
    const raw = edits[name];
    if (raw === undefined) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }, [edits]);

  const changedNames = useMemo(() => {
    const out: string[] = [];
    for (const name of Object.keys(edits)) {
      const cur = byName.get(name);
      const v = parsedEdit(name);
      if (cur && v !== null && Math.abs(v - cur.value) > 1e-9) out.push(name);
    }
    return out;
  }, [edits, byName, parsedEdit]);

  const startFetch = async () => {
    setMsg(null);
    setMarks({});
    try {
      const r = await api.fetchParams({});
      setMsg(r.message);
      if (r.ok) setFetching(true);
    } catch (e) {
      setMsg(`取得開始エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const writeAll = async () => {
    if (writing || changedNames.length === 0) return;
    setWriting(true);
    setMsg(`${changedNames.length}件を書き込み中…`);
    let okCount = 0;
    let reboot = false;
    const failures: string[] = [];
    for (const name of changedNames) {
      const v = parsedEdit(name);
      if (v === null) continue;
      try {
        const r = await api.setParam({ name, value: v });
        if (r.ok && r.value !== null) {
          okCount += 1;
          const echoed = r.value;
          setParams((prev) =>
            prev?.map((p) => (p.name === name ? { ...p, value: echoed } : p)) ?? prev);
          setEdits((prev) => {
            const next = { ...prev };
            delete next[name];
            return next;
          });
          setMarks((prev) => ({ ...prev, [name]: "ok" }));
          if (meta?.[name]?.reboot) reboot = true;
        } else {
          failures.push(`${name}: ${r.message}`);
          setMarks((prev) => ({ ...prev, [name]: "fail" }));
        }
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        setMarks((prev) => ({ ...prev, [name]: "fail" }));
      }
    }
    setNeedsReboot(reboot);
    setMsg(
      failures.length > 0
        ? `${okCount}件書き込み、${failures.length}件失敗（${failures[0]}）`
        : `${okCount}件のパラメータを書き込みました`,
    );
    setWriting(false);
  };

  const setEdit = (name: string, raw: string) => {
    setEdits((prev) => ({ ...prev, [name]: raw }));
    setMarks((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const filtered = (params ?? []).filter((p) => {
    if (onlyChanged && !changedNames.includes(p.name)) return false;
    if (!q) return true;
    const m = meta?.[p.name];
    return (
      p.name.toLowerCase().includes(q) ||
      (m?.label ?? "").toLowerCase().includes(q) ||
      (m?.desc ?? "").toLowerCase().includes(q)
    );
  });
  const shown = filtered.slice(0, 200);

  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
        編集はこの画面の中だけに溜まり、「書き込む」を押すまで機体へは送られません。
        書き込み後は、機体が返した値で受理を確認して表示します。
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button" className="btn active"
          disabled={!connected || fetching}
          onClick={() => void startFetch()}
        >
          {fetching
            ? `取得中… ${paramCount}${paramTotal !== null ? ` / ${paramTotal}` : ""}件`
            : params ? "パラメータを再取得" : "パラメータを取得"}
        </button>
        {params && (
          <span className="mono text-[11px]" style={{ color: "var(--dim)" }}>
            {params.length}件
          </span>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-xs" style={{ color: "var(--dim)" }}>
          <input
            type="checkbox" checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
            aria-label="変更したパラメータだけ表示"
          />
          変更のみ（{changedNames.length}）
        </label>
      </div>

      <input
        className="inp mono w-full"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="パラメータ名・説明で検索（例: RTL_ALT）"
        aria-label="パラメータ検索"
      />

      {changedNames.length > 0 && (
        <div
          className="flex flex-col gap-1.5 rounded-lg p-2"
          style={{ background: "rgba(245,184,61,0.08)", border: "1px solid var(--warn)" }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: "var(--warn)" }}>
              未書き込みの変更が{changedNames.length}件あります
            </span>
            <button
              type="button" className="btn ml-auto !px-2 !py-1 text-[11px]"
              disabled={writing}
              onClick={() => setEdits({})}
            >
              変更を破棄
            </button>
          </div>
          <SlideConfirm
            label={`書き込む (${changedNames.length}件)`}
            ariaLabel={`変更したパラメータ${changedNames.length}件を機体へ書き込む: 右端までスライドで実行`}
            disabled={writing || !connected}
            onConfirm={() => void writeAll()}
          />
        </div>
      )}

      {needsReboot && (
        <p className="text-xs" style={{ color: "var(--warn)" }}>
          再起動が必要なパラメータが含まれます。変更を反映するには機体の再起動が必要です（SITLは接続し直すと再起動します）。
        </p>
      )}
      {msg && (
        <p className="mono text-[11px]" style={{ color: "var(--dim)" }} role="status">{msg}</p>
      )}

      {params === null ? (
        <p className="text-xs" style={{ color: "var(--dim)" }}>
          {connected
            ? "まだパラメータを取得していません。「パラメータを取得」で機体から読み込みます（SITLでは通常1〜2秒、全1,400件ほど）。"
            : "機体に接続するとパラメータを取得できます。"}
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--dim)" }}>
          条件に合うパラメータがありません。
        </p>
      ) : (
        <div>
          {filtered.length > shown.length && (
            <p className="mb-1 text-[11px]" style={{ color: "var(--dim)" }}>
              {filtered.length}件中、最初の{shown.length}件を表示しています。検索で絞り込んでください。
            </p>
          )}
          <div className="flex flex-col">
            {shown.map((p) => {
              const m = meta?.[p.name];
              const editRaw = edits[p.name];
              const parsed = parsedEdit(p.name);
              const changed = changedNames.includes(p.name);
              const invalid = editRaw !== undefined && parsed === null;
              const mark = marks[p.name];
              const isOpen = expanded === p.name;
              const enumLabel = m?.values?.find(([v]) => Math.abs(v - p.value) < 1e-9)?.[1];
              return (
                <div
                  key={p.name}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <div className="flex items-center gap-1.5 py-1">
                    <button
                      type="button"
                      className="shrink-0 px-1 text-[11px]"
                      style={{ color: "var(--dim)", background: "transparent", border: "none", cursor: "pointer" }}
                      aria-label={`${p.name}の説明を${isOpen ? "閉じる" : "開く"}`}
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? null : p.name)}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="mono truncate text-xs">{p.name}</div>
                      <div className="truncate text-[10px]" style={{ color: "var(--dim)" }}>
                        {m?.label ?? ""}
                        {enumLabel ? ` · 現在: ${enumLabel}` : ""}
                        {m?.reboot ? " · 要再起動" : ""}
                      </div>
                    </div>
                    {mark === "ok" && (
                      <span className="text-[11px]" style={{ color: "var(--ok)" }} title="機体が受理しました">✓</span>
                    )}
                    {mark === "fail" && (
                      <span className="text-[11px]" style={{ color: "var(--danger)" }} title="書き込みを確認できませんでした">✕</span>
                    )}
                    {changed && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: "var(--warn)" }}
                        title="未書き込みの変更"
                      />
                    )}
                    {m?.values && !m?.bitmask ? (
                      <select
                        className="inp mono !h-[26px] w-[108px] shrink-0 !px-1.5 !py-0 text-[11px]"
                        style={changed ? { borderColor: "var(--warn)" } : undefined}
                        value={editRaw ?? String(p.value)}
                        aria-label={`${p.name}の値`}
                        onChange={(e) => setEdit(p.name, e.target.value)}
                      >
                        {!m.values.some(([v]) => Math.abs(v - p.value) < 1e-9) && (
                          <option value={String(p.value)}>{fmtParamValue(p.value)}</option>
                        )}
                        {m.values.map(([v, lbl]) => (
                          <option key={v} value={String(v)}>{lbl}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="inp mono !h-[26px] w-[84px] shrink-0 !px-1.5 !py-0 text-right text-[11px]"
                        style={{
                          borderColor: invalid ? "var(--danger)" : changed ? "var(--warn)" : undefined,
                        }}
                        value={editRaw ?? fmtParamValue(p.value)}
                        inputMode="decimal"
                        aria-label={`${p.name}の値`}
                        onChange={(e) => setEdit(p.name, e.target.value)}
                      />
                    )}
                    {m?.units && (
                      <span className="w-10 shrink-0 truncate text-[10px]" style={{ color: "var(--dim)" }}>
                        {m.units}
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div className="pb-2 pl-6 pr-1 text-[11px] leading-relaxed" style={{ color: "var(--dim)" }}>
                      {m?.desc ? <p>{m.desc}</p> : <p>説明メタデータがありません。</p>}
                      <p className="mono mt-1">
                        現在値: {fmtParamValue(p.value)}
                        {m?.min !== undefined && m?.max !== undefined
                          ? ` · 範囲: ${m.min} 〜 ${m.max}`
                          : ""}
                        {m?.units ? ` · 単位: ${m.units}` : ""}
                      </p>
                      {m?.values && (
                        <p className="mono mt-1">
                          選択肢: {m.values.map(([v, lbl]) => `${fmtParamValue(v)}=${lbl}`).join(", ")}
                        </p>
                      )}
                      {m?.bitmask && (
                        <div className="mt-1.5 flex flex-col gap-1">
                          {m.bitmask.map(([bit, lbl]) => {
                            const cur = parsed ?? p.value;
                            const on = (Math.round(cur) & (1 << bit)) !== 0;
                            return (
                              <label key={bit} className="flex items-center gap-1.5">
                                <input
                                  type="checkbox" checked={on}
                                  aria-label={`${p.name}のビット${bit}: ${lbl}`}
                                  onChange={(e) => {
                                    const base = Math.round(parsed ?? p.value);
                                    const next = e.target.checked
                                      ? base | (1 << bit)
                                      : base & ~(1 << bit);
                                    setEdit(p.name, String(next));
                                  }}
                                />
                                <span>{lbl}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
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

  // ---- mission editor state ----
  const [missionItems, setMissionItems] = useState<MissionItemState[]>([]);
  const [missionSel, setMissionSel] = useState<number | null>(null);
  const [missionMsg, setMissionMsg] = useState<string | null>(null);
  const [missionBusy, setMissionBusy] = useState(false);
  const [newWpAlt, setNewWpAlt] = useState("10");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const missionIdRef = useRef(1);
  const tabRef = useRef<TabId>("fly");
  tabRef.current = tab;
  const newWpAltRef = useRef("10");
  newWpAltRef.current = newWpAlt;

  const [recenterSignal, setRecenterSignal] = useState(0);
  const [hudOpen, setHudOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
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

  // ---- mission actions ----
  const missionPayload = () =>
    missionItems.map((it) => ({
      type: it.type,
      ...(it.type === "other" && it.command !== undefined ? { command: it.command } : {}),
      lat: it.lat, lon: it.lon, altM: it.altM,
    }));

  const uploadMission = async () => {
    if (missionItems.length === 0 || missionBusy) return;
    setMissionBusy(true);
    setMissionMsg("アップロード中…");
    try {
      const r = await api.uploadMission({ items: missionPayload() });
      setMissionMsg(r.message);
      setActionMsg(r.message);
    } catch (e) {
      setMissionMsg(`アップロードエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    setMissionBusy(false);
    void statusQ.refetch();
  };

  const downloadMission = async () => {
    if (missionBusy) return;
    setMissionBusy(true);
    setMissionMsg("ダウンロード中…");
    try {
      const r = await api.downloadMission({});
      setMissionMsg(r.message);
      if (r.ok) {
        setMissionItems(
          r.items.map((it) => ({ id: missionIdRef.current++, ...it })),
        );
        setMissionSel(null);
      }
    } catch (e) {
      setMissionMsg(`ダウンロードエラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    setMissionBusy(false);
    void statusQ.refetch();
  };

  const generateMissionWithAi = async () => {
    const prompt = aiPrompt.trim();
    if (!prompt || aiBusy) return;
    setAiBusy(true);
    setMissionMsg("AIがミッションを作成中…");
    try {
      const r = await api.generateMission({
        prompt,
        homeLat: s?.homeLat ?? null,
        homeLon: s?.homeLon ?? null,
        vehicleLat: s?.lat ?? null,
        vehicleLon: s?.lon ?? null,
      });
      setMissionMsg(r.message);
      if (r.ok && r.items.length > 0) {
        setMissionItems(
          r.items.map((it) => ({ id: missionIdRef.current++, ...it })),
        );
        setMissionSel(null);
      }
    } catch (e) {
      setMissionMsg(`AI生成エラー: ${e instanceof Error ? e.message : String(e)}`);
    }
    setAiBusy(false);
  };

  const moveMissionItem = (index: number, dir: -1 | 1) => {
    setMissionItems((items) => {
      const j = index + dir;
      if (j < 0 || j >= items.length) return items;
      const next = [...items];
      const a = next[index];
      const b = next[j];
      if (!a || !b) return items;
      next[index] = b;
      next[j] = a;
      return next;
    });
    setMissionSel(index + dir);
  };

  // Map tap: in the mission tab it appends a waypoint; everywhere else
  // it sets the Goto candidate pin and prefills the Goto inputs. The
  // vehicle only moves after the explicit confirm in the Goto tab.
  const onMapTap = useCallback((p: LatLon) => {
    if (tabRef.current === "mission") {
      const alt = Number.parseInt(newWpAltRef.current, 10) || 10;
      setMissionItems((items) => {
        const item: MissionItemState = {
          id: missionIdRef.current++,
          type: "waypoint", lat: p.lat, lon: p.lon, altM: alt,
        };
        setMissionSel(items.length);
        return [...items, item];
      });
      return;
    }
    setMapTarget(p);
    setGotoLat(p.lat.toFixed(6));
    setGotoLon(p.lon.toFixed(6));
  }, []);

  const onMissionPointMove = useCallback((index: number, p: LatLon) => {
    setMissionItems((items) =>
      items.map((it, i) => (i === index ? { ...it, lat: p.lat, lon: p.lon } : it)),
    );
  }, []);

  const missionPoints = missionItems
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.type !== "rtl")
    .map(({ it, i }) => ({ index: i, lat: it.lat, lon: it.lon, label: String(i + 1) }));

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
        <span className="mono text-xl font-bold sm:text-2xl" style={{ color: "var(--accent)" }}>
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
            ? `更新停止 ${Math.round((dataAgeMs ?? 0) / 1000)}秒`
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
            missionPoints={missionPoints}
            missionSelected={missionSel}
            onMissionPointMove={onMissionPointMove}
            onMissionPointSelect={setMissionSel}
          />

          {/* HUD overlay: the round gauge floats directly on the map —
              no square panel behind it, so the map shows through the
              corners. Only small circular / pill chips sit around it. */}
          <div className="absolute left-2 top-2">
            {hudOpen ? (
              <div className="relative w-[188px] sm:w-[204px]">
                <div className="relative mx-auto w-[136px] sm:w-[160px]">
                  <Hud rollDeg={s?.rollDeg ?? null} pitchDeg={s?.pitchDeg ?? null} />
                  <button
                    type="button"
                    aria-label="HUDを閉じる"
                    onClick={() => setHudOpen(false)}
                    className="absolute -right-1 top-0 flex h-6 w-6 items-center justify-center rounded-full text-[13px] leading-none"
                    style={{
                      background: "rgba(11,17,22,0.85)", color: "var(--dim)",
                      border: "1px solid rgba(219,231,238,0.3)",
                    }}
                  >
                    －
                  </button>
                </div>
                <div className="mt-1.5 flex flex-wrap justify-center gap-1">
                  <span
                    className="mono whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
                    style={{ background: "rgba(11,17,22,0.82)", color: "var(--accent)", border: "1px solid rgba(219,231,238,0.18)" }}
                  >
                    HDG {s?.headingDeg != null ? `${String(Math.round(s.headingDeg)).padStart(3, "0")}°` : "—"}
                  </span>
                  <span
                    className="mono whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
                    style={{ background: "rgba(11,17,22,0.82)", color: "var(--text)", border: "1px solid rgba(219,231,238,0.18)" }}
                  >
                    ALT {fmt(s?.altRelM ?? null)}m
                  </span>
                  <span
                    className="mono whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
                    style={{ background: "rgba(11,17,22,0.82)", color: "var(--text)", border: "1px solid rgba(219,231,238,0.18)" }}
                  >
                    GS {fmt(s?.groundspeedMs ?? null)}m/s
                  </span>
                  <span
                    className="mono whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]"
                    style={{ background: "rgba(11,17,22,0.82)", color: "var(--text)", border: "1px solid rgba(219,231,238,0.18)" }}
                  >
                    THR {fmt(s?.throttlePct ?? null, 0)}%
                  </span>
                </div>
              </div>
            ) : (
              <button
                type="button"
                aria-label="HUDを開く"
                onClick={() => setHudOpen(true)}
                className="flex h-11 w-11 items-center justify-center rounded-full text-[10px] font-bold"
                style={{
                  background: "rgba(11,17,22,0.85)", color: "var(--accent)",
                  border: "1px solid var(--accent)",
                  boxShadow: "0 4px 14px rgba(0,0,0,0.5)",
                }}
              >
                HUD
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
            {tapReady && (
              <span
                className="mono rounded px-1.5 py-0.5 text-[10px]"
                style={{ background: "rgba(11,17,22,0.8)", color: "var(--dim)" }}
              >
                {tab === "mission"
                  ? "マップをタップでウェイポイント追加・ピンはドラッグで移動"
                  : "マップをタップで目標を設定"}
              </span>
            )}
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
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="block">
                    <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
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

        {/* tabbed side panel — collapsible so the map can take the space */}
        {!panelOpen ? (
          <div className="panel flex shrink-0 items-center gap-2 px-3 py-2 lg:self-start">
            <span className="panel-title">操作パネル</span>
            <span className="mono truncate text-[11px]" style={{ color: "var(--dim)" }}>
              {TABS.find((t) => t.id === tab)?.label}
            </span>
            <button
              type="button" className="btn active ml-auto !px-2.5 !py-1 text-xs"
              aria-label="操作パネルを開く"
              aria-expanded={false}
              onClick={() => setPanelOpen(true)}
            >
              開く ▴
            </button>
          </div>
        ) : (
        <div className="panel flex h-[252px] shrink-0 flex-col overflow-hidden sm:h-[264px] lg:h-auto">
          <div className="flex shrink-0 items-stretch" role="tablist" aria-label="GCSパネル切替" style={{ borderBottom: "1px solid var(--border)" }}>
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
            <button
              type="button"
              aria-label="操作パネルを畳んで地図を広げる"
              aria-expanded={true}
              onClick={() => setPanelOpen(false)}
              className="shrink-0 px-1.5 text-sm"
              style={{ color: "var(--dim)", background: "transparent", border: "none", cursor: "pointer" }}
            >
              ▾
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
            {tab === "fly" && (
              <div className="flex flex-col gap-3">
                <div>
                  <label className="panel-title mb-1.5 block" htmlFor="mode-select">フライトモード</label>
                  <select
                    id="mode-select"
                    className="inp mono w-full"
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
                      className="inp mono mt-0.5 w-full" value={takeoffAlt}
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

            {tab === "mission" && (
              <div className="flex flex-col gap-3">
                <p className="text-xs leading-relaxed" style={{ color: "var(--dim)" }}>
                  マップをタップするとウェイポイントが追加され、黄ピンはドラッグで移動できます。
                  並べたミッションは「アップロード」で機体に送られ、AUTOモードで実行されます（アップロードだけでは飛びません）。
                </p>

                {/* AI mission drafting */}
                <div>
                  <label className="panel-title mb-1.5 block" htmlFor="ai-mission-prompt">AIでミッションを作成</label>
                  <textarea
                    id="ai-mission-prompt"
                    className="inp w-full"
                    rows={2}
                    value={aiPrompt}
                    placeholder="例: ホームの周りを半径40mの四角形で一周、高度15m。最後はホームに戻って着陸"
                    aria-label="AIへのミッション指示"
                    onChange={(e) => setAiPrompt(e.target.value)}
                  />
                  <button
                    type="button" className="btn active mt-1.5 w-full"
                    disabled={aiBusy || aiPrompt.trim() === ""}
                    onClick={() => void generateMissionWithAi()}
                  >
                    {aiBusy ? "AI作成中…" : "AIで作成してリストに入れる"}
                  </button>
                  <p className="mt-1 text-[11px]" style={{ color: "var(--dim)" }}>
                    作成結果は下のリストに入ります。内容を確認・編集してからアップロードしてください。
                  </p>
                </div>

                {/* add-waypoint defaults + quick add */}
                <div className="flex flex-wrap items-end gap-2">
                  <label className="block">
                    <span className="text-xs" style={{ color: "var(--dim)" }}>追加するウェイポイントの高度</span>
                    <select
                      className="inp mono mt-0.5" value={newWpAlt}
                      aria-label="追加するウェイポイントの高度"
                      onChange={(e) => setNewWpAlt(e.target.value)}
                    >
                      {MISSION_ALT_PRESETS.map((a) => (
                        <option key={a} value={String(a)}>{a} m</option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button" className="btn" disabled={!home && !vehicle}
                    onClick={() => {
                      const base = home ?? vehicle;
                      if (!base) return;
                      const alt = Number.parseInt(newWpAlt, 10) || 10;
                      setMissionItems((items) => [
                        ...items,
                        { id: missionIdRef.current++, type: "takeoff", lat: base.lat, lon: base.lon, altM: alt },
                      ]);
                    }}
                  >
                    離陸を追加
                  </button>
                  <button
                    type="button" className="btn" disabled={!home && !vehicle}
                    onClick={() => {
                      const base = home ?? vehicle;
                      if (!base) return;
                      setMissionItems((items) => [
                        ...items,
                        { id: missionIdRef.current++, type: "land", lat: base.lat, lon: base.lon, altM: 0 },
                      ]);
                    }}
                  >
                    着陸を追加
                  </button>
                  <button
                    type="button" className="btn"
                    onClick={() => {
                      const base = home ?? vehicle;
                      setMissionItems((items) => [
                        ...items,
                        {
                          id: missionIdRef.current++, type: "rtl",
                          lat: base?.lat ?? 0, lon: base?.lon ?? 0, altM: 0,
                        },
                      ]);
                    }}
                  >
                    RTLを追加
                  </button>
                </div>

                {/* item list */}
                <div>
                  <div className="panel-title mb-1.5">
                    ミッション項目（{missionItems.length}件）
                  </div>
                  {missionItems.length === 0 && (
                    <p className="text-xs" style={{ color: "var(--dim)" }}>
                      まだ項目がありません。マップをタップするか、AIで作成してください。機体に保存済みのミッションは「ダウンロード」で読み込めます。
                    </p>
                  )}
                  <div className="flex flex-col gap-1">
                    {missionItems.map((it, i) => {
                      const selected = missionSel === i;
                      return (
                        <div
                          key={it.id}
                          className="flex items-center gap-1 rounded-lg px-1.5 py-1"
                          style={{
                            background: "var(--surface-2)",
                            border: `1px solid ${selected ? "var(--warn)" : "var(--border)"}`,
                          }}
                          onClick={() => setMissionSel(i)}
                        >
                            <span
                              className="mono order-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                              style={{ background: "rgba(245,184,61,0.92)", color: "#0b1116" }}
                            >
                              {i + 1}
                            </span>
                            <select
                              className="inp mono order-2 !h-[26px] w-[74px] shrink-0 !px-1.5 !py-0 text-[11px]"
                              value={it.type}
                              aria-label={`項目${i + 1}の種類`}
                              onChange={(e) => {
                                const t = e.target.value as MissionItemType;
                                setMissionItems((items) =>
                                  items.map((x, xi) => (xi === i ? { ...x, type: t } : x)),
                                );
                              }}
                            >
                              {(Object.keys(MISSION_TYPE_LABELS) as MissionItemType[])
                                .filter((t) => t !== "other" || it.type === "other")
                                .map((t) => (
                                  <option key={t} value={t}>
                                    {t === "other" && it.command !== undefined
                                      ? `その他 (CMD ${it.command})`
                                      : MISSION_TYPE_SHORT[t]}
                                  </option>
                                ))}
                            </select>
                            <button
                              type="button" className="btn order-4 w-[22px] shrink-0 !px-0 !py-1 text-center text-[11px]"
                              aria-label={`項目${i + 1}を上へ`}
                              disabled={i === 0}
                              onClick={(e) => { e.stopPropagation(); moveMissionItem(i, -1); }}
                            >
                              ↑
                            </button>
                            <button
                              type="button" className="btn order-4 w-[22px] shrink-0 !px-0 !py-1 text-center text-[11px]"
                              aria-label={`項目${i + 1}を下へ`}
                              disabled={i === missionItems.length - 1}
                              onClick={(e) => { e.stopPropagation(); moveMissionItem(i, 1); }}
                            >
                              ↓
                            </button>
                            <button
                              type="button" className="btn order-4 w-[22px] shrink-0 !px-0 !py-1 text-center text-[11px]"
                              aria-label={`項目${i + 1}を削除`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setMissionItems((items) => items.filter((_, xi) => xi !== i));
                                setMissionSel(null);
                              }}
                            >
                              ×
                            </button>
                          <div className="order-3 flex min-w-0 flex-1 items-center gap-1.5">
                            {it.type !== "rtl" && (
                              <span
                                className="mono min-w-0 flex-1 truncate text-[10px]"
                                style={{ color: "var(--dim)" }}
                                title={`${it.lat.toFixed(6)}, ${it.lon.toFixed(6)}`}
                              >
                                {it.lat.toFixed(5)}, {it.lon.toFixed(5)}
                              </span>
                            )}
                            {it.type === "takeoff" || it.type === "waypoint" || it.type === "other" ? (
                              <label className="flex shrink-0 items-center">
                                <select
                                  className="inp mono !h-[26px] !w-[62px] !px-1 !py-0 text-[11px]"
                                  value={String(it.altM)}
                                  aria-label={`項目${i + 1}の高度`}
                                  onChange={(e) => {
                                    const v = Number.parseInt(e.target.value, 10) || 0;
                                    setMissionItems((items) =>
                                      items.map((x, xi) => (xi === i ? { ...x, altM: v } : x)),
                                    );
                                  }}
                                >
                                  {[...new Set([it.altM, ...MISSION_ALT_PRESETS])].sort((a, b) => a - b).map((a) => (
                                    <option key={a} value={String(a)}>{a} m</option>
                                  ))}
                                </select>
                              </label>
                            ) : it.type === "land" ? (
                              <span className="mono shrink-0 text-[10px]" style={{ color: "var(--dim)" }} title="高度 0 m（着陸）">0 m</span>
                            ) : (
                              <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--dim)" }}>ホームへ帰還</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* transfer + execute */}
                <div className="flex flex-col gap-2">
                  <button
                    type="button" className="btn active"
                    disabled={!connected || missionItems.length === 0 || missionBusy}
                    onClick={() => void uploadMission()}
                  >
                    {missionBusy ? "転送中…" : `ミッションをアップロード（${missionItems.length}件）`}
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button" className="btn flex-1"
                      disabled={!connected || missionBusy}
                      onClick={() => void downloadMission()}
                    >
                      ダウンロード
                    </button>
                    <button
                      type="button" className="btn flex-1"
                      disabled={missionItems.length === 0}
                      onClick={() => { setMissionItems([]); setMissionSel(null); }}
                    >
                      編集をクリア
                    </button>
                    <button
                      type="button" className="btn flex-1"
                      disabled={!connected || missionBusy}
                      onClick={() => void run(() => api.clearMission({}))}
                    >
                      機体のミッション消去
                    </button>
                  </div>
                  <SlideConfirm
                    label="ミッション開始"
                    ariaLabel="ミッション開始: 右端までスライドで実行"
                    disabled={!connected}
                    onConfirm={() => {
                      const tk = missionItems.find((it) => it.type === "takeoff");
                      void run(() =>
                        api.startMission({ takeoffAltM: tk ? tk.altM : 10 }),
                      );
                    }}
                  />
                  <p className="text-[11px]" style={{ color: "var(--dim)" }}>
                    地上ではGUIDEDで離陸アイテムの高度まで上がってからAUTOに移ります（AUTOのままではアームできず、地上発進はスロットル操作待ちになるため）。
                  </p>
                  {s?.missionCurrent != null && s.missionCurrent > 0 && (
                    <div className="mono text-xs" style={{ color: "var(--dim)" }}>
                      機体の実行位置: 項目 {s.missionCurrent}
                      {s.missionReached != null && s.missionReached > 0 && ` / 到達済み ${s.missionReached}`}
                    </div>
                  )}
                  {missionMsg && (
                    <div className="mono text-xs leading-relaxed" style={{ color: "var(--accent)" }}>
                      {missionMsg}
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
                    <input className="inp mono mt-0.5 w-full" value={gotoLat} inputMode="decimal"
                      onChange={(e) => setGotoLat(e.target.value)} aria-label="目標の緯度" placeholder="-35.363262" />
                  </label>
                  <label className="block">
                    <span className="text-xs" style={{ color: "var(--dim)" }}>経度</span>
                    <input className="inp mono mt-0.5 w-full" value={gotoLon} inputMode="decimal"
                      onChange={(e) => setGotoLon(e.target.value)} aria-label="目標の経度" placeholder="149.165237" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs" style={{ color: "var(--dim)" }}>高度</span>
                  <select
                    className="inp mono mt-0.5 w-full" value={gotoAlt}
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
                <TelemetryTiles s={s} distHome={distHome} />
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

            {tab === "params" && (
              <ParamsPanel
                connected={connected}
                paramState={s?.paramState ?? "idle"}
                paramCount={s?.paramCount ?? 0}
                paramTotal={s?.paramTotal ?? null}
              />
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
                      <span className="text-xs" style={{ color: "var(--dim)" }}>機体からのメッセージはまだ届いていません</span>
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
        )}
      </div>

      {/* ------- bottom strip: latest message ------- */}
      <div className="panel flex items-center gap-2 px-3 py-1.5">
        <span className="panel-title shrink-0">MSG</span>
        <span className="mono truncate text-[11px] sm:text-xs" style={{ color: "var(--dim)" }}>
          {lastMsg
            ? `${new Date(lastMsg.at).toLocaleTimeString("ja-JP")}  ${lastMsg.text}`
            : actionMsg ?? ""}
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
