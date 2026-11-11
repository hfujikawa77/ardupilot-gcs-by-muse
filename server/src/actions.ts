// ArduPilot GCS actions: thin wrappers over the local MAVLink bridge
// daemon (server/bridge/mav_bridge.py), reached through the privileged
// bridgeCall contract. Telemetry is live-only; nothing is persisted.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";

const COPTER_MODE_NAMES = [
  "STABILIZE", "ACRO", "ALT_HOLD", "AUTO", "GUIDED", "LOITER", "RTL",
  "CIRCLE", "LAND", "DRIFT", "SPORT", "POSHOLD", "BRAKE", "SMART_RTL",
  "FLOWHOLD", "FOLLOW", "ZIGZAG",
];

const statusResponse = z.object({
  conn: z.enum(["disconnected", "connecting", "connected"]),
  host: z.string(),
  port: z.number(),
  lastError: z.string().nullable(),
  lastRxAgoMs: z.number().nullable(),
  rxMsgCount: z.number(),
  mode: z.string(),
  modeId: z.number(),
  armed: z.boolean(),
  rollDeg: z.number().nullable(),
  pitchDeg: z.number().nullable(),
  yawDeg: z.number().nullable(),
  headingDeg: z.number().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  altMslM: z.number().nullable(),
  altRelM: z.number().nullable(),
  groundspeedMs: z.number().nullable(),
  airspeedMs: z.number().nullable(),
  climbMs: z.number().nullable(),
  throttlePct: z.number().nullable(),
  gpsFix: z.number().nullable(),
  gpsSats: z.number().nullable(),
  gpsHdop: z.number().nullable(),
  battVoltageV: z.number().nullable(),
  battCurrentA: z.number().nullable(),
  battRemainingPct: z.number().nullable(),
  homeLat: z.number().nullable(),
  homeLon: z.number().nullable(),
  ekfHealthy: z.boolean().nullable(),
  rcChannels: z.array(z.number()),
  track: z.array(z.object({
    lat: z.number(), lon: z.number(),
    // Relative altitude of this track point (for the 3D track in the
    // oblique view). Defaulted so a snapshot from an older bridge build
    // (lat/lon only) still validates instead of failing the whole poll.
    altM: z.number().default(0),
  })),
  messages: z.array(z.object({ at: z.string(), severity: z.number(), text: z.string() })),
  acks: z.array(z.object({
    at: z.string(), command: z.number(), commandName: z.string(),
    result: z.number(), resultText: z.string(),
  })),
  joyEnabled: z.boolean(),
  joyStreaming: z.boolean(),
  joyUpdatedAgoMs: z.number().nullable(),
  missionCurrent: z.number().nullable(),
  missionReached: z.number().nullable(),
  paramState: z.string(),
  paramCount: z.number(),
  paramTotal: z.number().nullable(),
  modes: z.array(z.string()),
});

type StatusResponse = z.infer<typeof statusResponse>;
type OkResponse = z.infer<typeof okResponse>;

const okResponse = z.object({ ok: z.boolean(), message: z.string() });

const missionItem = z.object({
  type: z.enum(["takeoff", "waypoint", "land", "rtl", "other"]),
  command: z.number().int().min(0).max(65535).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altM: z.number().min(0).max(120),
});

const missionResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  items: z.array(missionItem),
});

type MissionResponse = z.infer<typeof missionResponse>;

const paramListResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  state: z.string(),
  total: z.number().nullable(),
  params: z.array(z.object({
    name: z.string(),
    value: z.number(),
    ptype: z.number(),
  })),
});

type ParamListResponse = z.infer<typeof paramListResponse>;

const paramSetResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  value: z.number().nullable(),
});

type ParamSetResponse = z.infer<typeof paramSetResponse>;

const aiMissionResult = z.object({
  summary: z.string(),
  items: z.array(z.object({
    type: z.enum(["takeoff", "waypoint", "land", "rtl"]),
    lat: z.number(),
    lon: z.number(),
    altM: z.number(),
  })).min(1).max(40),
});

