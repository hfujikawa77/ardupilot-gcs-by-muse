// Telemetry tiles (UXDuck-style): a grid of live-value tiles whose
// visible set and order the user customizes. The layout is a pure
// display preference, persisted in localStorage; every value still
// comes straight from the latest telemetry snapshot on each render.

import { useEffect, useState } from "react";
import type { ApiResponse } from "./api";
import type { api } from "./api";

type Status = ApiResponse<typeof api, "getStatus">;

const FIX_TEXT = ["NO GPS", "NO FIX", "2D FIX", "3D FIX", "DGPS", "RTK FLOAT", "RTK FIX"];

const fmt = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : v.toFixed(d);

type Tone = "ok" | "warn" | "danger" | undefined;

interface TileDef {
  id: string;
  label: string;
  unit?: string;
  small?: boolean;
  // Full-bleed status background (UXDuck's green Armed / GPS-fix tiles):
  // "ok" paints the whole tile green, anything else leaves it neutral.
  statusBg?: (s: Status | undefined) => boolean;
  tone?: (s: Status | undefined) => Tone;
  value: (s: Status | undefined, distHome: number | null) => string;
}

const TILES: TileDef[] = [
  {
    id: "armed", label: "状態",
    statusBg: (s) => s?.armed === true,
    value: (s) => (s ? (s.armed ? "ARMED" : "DISARMED") : "—"),
  },
  { id: "mode", label: "モード", value: (s) => s?.mode ?? "—" },
  {
    id: "battRemaining", label: "バッテリー残量", unit: "%",
    tone: (s) =>
      s?.battRemainingPct == null ? undefined
      : s.battRemainingPct < 15 ? "danger"
      : s.battRemainingPct < 30 ? "warn" : undefined,
    value: (s) => fmt(s?.battRemainingPct, 0),
  },
  { id: "battVoltage", label: "バッテリー電圧", unit: "V", value: (s) => fmt(s?.battVoltageV, 1) },
  { id: "battCurrent", label: "電流", unit: "A", value: (s) => fmt(s?.battCurrentA, 1) },
  { id: "throttle", label: "スロットル", unit: "%", value: (s) => fmt(s?.throttlePct, 0) },
  { id: "airspeed", label: "対気速度", unit: "m/s", value: (s) => fmt(s?.airspeedMs) },
  { id: "groundspeed", label: "対地速度", unit: "m/s", value: (s) => fmt(s?.groundspeedMs) },
  { id: "altRel", label: "ホーム上高度", unit: "m", value: (s) => fmt(s?.altRelM) },
  { id: "altMsl", label: "MSL高度", unit: "m", value: (s) => fmt(s?.altMslM) },
  { id: "climb", label: "上昇率", unit: "m/s", value: (s) => fmt(s?.climbMs) },
  {
    id: "distHome", label: "ホーム距離", unit: "m",
    value: (_s, distHome) => (distHome === null ? "—" : fmt(distHome, 0)),
  },
  {
    id: "gpsFix", label: "GPS Fix",
    statusBg: (s) => (s?.gpsFix ?? 0) >= 3,
    value: (s) =>
      s?.gpsFix == null ? "—" : FIX_TEXT[s.gpsFix] ?? `FIX ${s.gpsFix}`,
  },
  { id: "gpsSats", label: "衛星数", value: (s) => fmt(s?.gpsSats, 0) },
  { id: "gpsHdop", label: "HDOP", value: (s) => fmt(s?.gpsHdop, 2) },
  { id: "heading", label: "ヘディング", unit: "°", value: (s) => fmt(s?.headingDeg, 0) },
  { id: "roll", label: "ロール", unit: "°", value: (s) => fmt(s?.rollDeg, 0) },
  { id: "pitch", label: "ピッチ", unit: "°", value: (s) => fmt(s?.pitchDeg, 0) },
  { id: "yaw", label: "ヨー", unit: "°", value: (s) => fmt(s?.yawDeg, 0) },
  {
    id: "lat", label: "緯度", small: true,
    value: (s) => (s?.lat != null ? s.lat.toFixed(6) : "—"),
  },
  {
    id: "lon", label: "経度", small: true,
    value: (s) => (s?.lon != null ? s.lon.toFixed(6) : "—"),
  },
  {
    id: "ekf", label: "EKF",
    tone: (s) =>
      s?.ekfHealthy == null ? undefined : s.ekfHealthy ? "ok" : "danger",
    value: (s) => (s?.ekfHealthy == null ? "—" : s.ekfHealthy ? "正常" : "異常"),
  },
  {
    id: "mission", label: "実行中ミッション", small: true,
    value: (s) =>
      s?.missionCurrent == null
        ? "—"
        : s.missionReached != null
          ? `${s.missionCurrent}（到達 ${s.missionReached}）`
          : `${s.missionCurrent}`,
  },
];

const TILE_BY_ID = new Map(TILES.map((t) => [t.id, t]));

