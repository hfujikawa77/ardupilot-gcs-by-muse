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
  modes: z.array(z.string()),
});

type StatusResponse = z.infer<typeof statusResponse>;
type OkResponse = z.infer<typeof okResponse>;

const okResponse = z.object({ ok: z.boolean(), message: z.string() });

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
    joyEnabled: false, joyStreaming: false, joyUpdatedAgoMs: null, modes: COPTER_MODE_NAMES,
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
        return { ...snap, modes: COPTER_MODE_NAMES } as StatusResponse;
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
} satisfies ActionsModule;
