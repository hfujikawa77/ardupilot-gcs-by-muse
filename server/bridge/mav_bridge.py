#!/usr/bin/env python3
"""MAVLink bridge for the ArduPilot GCS web artifact.

Long-running local daemon (started on demand by the artifact's privileged
bridgeCall handler). Holds the MAVLink TCP connection to the ArduPilot
SITL, caches the latest telemetry, streams MANUAL_CONTROL for the virtual
joystick, and exposes a tiny JSON HTTP API on 127.0.0.1:8766.

It can also launch the SITL itself (the arducopter binary built in
~/workspace/ardupilot) when nothing is listening on the target port yet.
"""
import json
import math
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pymavlink import mavutil

BRIDGE_PORT = 8766
ARDUPILOT_DIR = os.path.expanduser("~/workspace/ardupilot")
SITL_BIN = os.path.join(ARDUPILOT_DIR, "build/sitl/bin/arducopter")
SITL_PARAMS = os.path.join(ARDUPILOT_DIR, "Tools/autotest/default_params/copter.parm")
# The SITL runtime dir (dataflash logs, eeprom) must live OUTSIDE the
# artifact source tree: a running SITL writes logs continuously, and
# those writes kept the tree "dirty" for the artifact build pipeline.
SITL_RUNTIME_DIR = os.path.expanduser("~/.ardupilot-gcs-sitl-runtime")

COPTER_MODES = {
    "STABILIZE": 0, "ACRO": 1, "ALT_HOLD": 2, "AUTO": 3, "GUIDED": 4,
    "LOITER": 5, "RTL": 6, "CIRCLE": 7, "LAND": 9, "DRIFT": 11,
    "SPORT": 13, "POSHOLD": 16, "BRAKE": 17, "SMART_RTL": 21,
    "FLOWHOLD": 22, "FOLLOW": 23, "ZIGZAG": 24,
}
MODE_NAME_BY_ID = {v: k for k, v in COPTER_MODES.items()}
ACK_RESULT_TEXT = {
    0: "ACCEPTED", 1: "TEMPORARILY_REJECTED", 2: "DENIED",
    3: "UNSUPPORTED", 4: "FAILED", 5: "IN_PROGRESS", 6: "CANCELLED",
}
COMMAND_NAME = {400: "ARM_DISARM", 22: "NAV_TAKEOFF", 21: "NAV_LAND", 20: "NAV_RTL"}
MAV_CMD_COMPONENT_ARM_DISARM = 400
MAV_CMD_NAV_TAKEOFF = 22
GOTO_MASK = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 7) | (1 << 8) | (1 << 10) | (1 << 11)
NEUTRAL = {"pitch": 0.0, "roll": 0.0, "yaw": 0.0, "throttle": 0.5}

lock = threading.Lock()
mav_lock = threading.Lock()

S = {
    "conn": "disconnected", "host": "127.0.0.1", "port": 5760,
    "lastError": None, "wantConnected": False,
    "mav": None, "lastRxAt": 0.0, "rxMsgCount": 0,
    "mode": "UNKNOWN", "modeId": -1, "armed": False,
    "rollDeg": None, "pitchDeg": None, "yawDeg": None, "headingDeg": None,
    "lat": None, "lon": None, "altMslM": None, "altRelM": None,
    "groundspeedMs": None, "airspeedMs": None, "climbMs": None,
    "throttlePct": None,
    "gpsFix": None, "gpsSats": None, "gpsHdop": None,
    "battVoltageV": None, "battCurrentA": None, "battRemainingPct": None,
    "homeLat": None, "homeLon": None,
    "ekfHealthy": None, "rcChannels": [],
    "track": [], "messages": [], "acks": [],
    "joyEnabled": False, "joyAxes": dict(NEUTRAL), "joyUpdatedAt": 0.0,
    "joyStreaming": False, "sitlPid": None,
}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"


def push_log(severity, text):
    with lock:
        S["messages"].insert(0, {"at": now_iso(), "severity": severity, "text": text})
        del S["messages"][100:]


def port_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