// Default layout: the state/battery/flight values a pilot glances at
// first; the rest start hidden and can be added from カスタマイズ.
const DEFAULT_VISIBLE = [
  "armed", "mode", "battRemaining", "battVoltage", "battCurrent",
  "throttle", "airspeed", "groundspeed", "altRel", "altMsl", "climb",
  "distHome", "gpsFix", "gpsSats", "gpsHdop", "roll", "pitch", "yaw",
];

const STORAGE_KEY = "gcs-telemetry-tiles-v1";

function loadLayout(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE;
    const ids = parsed.filter(
      (v): v is string => typeof v === "string" && TILE_BY_ID.has(v),
    );
    return [...new Set(ids)];
  } catch {
    return DEFAULT_VISIBLE;
  }
}

const TONE_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

export function TelemetryTiles({ s, distHome }: { s: Status | undefined; distHome: number | null }) {
  const [visible, setVisible] = useState<string[]>(loadLayout);
  const [customizing, setCustomizing] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(visible));
    } catch {
      // storage unavailable (private mode etc.) — layout just won't persist
    }
  }, [visible]);

  const move = (id: string, dir: -1 | 1) => {
    setVisible((prev) => {
      const i = prev.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const [it] = next.splice(i, 1);
      if (it === undefined) return prev;
      next.splice(j, 0, it);
      return next;
    });
  };
  const hide = (id: string) => setVisible((prev) => prev.filter((v) => v !== id));
  const show = (id: string) => setVisible((prev) => (prev.includes(id) ? prev : [...prev, id]));

  const hiddenTiles = TILES.filter((t) => !visible.includes(t.id));

  const editor = (
    <div className="flex flex-col gap-1.5">
      <div className="panel-title mt-1">表示中の項目（↑↓で並び替え）</div>
      {visible.map((id, i) => {
        const t = TILE_BY_ID.get(id);
        if (!t) return null;
        return (
          <div
            key={t.id}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1"
            style={{ background: "var(--surface-2)" }}
          >
            <span className="min-w-0 flex-1 truncate text-xs">{t.label}</span>
            <button
              type="button" className="btn !px-2 !py-0.5 text-xs"
              aria-label={`${t.label}を上へ移動`}
              disabled={i === 0}
              onClick={() => move(t.id, -1)}
            >
              ↑
            </button>
            <button
              type="button" className="btn !px-2 !py-0.5 text-xs"
              aria-label={`${t.label}を下へ移動`}
              disabled={i === visible.length - 1}
              onClick={() => move(t.id, 1)}
            >
              ↓
            </button>
            <button
              type="button" className="btn !px-2 !py-0.5 text-xs"
              aria-label={`${t.label}を非表示にする`}
              onClick={() => hide(t.id)}
            >
              非表示
            </button>
          </div>
        );
      })}
      {hiddenTiles.length > 0 && (
        <>
          <div className="panel-title mt-1">非表示の項目</div>
          {hiddenTiles.map((t) => (
            <div
              key={t.id}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1"
              style={{ background: "var(--surface-2)", opacity: 0.75 }}
            >
              <span className="min-w-0 flex-1 truncate text-xs">{t.label}</span>
              <button
                type="button" className="btn !px-2 !py-0.5 text-xs"
                aria-label={`${t.label}を表示する`}
                onClick={() => show(t.id)}
              >
                表示
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="panel-title">テレメトリタイル</span>
        <button
          type="button"
          className={`btn ml-auto !px-2.5 !py-1 text-xs ${customizing ? "active" : ""}`}
          aria-pressed={customizing}
          onClick={() => setCustomizing((v) => !v)}
        >
          カスタマイズ
        </button>
        {customizing && (
          <button
            type="button"
            className="btn !px-2.5 !py-1 text-xs"
            onClick={() => setVisible(DEFAULT_VISIBLE)}
          >
            既定に戻す
          </button>
        )}
      </div>

      {/* While customizing, the editor list comes first so its controls
          are reachable without scrolling past the whole tile grid; the
          grid stays below as a live preview. */}
      {customizing ? editor : null}

      {visible.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--dim)" }}>
          表示中のタイルはありません。「カスタマイズ」から項目を追加してください。
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {visible.map((id) => {
            const t = TILE_BY_ID.get(id);
            if (!t) return null;
            const statusOn = t.statusBg?.(s) === true;
            const tone = t.tone?.(s);
            return (
              <div
                key={t.id}
                className="rounded-lg px-2.5 py-2"
                style={{
                  background: statusOn ? "var(--ok)" : "var(--surface-2)",
                  color: statusOn ? "#0b1116" : undefined,
                }}
              >
                <div
                  className="text-[10px]"
                  style={{ color: statusOn ? "rgba(11,17,22,0.65)" : "var(--dim)" }}
                >
                  {t.label}
                </div>
                <div
                  className={`mono leading-tight ${t.small ? "text-[13px]" : "text-lg"}`}
                  style={{
                    color: statusOn
                      ? "#0b1116"
                      : tone
                        ? TONE_COLOR[tone]
                        : "var(--text)",
                  }}
                >
                  {t.value(s, distHome)}
                  {t.unit && (
                    <span
                      className="ml-1 text-[11px]"
                      style={{ color: statusOn ? "rgba(11,17,22,0.65)" : "var(--dim)" }}
                    >
                      {t.unit}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