function haversineM(
  a: { lat: number; lon: number }, b: { lat: number; lon: number },
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function bridge(
  ctx: Ctx, method: "GET" | "POST", path: string, payload?: unknown,
): Promise<Record<string, unknown>> {
  const r = await ctx.executePrivileged(privileged.bridgeCall, {
    method,
    path,
    body: payload === undefined ? "" : JSON.stringify(payload),
  });
  if (r.status >= 400) {
    throw new Error(`ブリッジがエラーを返しました (${r.status}): ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body) as Record<string, unknown>;
}

function disconnectedSnapshot(message: string): StatusResponse {
  return {
    conn: "disconnected", host: "127.0.0.1", port: 5760,
    lastError: message, lastRxAgoMs: null, rxMsgCount: 0,
    mode: "UNKNOWN", modeId: -1, armed: false,
    rollDeg: null, pitchDeg: null, yawDeg: null, headingDeg: null,
    lat: null, lon: null, altMslM: null, altRelM: null,
    groundspeedMs: null, airspeedMs: null, climbMs: null, throttlePct: null,
    gpsFix: null, gpsSats: null, gpsHdop: null,
    battVoltageV: null, battCurrentA: null, battRemainingPct: null,
    homeLat: null, homeLon: null, ekfHealthy: null,
    rcChannels: [], track: [], messages: [], acks: [],
    joyEnabled: false, joyStreaming: false, joyUpdatedAgoMs: null,
    missionCurrent: null, missionReached: null,
    paramState: "idle", paramCount: 0, paramTotal: null,
    modes: COPTER_MODE_NAMES,
  };
}

async function command(
  ctx: Ctx, path: string, payload: unknown,
): Promise<OkResponse> {
  try {
    const r = await bridge(ctx, "POST", path, payload);
    return {
      ok: r.ok === true,
      message: typeof r.message === "string" ? r.message : "",
    };
  } catch (e) {
    return {
      ok: false,
      message: `ブリッジに到達できません: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export const Actions = {
  getStatus: defineAction({
    description: "Returns the current SITL connection state and the latest vehicle telemetry snapshot. If the request carries a joystick payload, it is forwarded to the bridge first, so stick state also rides the client's regular status poll.",
    request: z.object({
      joy: z.object({
        enabled: z.boolean(),
        pitch: z.number().min(-1).max(1),
        roll: z.number().min(-1).max(1),
        yaw: z.number().min(-1).max(1),
        throttle: z.number().min(0).max(1),
      }).optional(),
    }),
    response: statusResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<StatusResponse> {
      if (args.joy) {
        // Piggyback path: deliver the latest stick state on the poll
        // itself (best effort; the dedicated setJoystick action remains
        // the low-latency path).
        await command(ctx, "/joystick", args.joy).catch(() => undefined);
      }
      try {
        const snap = await bridge(ctx, "GET", "/status");
        return {
          ...snap,
          // Tolerate a snapshot from an older bridge build.
          missionCurrent: typeof snap.missionCurrent === "number" ? snap.missionCurrent : null,
          missionReached: typeof snap.missionReached === "number" ? snap.missionReached : null,
          paramState: typeof snap.paramState === "string" ? snap.paramState : "idle",
          paramCount: typeof snap.paramCount === "number" ? snap.paramCount : 0,
          paramTotal: typeof snap.paramTotal === "number" ? snap.paramTotal : null,
          modes: COPTER_MODE_NAMES,
        } as StatusResponse;
      } catch (e) {
        return disconnectedSnapshot(
          `MAVLinkブリッジ未起動: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  }),

  connect: defineAction({
    description: "Connects the GCS MAVLink bridge to the ArduPilot SITL over TCP (auto-starts bridge and SITL if needed).",
    request: z.object({
      host: z.string().min(1).max(64).default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(5760),
    }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/connect", { host: args.host, port: args.port });
    },
  }),

  disconnect: defineAction({
    description: "Disconnects the GCS MAVLink bridge from the SITL.",
    request: z.object({}),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx): Promise<OkResponse> {
      return command(ctx, "/disconnect", {});
    },
  }),

  setMode: defineAction({
    description: "Changes the vehicle's ArduCopter flight mode (e.g. GUIDED, LOITER, RTL, LAND).",
    request: z.object({ mode: z.string().min(1).max(24) }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/mode", { mode: args.mode });
    },
  }),

  arm: defineAction({
    description: "Arms or disarms the vehicle via MAV_CMD_COMPONENT_ARM_DISARM.",
    request: z.object({ armed: z.boolean() }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/arm", { armed: args.armed });
    },
  }),

  takeoff: defineAction({
    description: "Switches to GUIDED, arms, and commands takeoff to the given relative altitude in metres.",
    request: z.object({ altitudeM: z.number().min(1).max(120) }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/takeoff", { altitudeM: args.altitudeM });
    },
  }),

  guidedGoto: defineAction({
    description: "Sends the vehicle to a latitude/longitude at a relative altitude using SET_POSITION_TARGET_GLOBAL_INT in GUIDED mode.",
    request: z.object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
      altM: z.number().min(1).max(120),
    }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/goto", { lat: args.lat, lon: args.lon, altM: args.altM });
    },
  }),

  setJoystick: defineAction({
    description: "Updates the virtual-joystick state (latest-wins; the client keeps one request in flight with an idle heartbeat); while enabled the bridge streams MANUAL_CONTROL at 20 Hz and failsafe-neutrals on stale input.",
    request: z.object({
      enabled: z.boolean(),
      pitch: z.number().min(-1).max(1),
      roll: z.number().min(-1).max(1),
      yaw: z.number().min(-1).max(1),
      throttle: z.number().min(0).max(1),
    }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/joystick", { ...args });
    },
  }),

  uploadMission: defineAction({
    description: "Uploads the edited mission (takeoff/waypoint/land/RTL items) to the vehicle via the MAVLink mission protocol.",
    request: z.object({ items: z.array(missionItem).min(1).max(100) }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/mission/upload", { items: args.items });
    },
  }),

  downloadMission: defineAction({
    description: "Downloads the mission currently stored on the vehicle into the mission editor.",
    request: z.object({}),
    response: missionResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx): Promise<MissionResponse> {
      try {
        const r = await bridge(ctx, "POST", "/mission/download", {});
        // Sanitize whatever the vehicle held (it may have been written
        // by another GCS with values outside the editor's ranges).
        const items = Array.isArray(r.items)
          ? (r.items as Record<string, unknown>[]).flatMap((raw) => {
              const parsed = missionItem.safeParse({
                type: raw.type,
                command: raw.command,
                lat: raw.lat,
                lon: raw.lon,
                altM: typeof raw.altM === "number"
                  ? Math.min(120, Math.max(0, raw.altM))
                  : 0,
              });
              return parsed.success ? [parsed.data] : [];
            })
          : [];
        return {
          ok: r.ok === true,
          message: typeof r.message === "string" ? r.message : "",
          items,
        };
      } catch (e) {
        return {
          ok: false,
          message: `ブリッジに到達できません: ${e instanceof Error ? e.message : String(e)}`,
          items: [],
        };
      }
    },
  }),

  clearMission: defineAction({
    description: "Clears the mission stored on the vehicle (MISSION_CLEAR_ALL).",
    request: z.object({}),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx): Promise<OkResponse> {
      return command(ctx, "/mission/clear", {});
    },
  }),

  startMission: defineAction({
    description: "Starts the uploaded mission: engages AUTO directly when airborne, or takes off in GUIDED to the given altitude first and then switches to AUTO (ArduPilot cannot arm in AUTO and waits for an RC throttle raise on a ground AUTO start).",
    request: z.object({ takeoffAltM: z.number().min(2).max(120).default(10) }),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<OkResponse> {
      return command(ctx, "/mission/start", { takeoffAltM: args.takeoffAltM });
    },
  }),

  fetchParams: defineAction({
    description: "Starts a full parameter download from the vehicle (PARAM_REQUEST_LIST) on the bridge; progress is reported through the getStatus snapshot (paramState/paramCount/paramTotal) and the result is read with getParams.",
    request: z.object({}),
    response: okResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx): Promise<OkResponse> {
      return command(ctx, "/params/fetch", {});
    },
  }),

  getParams: defineAction({
    description: "Returns the parameter cache the bridge holds for the vehicle (name, current value, MAV_PARAM_TYPE), plus the fetch state and the vehicle's reported total count.",
    request: z.object({}),
    response: paramListResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx): Promise<ParamListResponse> {
      try {
        const r = await bridge(ctx, "GET", "/params/list");
        const params = Array.isArray(r.params)
          ? (r.params as Record<string, unknown>[]).flatMap((raw) => {
              const name = typeof raw.name === "string" ? raw.name : "";
              const value = typeof raw.value === "number" ? raw.value : NaN;
              const ptype = typeof raw.ptype === "number" ? raw.ptype : 9;
              return name && Number.isFinite(value) ? [{ name, value, ptype }] : [];
            })
          : [];
        return {
          ok: r.ok === true,
          message: typeof r.message === "string" ? r.message : "",
          state: typeof r.state === "string" ? r.state : "idle",
          total: typeof r.total === "number" ? r.total : null,
          params,
        };
      } catch (e) {
        return {
          ok: false,
          message: `ブリッジに到達できません: ${e instanceof Error ? e.message : String(e)}`,
          state: "error",
          total: null,
          params: [],
        };
      }
    },
  }),

  setParam: defineAction({
    description: "Writes one parameter to the vehicle with PARAM_SET and confirms it from the vehicle's echoed PARAM_VALUE; ok=false means the vehicle did not accept/echo the value.",
    request: z.object({
      name: z.string().min(1).max(16),
      value: z.number().finite(),
    }),
    response: paramSetResponse,
    privileged: [privileged.bridgeCall],
    async handler(ctx, args): Promise<ParamSetResponse> {
      try {
        const r = await bridge(ctx, "POST", "/params/set", {
          name: args.name, value: args.value,
        });
        return {
          ok: r.ok === true,
          message: typeof r.message === "string" ? r.message : "",
          value: typeof r.value === "number" ? r.value : null,
        };
      } catch (e) {
        return {
          ok: false,
          message: `ブリッジに到達できません: ${e instanceof Error ? e.message : String(e)}`,
          value: null,
        };
      }
    },
  }),

  generateMission: defineAction({
    description: "Generates a mission draft from a natural-language instruction with the model, anchored at the vehicle home position. The draft only fills the editor; the user reviews and uploads it explicitly.",
    request: z.object({
      prompt: z.string().min(1).max(500),
      homeLat: z.number().min(-90).max(90).nullable(),
      homeLon: z.number().min(-180).max(180).nullable(),
      vehicleLat: z.number().min(-90).max(90).nullable(),
      vehicleLon: z.number().min(-180).max(180).nullable(),
    }),
    response: missionResponse,
    async handler(ctx, args): Promise<MissionResponse> {
      const anchor =
        args.homeLat !== null && args.homeLon !== null
          ? { lat: args.homeLat, lon: args.homeLon }
          : args.vehicleLat !== null && args.vehicleLon !== null
            ? { lat: args.vehicleLat, lon: args.vehicleLon }
            : null;
      if (!anchor) {
        return {
          ok: false,
          message: "ホーム位置がまだ取得できていません。SITLに接続してGPSが測位してから試してください。",
          items: [],
        };
      }
      const metersPerDegLon = Math.max(
        1000, 111320 * Math.cos((anchor.lat * Math.PI) / 180),
      );
      const prompt = [
        "あなたはドローンのミッション設計者です。ユーザーの指示に沿って、ArduPilotコプターのミッション（飛行経路）を作成してください。",
        "",
        `ホーム位置（離陸地点）: 緯度 ${anchor.lat.toFixed(6)}, 経度 ${anchor.lon.toFixed(6)}`,
        "目安: 緯度1度 ≒ 111320 m、この緯度では経度1度 ≒ " +
          `${Math.round(metersPerDegLon)} m。`,
        "",
        "条件:",
        "- ユーザーが不要と言わない限り、最初のアイテムは離陸（takeoff、ホーム位置、指示がなければ高度10〜20m）にしてください。",
        "- ユーザーが不要と言わない限り、最後のアイテムは着陸（land、ホーム位置）か帰還（rtl）のどちらかにしてください。",
        "- 高度 altM はホームからの相対高度で、3〜60 m の範囲にしてください。指定がなければ 10〜20 m。",
        "- ウェイポイントはホームから 1000 m 以内に収めてください。",
        "- 「北に50m」「右に30m」のような相対指定は、ホーム位置を基準に計算して緯度・経度に変換してください（北=緯度が増える方向、東=経度が増える方向）。",
        "- rtl の緯度・経度はホーム位置、高度は 0 にしてください。land の高度は 0 にしてください。",
        "",
        `ユーザーの指示: 「${args.prompt}」`,
      ].join("\n");
      try {
        const r = await ctx.inference.complete(prompt, { schema: aiMissionResult });
        const items: MissionResponse["items"] = [];
        for (const it of r.items) {
          if (
            !Number.isFinite(it.lat) || !Number.isFinite(it.lon) ||
            it.lat < -90 || it.lat > 90 || it.lon < -180 || it.lon > 180
          ) {
            return {
              ok: false,
              message: "AIが有効な座標を生成できませんでした。指示を変えてもう一度試してください。",
              items: [],
            };
          }
          if (haversineM(anchor, it) > 2000) {
            return {
              ok: false,
              message: "AIがホームから遠すぎる地点を生成しました。範囲を狭めてもう一度試してください。",
              items: [],
            };
          }
          items.push({
            type: it.type,
            lat: Math.round(it.lat * 1e6) / 1e6,
            lon: Math.round(it.lon * 1e6) / 1e6,
            altM: it.type === "land" || it.type === "rtl"
              ? 0
              : Math.min(60, Math.max(2, Math.round(it.altM))),
          });
        }
        return {
          ok: true,
          message: r.summary || "AIがミッションを作成しました",
          items,
        };
      } catch (e) {
        return {
          ok: false,
          message: `AI生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
          items: [],
        };
      }
    },
  }),
} satisfies ActionsModule;
