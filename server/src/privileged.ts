// Privileged host bundle for the ArduPilot GCS.
//
// The MAVLink connection itself lives in a long-running local bridge
// daemon (server/bridge/mav_bridge.py, pymavlink) that exposes a small
// JSON HTTP API on 127.0.0.1:8766 — privileged calls here are short-lived,
// so they cannot own the socket directly. This handler simply forwards
// each request to the bridge over node:http, and starts the bridge
// (detached) when it is not running yet.

import { spawn } from "node:child_process";
import { request } from "node:http";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 8766;
const BRIDGE_SCRIPT =
  "/home/hatch/workspace/ts-spaces/ardupilot-gcs/server/bridge/mav_bridge.py";
const BRIDGE_PYTHON = "/home/hatch/venv-ardupilot/bin/python3";

interface BridgeReply { status: number; body: string }

function httpCall(method: string, path: string, body: string): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(body, "utf8") : null;
    const req = request(
      {
        host: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path,
        method,
        agent: false,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": data.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
      },
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("bridge request timeout")));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bridgeCall(method: string, path: string, body: string): Promise<BridgeReply> {
  try {
    return await httpCall(method, path, body);
  } catch (e) {
    if ((e as { code?: string }).code !== "ECONNREFUSED") throw e;
  }
  // Bridge not running: start it detached so it outlives this call.
  const child = spawn(BRIDGE_PYTHON, [BRIDGE_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 20000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    await sleep(400);
    try {
      return await httpCall(method, path, body);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `MAVLinkブリッジを起動できませんでした: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

export const privileged = definePrivilegedContracts({
  bridgeCall: {
    request: z.object({
      method: z.enum(["GET", "POST"]),
      path: z.string().min(1).max(64),
      body: z.string().max(32768),
    }),
    response: z.object({ status: z.number(), body: z.string() }),
    timeoutMs: 30000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async bridgeCall(args) {
    return bridgeCall(args.method, args.path, args.body);
  },
});
