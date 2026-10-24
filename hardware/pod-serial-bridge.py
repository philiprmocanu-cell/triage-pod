#!/usr/bin/env python3
"""Triage Pod serial bridge: reads the finger unit (XIAO nRF52840 + MAX30101) over USB and feeds the laptop app.

    python3 hardware/pod-serial-bridge.py                 # finds /dev/cu.usbmodem*, posts to http://localhost:3418
    python3 hardware/pod-serial-bridge.py --port /dev/cu.usbmodem101 --url http://localhost:3418

Every second it POSTs to <url>/api/session:
    {"vitals": {"podConnected": true, "finger": bool, "presses": int, "spo2": int?, "hr": int?, "at": ms}}
(spo2 / hr are left out while the pod reports 0 = no valid reading). If the USB cable drops it POSTs
    {"vitals": {"podConnected": false, "at": ms}}
once, then keeps looking for the port. One line per second on the terminal shows it is alive.
Needs: python3 + pyserial (pip3 install pyserial).
"""
import argparse, glob, json, sys, time, urllib.request, urllib.error

try:
    import serial
except ImportError:
    sys.exit("pyserial is missing: run  pip3 install pyserial")

BAUD = 115200

def find_port(explicit):
    if explicit:
        return explicit
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    return ports[0] if ports else None

def post(url, vitals):
    body = json.dumps({"vitals": vitals}).encode()
    req = urllib.request.Request(url + "/api/session", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return f"no app ({e.__class__.__name__})"

def now_ms():
    return int(time.time() * 1000)

def run(args):
    url = args.url.rstrip("/")
    connected_said = False
    while True:
        port = find_port(args.port)
        if not port:
            print(f"{time.strftime('%H:%M:%S')}  waiting for the pod on USB (no /dev/cu.usbmodem*)", flush=True)
            time.sleep(1)
            continue
        try:
            ser = serial.Serial(port, BAUD, timeout=1.5)
        except Exception as e:
            print(f"{time.strftime('%H:%M:%S')}  {port}: cannot open ({e}); retrying", flush=True)
            time.sleep(1)
            continue
        print(f"{time.strftime('%H:%M:%S')}  pod on {port}", flush=True)
        last_post = 0.0
        latest = None
        try:
            while True:
                line = ser.readline().decode("utf-8", "replace").strip()
                if line.startswith("{"):
                    try:
                        latest = json.loads(line)
                    except ValueError:
                        latest = None
                if time.time() - last_post >= 1.0:
                    last_post = time.time()
                    if latest is None:
                        print(f"{time.strftime('%H:%M:%S')}  {port}: no reading yet", flush=True)
                        continue
                    v = {"podConnected": True, "finger": bool(latest.get("finger", False)),
                         "presses": int(latest.get("presses", 0)), "at": now_ms()}
                    for k in ("spo2", "hr"):
                        try:
                            val = int(latest.get(k, 0))
                        except (TypeError, ValueError):
                            val = 0
                        if val > 0:
                            v[k] = val
                    st = post(url, v)
                    connected_said = True
                    print(f"{time.strftime('%H:%M:%S')}  finger={'yes' if v['finger'] else 'no '}  hr={v.get('hr', '--'):>3}  spo2={v.get('spo2', '--'):>3}  presses={v['presses']}  -> {st}", flush=True)
        except (serial.SerialException, OSError) as e:
            print(f"{time.strftime('%H:%M:%S')}  {port}: lost ({e.__class__.__name__}); looking again", flush=True)
            try:
                ser.close()
            except Exception:
                pass
            if connected_said:
                post(url, {"podConnected": False, "at": now_ms()})
                connected_said = False
            time.sleep(1)

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Triage Pod USB serial bridge")
    ap.add_argument("--port", help="serial port (default: first /dev/cu.usbmodem*)")
    ap.add_argument("--url", default="http://localhost:3418", help="laptop app base URL")
    try:
        run(ap.parse_args())
    except KeyboardInterrupt:
        print("\nbridge stopped")
