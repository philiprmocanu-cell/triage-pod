#!/usr/bin/env python3
"""Triage Pod camera bridge: reads pictures from the Grove Vision AI V2 over its own USB-C and serves them to the app.

    python3 hardware/pod-camera-bridge.py                      # finds the vision board on USB, serves http://localhost:3419/frame
    python3 hardware/pod-camera-bridge.py --port /dev/cu.usbmodem5B420578071 --http 3419

The vision board answers plain text commands over USB at 921600 baud. "AT+SAMPLE=1\\r\\n" returns one JSON line that
holds a base64 JPEG under "image". This program asks for pictures back to back and keeps the newest one.

    GET /frame   -> the newest picture as base64 JPEG text (header X-Frame-Age-Ms), 503 before the first picture
    GET /vitals  -> {"camera": true/false, "frames": n}  (so the kiosk's ?pod=localhost:3419 works the same as before)

The vision board shows up as a WCH serial device (vendor id 1A86); the finger unit (XIAO nRF52840) as Seeed (2886),
so the two bridges never grab each other's port. Needs python3 + pyserial.
"""
import argparse, glob, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    sys.exit("pyserial is missing: run  pip3 install pyserial")

BAUD = 921600
VISION_VID = 0x1A86   # WCH CH343 on the Grove Vision AI V2

state = {"frame": None, "at": 0.0, "frames": 0, "camera": False, "port": None}
lock = threading.Lock()

def find_port(explicit):
    if explicit:
        return explicit
    for p in list_ports.comports():
        if p.vid == VISION_VID:
            return p.device
    return None

def ask(ser, cmd, name, timeout):
    """Send one command; return the JSON text of the reply line whose name matches, or ''."""
    ser.reset_input_buffer()
    ser.write((cmd + "\r\n").encode())
    t0 = time.time()
    buf = b""
    while time.time() - t0 < timeout:
        chunk = ser.read(4096)
        if not chunk:
            continue
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if b"{" in line and name.encode() in line:
                return line[line.index(b"{"):].decode("utf-8", "replace")
    return ""

def image_of(reply):
    k = reply.find('"image":"')
    if k < 0:
        return ""
    s = k + 9
    e = reply.find('"', s)
    return reply[s:e] if e > s else ""

def camera_loop(args):
    while True:
        port = find_port(args.port)
        if not port:
            print(f"{time.strftime('%H:%M:%S')}  waiting for the vision board on USB", flush=True)
            time.sleep(1)
            continue
        try:
            ser = serial.Serial(port, args.baud, timeout=0.2)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')}  {port}: cannot open ({e}); retrying", flush=True)
            time.sleep(1)
            continue
        print(f"{time.strftime('%H:%M:%S')}  vision board on {port}", flush=True)
        time.sleep(1.5)                                   # the board reboots when the port opens
        ask(ser, "AT+SENSOR=1,1,1", "SENSOR", 2.0)        # camera on, 480x480
        last_print = 0.0
        misses = 0
        try:
            while True:
                img = image_of(ask(ser, "AT+SAMPLE=1", "SAMPLE", 3.0))
                if len(img) > 1000:
                    with lock:
                        state.update(frame=img, at=time.time(), frames=state["frames"] + 1, camera=True, port=port)
                    misses = 0
                else:
                    misses += 1
                    if misses >= 5:
                        with lock:
                            state["camera"] = False
                if time.time() - last_print >= 1.0:
                    last_print = time.time()
                    with lock:
                        print(f"{time.strftime('%H:%M:%S')}  pictures {state['frames']}  camera {'yes' if state['camera'] else 'NO'}", flush=True)
                if misses >= 20:
                    raise serial.SerialException("no pictures for 20 tries")
        except (serial.SerialException, OSError) as e:
            print(f"{time.strftime('%H:%M:%S')}  {port}: lost ({e}); looking again", flush=True)
            with lock:
                state["camera"] = False
            try:
                ser.close()
            except Exception:
                pass
            time.sleep(1)

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/frame":
            with lock:
                f, at = state["frame"], state["at"]
            if not f:
                self.send_response(503); self._cors(); self.end_headers(); self.wfile.write(b"no picture yet"); return
            body = f.encode()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "text/plain")
            self.send_header("X-Frame-Age-Ms", str(int((time.time() - at) * 1000)))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        elif path == "/vitals":
            with lock:
                body = json.dumps({"camera": state["camera"], "frames": state["frames"], "sensor": False}).encode()
            self.send_response(200); self._cors()
            self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        else:
            body = b"Triage Pod camera bridge. /frame (base64 JPEG), /vitals (JSON)."
            self.send_response(200); self._cors(); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Triage Pod camera bridge (Grove Vision AI V2 over USB)")
    ap.add_argument("--port", help="serial port of the vision board (default: first WCH device)")
    ap.add_argument("--http", type=int, default=3419, help="local port to serve /frame on")
    ap.add_argument("--baud", type=int, default=BAUD, help="serial speed (the vision board uses 921600)")
    args = ap.parse_args()
    threading.Thread(target=camera_loop, args=(args,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.http), H)
    print(f"serving http://localhost:{args.http}/frame", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\ncamera bridge stopped")