def ensure_sitl(host, port):
    """Start the SITL binary if nothing listens on the target port."""
    if port_open(host, port):
        return True
    if not os.path.exists(SITL_BIN):
        push_log(3, f"SITLバイナリが見つかりません: {SITL_BIN}")
        return False
    os.makedirs(SITL_RUNTIME_DIR, exist_ok=True)
    log_path = os.path.join(SITL_RUNTIME_DIR, "sitl.log")
    try:
        with open(log_path, "ab") as logf:
            proc = subprocess.Popen(
                [SITL_BIN, "-S", "--model", "+", "--speedup", "1",
                 "--defaults", SITL_PARAMS],
                cwd=SITL_RUNTIME_DIR, stdout=logf, stderr=logf,
                start_new_session=True)
        with lock:
            S["sitlPid"] = proc.pid
        push_log(6, f"SITLを起動しました (pid {proc.pid})")
    except Exception as e:  # noqa: BLE001
        push_log(3, f"SITL起動に失敗: {e}")
        return False
    for _ in range(60):
        if port_open(host, port):
            return True
        time.sleep(0.5)
    return False


def dispatch(msg):
    t = msg.get_type()
    with lock:
        S["rxMsgCount"] += 1
        S["lastRxAt"] = time.time()
        if t == "HEARTBEAT":
            S["modeId"] = msg.custom_mode
            S["mode"] = MODE_NAME_BY_ID.get(msg.custom_mode, f"MODE{msg.custom_mode}")
            S["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
        elif t == "ATTITUDE":
            S["rollDeg"] = math.degrees(msg.roll)
            S["pitchDeg"] = math.degrees(msg.pitch)
            S["yawDeg"] = math.degrees(msg.yaw) % 360
        elif t == "GLOBAL_POSITION_INT":
            lat, lon = msg.lat / 1e7, msg.lon / 1e7
            if lat != 0 or lon != 0:
                S["lat"], S["lon"] = lat, lon
                tr = S["track"]
                if not tr or abs(tr[-1]["lat"] - lat) > 1e-6 or abs(tr[-1]["lon"] - lon) > 1e-6:
                    # altM (relative altitude) rides along so the client
                    # can draw the track as a true 3D path in the oblique
                    # view instead of a ground-hugging 2D line.
                    tr.append({"lat": lat, "lon": lon, "altM": msg.relative_alt / 1000})
                    del tr[:-2000]
            S["altMslM"] = msg.alt / 1000
            S["altRelM"] = msg.relative_alt / 1000
            S["groundspeedMs"] = math.hypot(msg.vx / 100, msg.vy / 100)
            if msg.hdg != 65535:
                S["headingDeg"] = msg.hdg / 100
        elif t == "VFR_HUD":
            S["airspeedMs"] = msg.airspeed
            S["groundspeedMs"] = msg.groundspeed
            S["altMslM"] = msg.alt
            S["climbMs"] = msg.climb
            S["headingDeg"] = msg.heading
            S["throttlePct"] = msg.throttle
        elif t == "GPS_RAW_INT":
            S["gpsFix"] = msg.fix_type
            S["gpsSats"] = msg.satellites_visible
            S["gpsHdop"] = None if msg.eph == 65535 else msg.eph / 100
        elif t == "SYS_STATUS":
            if msg.voltage_battery != 65535:
                S["battVoltageV"] = msg.voltage_battery / 1000
            if msg.current_battery != -1:
                S["battCurrentA"] = msg.current_battery / 100
            if msg.battery_remaining != -1:
                S["battRemainingPct"] = msg.battery_remaining
        elif t == "BATTERY_STATUS":
            if msg.battery_remaining != -1:
                S["battRemainingPct"] = msg.battery_remaining
            if msg.current_battery != -1:
                S["battCurrentA"] = msg.current_battery / 100
        elif t == "RC_CHANNELS":
            chans = [getattr(msg, f"chan{i}_raw") for i in range(1, 19)]
            S["rcChannels"] = chans[:msg.chancount]
        elif t == "HOME_POSITION":
            lat, lon = msg.latitude / 1e7, msg.longitude / 1e7
            if lat != 0 or lon != 0:
                S["homeLat"], S["homeLon"] = lat, lon
        elif t == "EKF_STATUS_REPORT":
            f = msg.flags
            S["ekfHealthy"] = bool(f & 0x01) and bool(f & 0x02) and bool(f & 0x0C)
        elif t == "STATUSTEXT":
            text = msg.text
            if isinstance(text, bytes):
                text = text.decode("utf-8", "replace")
            text = text.strip("\x00").strip()
            if text:
                S["messages"].insert(
                    0, {"at": now_iso(), "severity": msg.severity, "text": text})
                del S["messages"][100:]
        elif t == "COMMAND_ACK":
            S["acks"].insert(0, {
                "at": now_iso(), "command": msg.command,
                "commandName": COMMAND_NAME.get(msg.command, f"CMD{msg.command}"),
                "result": msg.result,
                "resultText": ACK_RESULT_TEXT.get(msg.result, f"RESULT{msg.result}"),
            })
            del S["acks"][20:]


def send_manual(mav, axes):
    cl = lambda v: max(-1000, min(1000, int(round(v * 1000))))  # noqa: E731
    with mav_lock:
        mav.mav.manual_control_send(
            mav.target_system, cl(axes["pitch"]), cl(axes["roll"]),
            max(0, min(1000, int(round(axes["throttle"] * 1000)))),
            cl(axes["yaw"]), 0)


def mav_loop():
    while True:
        with lock:
            want = S["wantConnected"]
            host, port = S["host"], S["port"]
        if not want:
            time.sleep(0.3)
            continue
        mav = None
        try:
            mav = mavutil.mavlink_connection(
                f"tcp:{host}:{port}", source_system=255, source_component=190)
            with lock:
                S["mav"] = mav
                S["conn"] = "connecting"
            hb = mav.wait_heartbeat(timeout=15)
            if hb is None:
                raise TimeoutError("HEARTBEATタイムアウト")
            with lock:
                S["conn"] = "connected"
                S["lastError"] = None
                S["track"] = []
            push_log(6, f"SITLへ接続しました ({host}:{port})")
            mav.mav.request_data_stream_send(
                mav.target_system, mav.target_component,
                mavutil.mavlink.MAV_DATA_STREAM_ALL, 8, 1)
            last_hb = 0.0
            last_stream_req = time.time()
            last_joy = 0.0
            while True:
                with lock:
                    if not S["wantConnected"]:
                        break
                msg = mav.recv_match(blocking=True, timeout=0.25)
                if msg is not None:
                    dispatch(msg)
                now = time.time()
                if now - last_hb > 1.0:
                    last_hb = now
                    with mav_lock:
                        mav.mav.heartbeat_send(
                            mavutil.mavlink.MAV_TYPE_GCS,
                            mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
                if now - last_stream_req > 10:
                    last_stream_req = now
                    with mav_lock:
                        mav.mav.request_data_stream_send(
                            mav.target_system, mav.target_component,
                            mavutil.mavlink.MAV_DATA_STREAM_ALL, 8, 1)
                # joystick streaming at 20 Hz. While enabled we ALWAYS
                # send a frame: the latest axes while client updates are
                # fresh, NEUTRAL once they go stale — a silent gap would
                # hand the vehicle back to the SITL's idle RC defaults
                # (throttle low) instead of a safe hover. The client now
                # sends latest-wins with a ~2 s heartbeat, but its action
                # channel can take seconds per round trip, so freshness
                # gets a 4 s window; after 30 s of silence the joystick
                # auto-disables so a closed page can't pin the stream on.
                if now - last_joy >= 0.05:
                    last_joy = now
                    with lock:
                        joy_on = S["joyEnabled"]
                        stale_for = now - S["joyUpdatedAt"]
                        fresh = stale_for < 6.0
                        axes = dict(S["joyAxes"])
                        streaming = S["joyStreaming"]
                    if joy_on:
                        send_manual(mav, axes if fresh else NEUTRAL)
                        with lock:
                            S["joyStreaming"] = fresh
                        if not fresh and streaming:
                            push_log(4, "ジョイスティック入力が途絶えたため中立化しました")
                        if stale_for > 30:
                            with lock:
                                S["joyEnabled"] = False
                                S["joyStreaming"] = False
                            push_log(4, "ジョイスティック入力が30秒途絶えたため自動で無効化しました")
                with lock:
                    stale = time.time() - S["lastRxAt"] > 12 and S["rxMsgCount"] > 0
                if stale:
                    raise TimeoutError("テレメトリが12秒途絶えました")
        except Exception as e:  # noqa: BLE001
            with lock:
                if S["wantConnected"]:
                    S["conn"] = "disconnected"
                    S["lastError"] = f"接続エラー: {e}"
                    S["joyStreaming"] = False
            time.sleep(2)
        finally:
            with lock:
                if S["mav"] is mav:
                    S["mav"] = None
                if not S["wantConnected"]:
                    S["conn"] = "disconnected"
            try:
                if mav is not None:
                    mav.close()
            except Exception:  # noqa: BLE001
                pass


def get_mav():
    with lock:
        return S["mav"] if S["conn"] == "connected" else None


def cmd_set_mode(name):
    mav = get_mav()
    mode_id = COPTER_MODES.get(name.upper())
    if mode_id is None:
        return {"ok": False, "message": f"未知のモードです: {name}"}
    if mav is None:
        return {"ok": False, "message": "未接続のためモード変更を送信できません"}
    with mav_lock:
        mav.mav.set_mode_send(
            mav.target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode_id)
    push_log(6, f"モード変更を送信: {name.upper()}")
    return {"ok": True, "message": f"{name.upper()} への変更を送信しました"}


def cmd_arm(armed):
    mav = get_mav()
    if mav is None:
        return {"ok": False, "message": "未接続のためアームコマンドを送信できません"}
    with mav_lock:
        mav.mav.command_long_send(
            mav.target_system, mav.target_component,
            MAV_CMD_COMPONENT_ARM_DISARM, 0, 1 if armed else 0, 0, 0, 0, 0, 0, 0)
    push_log(6, "ARMを送信" if armed else "DISARMを送信")
    return {"ok": True, "message": "ARMを送信しました" if armed else "DISARMを送信しました"}


def cmd_takeoff(alt_m):
    mav = get_mav()
    if mav is None:
        return {"ok": False, "message": "未接続のため離陸できません"}

    def seq():
        try:
            cmd_set_mode("GUIDED")
            time.sleep(0.4)
            with lock:
                armed = S["armed"]
            if not armed:
                r = cmd_arm(True)
                if not r.get("ok"):
                    push_log(3, f"離陸中止: {r.get('message')}")
                    return
                time.sleep(0.7)
            m2 = get_mav()
            if m2 is not None:
                with mav_lock:
                    m2.mav.command_long_send(
                        m2.target_system, m2.target_component,
                        MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, float(alt_m))
            push_log(6, f"離陸シーケンス: GUIDED → ARM → TAKEOFF {alt_m}m")
        except Exception as e:  # noqa: BLE001
            push_log(3, f"離陸シーケンスでエラー: {e}")

    threading.Thread(target=seq, daemon=True).start()
    return {"ok": True, "message": f"離陸コマンドを送信しました（目標高度 {alt_m} m）"}


def cmd_goto(lat, lon, alt_m):
    mav = get_mav()
    if mav is None:
        return {"ok": False, "message": "未接続のため移動コマンドを送信できません"}
    with lock:
        mode = S["mode"]
    if mode != "GUIDED":
        cmd_set_mode("GUIDED")
        time.sleep(0.3)
        mav = get_mav()
        if mav is None:
            return {"ok": False, "message": "移動コマンドの送信に失敗しました"}
    with mav_lock:
        mav.mav.set_position_target_global_int_send(
            0, mav.target_system, mav.target_component,
            mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
            GOTO_MASK, int(round(lat * 1e7)), int(round(lon * 1e7)),
            float(alt_m), 0, 0, 0, 0, 0, 0, 0, 0)
    push_log(6, f"Guided Goto: {lat:.6f}, {lon:.6f} @ {alt_m}m")
    return {"ok": True, "message": "目標地点への移動を送信しました"}


def cmd_connect(host, port):
    with lock:
        S["host"] = host
        S["port"] = port
        S["wantConnected"] = True
        S["lastError"] = None
    if not port_open(host, port):
        ensure_sitl(host, port)
    deadline = time.time() + 25
    while time.time() < deadline:
        with lock:
            if S["conn"] == "connected":
                return {"ok": True, "message": f"{host}:{port} に接続しました"}
            err = S["lastError"]
        if err and "タイムアウト" in err:
            break
        time.sleep(0.4)
    with lock:
        err = S["lastError"]
    return {"ok": False, "message": f"接続できませんでした: {err or 'タイムアウト'}"}


def cmd_disconnect():
    mav = get_mav()
    with lock:
        was_streaming = S["joyStreaming"]
        S["wantConnected"] = False
        S["joyEnabled"] = False
        S["joyStreaming"] = False
    if mav is not None and was_streaming:
        try:
            send_manual(mav, NEUTRAL)
        except Exception:  # noqa: BLE001
            pass
    time.sleep(0.4)
    with lock:
        S["conn"] = "disconnected"
    return {"ok": True, "message": "切断しました"}


def cmd_joystick(body):
    with lock:
        was = S["joyEnabled"]
        S["joyEnabled"] = bool(body.get("enabled"))
        S["joyAxes"] = {
            "pitch": float(body.get("pitch", 0)),
            "roll": float(body.get("roll", 0)),
            "yaw": float(body.get("yaw", 0)),
            "throttle": float(body.get("throttle", 0.5)),
        }
        S["joyUpdatedAt"] = time.time()
    if not body.get("enabled") and was:
        mav = get_mav()
        if mav is not None:
            try:
                send_manual(mav, NEUTRAL)
            except Exception:  # noqa: BLE001
                pass
        with lock:
            S["joyStreaming"] = False
        push_log(6, "ジョイスティック無効化: 中立フレームを送信")
    return {"ok": True, "message": "ジョイスティック有効" if body.get("enabled") else "ジョイスティック無効"}


def snapshot():
    with lock:
        s = dict(S)
    last_rx = s["lastRxAt"]
    return {
        "conn": s["conn"], "host": s["host"], "port": s["port"],
        "lastError": s["lastError"],
        "lastRxAgoMs": None if not last_rx else int((time.time() - last_rx) * 1000),
        "rxMsgCount": s["rxMsgCount"],
        "mode": s["mode"], "modeId": s["modeId"], "armed": s["armed"],
        "rollDeg": s["rollDeg"], "pitchDeg": s["pitchDeg"],
        "yawDeg": s["yawDeg"], "headingDeg": s["headingDeg"],
        "lat": s["lat"], "lon": s["lon"],
        "altMslM": s["altMslM"], "altRelM": s["altRelM"],
        "groundspeedMs": s["groundspeedMs"], "airspeedMs": s["airspeedMs"],
        "climbMs": s["climbMs"], "throttlePct": s["throttlePct"],
        "gpsFix": s["gpsFix"], "gpsSats": s["gpsSats"], "gpsHdop": s["gpsHdop"],
        "battVoltageV": s["battVoltageV"], "battCurrentA": s["battCurrentA"],
        "battRemainingPct": s["battRemainingPct"],
        "homeLat": s["homeLat"], "homeLon": s["homeLon"],
        "ekfHealthy": s["ekfHealthy"],
        "rcChannels": s["rcChannels"],
        "track": s["track"][-600:],
        "messages": s["messages"][:60],
        "acks": s["acks"][:8],
        "joyEnabled": s["joyEnabled"], "joyStreaming": s["joyStreaming"],
        "joyUpdatedAgoMs": None if not s["joyUpdatedAt"] else int((time.time() - s["joyUpdatedAt"]) * 1000),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
        elif self.path == "/status":
            self._json(200, snapshot())
        else:
            self._json(404, {"ok": False, "message": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:  # noqa: BLE001
            body = {}
        try:
            if self.path == "/connect":
                self._json(200, cmd_connect(
                    str(body.get("host", "127.0.0.1")), int(body.get("port", 5760))))
            elif self.path == "/disconnect":
                self._json(200, cmd_disconnect())
            elif self.path == "/mode":
                self._json(200, cmd_set_mode(str(body.get("mode", ""))))
            elif self.path == "/arm":
                self._json(200, cmd_arm(bool(body.get("armed"))))
            elif self.path == "/takeoff":
                self._json(200, cmd_takeoff(float(body.get("altitudeM", 10))))
            elif self.path == "/goto":
                self._json(200, cmd_goto(
                    float(body["lat"]), float(body["lon"]), float(body.get("altM", 10))))
            elif self.path == "/joystick":
                self._json(200, cmd_joystick(body))
            else:
                self._json(404, {"ok": False, "message": "not found"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"ok": False, "message": f"bridge error: {e}"})


def main():
    threading.Thread(target=mav_loop, daemon=True).start()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), Handler)
    except OSError:
        # another bridge instance is already running; exit quietly
        return
    sys.stderr.write(f"mav_bridge listening on 127.0.0.1:{BRIDGE_PORT}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
