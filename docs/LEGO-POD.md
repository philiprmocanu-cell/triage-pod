# Triage Pod — the finger unit, built from the watch, no soldering

What the pod is now (Philip, 2026-10-24): **the watch's parts, rebuilt at the venue from stock boards.** No camera on the pod: the laptop's own camera does the looking. The finger unit is the watch's XIAO nRF52840 Sense on a breadboard with the red MAX30101 sensor, on a USB cable to the laptop. The old Zoron camera pod stays whole and in its case; the spare brain board and the small OV3660 camera stay in the drawer.

Rule check (Cal Hacks 13.0 Hacker Guide): "All projects must be started during the event." No soldering inside the venue. So: scissors at home, plugs at the table.

The link: the XIAO nRF52840 has no Wi-Fi. It talks over the **USB cable** to the laptop. A small bridge program on the laptop (`hardware/pod-serial-bridge.py`) reads it and feeds the app; the kiosk URL stays `http://localhost:3418/kiosk?village=Katete` with the laptop webcam.

Picture booklet of every step below (Lego style, one action per page): `hardware/booklet/Triage Pod — From the Watch.pdf`, 23 pages, also on the Desktop. Pages 1–12 take the watch apart at home, 13–18 plug together at the table, 19–23 power up.

Decisions taken 2026-10-24 (Philip: "that's it"): no screen on the pod, USB power only, the breadboard Philip owns (half-size), and **the sensor stays plugged into the DRV board: the DRV's four wires are cut off the XIAO's pin tops and pushed into the breadboard rows** (red 3V3, black GND, white D4, yellow D5). No new cable needed. The DRV just passes the sensor through.

Open questions (answers change the pages, not the plan): is the sensor's four-colour cable soldered into its holes or plugged into its black socket; screen on the pod or not; battery or USB only. Below assumes: cable to be checked, no screen, USB only.

## What you take from the watch (at home, scissors only)

| Part | Where it is | What to do |
|---|---|---|
| **XIAO nRF52840 Sense** (factory pins) | plugged into the back of the round screen board; four wires (red/black/white/yellow) soldered to the tops of its pins, going to the navy DRV board | watch switch OFF. Cut the four wires at the XIAO's pins with scissors (a stub of solder stays on each pin; fine). Lift the XIAO straight up out of the screen's sockets |
| **Red MAX30101 sensor + DRV board + motor** | the sensor's cable is plugged into the DRV's white socket; the DRV's four wires go to the XIAO | after the four cuts at the XIAO, lift the DRV with the sensor and motor out as one piece. Nothing on it is unplugged. **Send a close-up of where the cable enters the red board:** if it is soldered into the holes, the sensor gets a new Qwiic cable into one of its two black sockets; if it is a plug, the socket is free for the new cable too. See "Cable" below |
| Screen board, DRV board, buzz motor, 500 mAh battery | the rest of the watch | not used. Leave them as they are |
| **USB-C data cable** | your bag | the pod's power and its link to the laptop |

## Cable

The sensor must reach four XIAO rows on the breadboard: GND, 3V3, D4, D5. The way chosen: the sensor stays on the DRV board and the DRV's four wires go into the rows (see the booklet). Alternative, if a cable turns up: a **Qwiic-to-pins cable** (small white plug on one end, four loose pins on the other, SparkFun "Qwiic Cable – Breadboard Jumper" / Adafruit 4209): plug into either black socket on the red board, pins into the breadboard. If none can be had: four male-female jumper wires from the Arduino kit onto the sensor's existing cable pins, or (fallback) a MAX30102 module with header pins from the rental booth's sensor assortment, same program.

## What you get at the venue (rental booth, from 6 PM Friday)

- **Arduino Uno kit**: breadboard + jumper wires.
- **Qwiic-to-pins cable** (see Cable). Ask at the MLH Hardware Lab first.

## The build at the table (every joint is a plug)

1. Push the XIAO into the breadboard so one pin row is above the middle gap and the other below it, USB-C pointing off the short edge. Each pin now owns a row of five holes.
2. Strip 5 mm off each of the DRV's four cut wires, twist tight, and push them into the breadboard rows of these XIAO pins:

| DRV wire | XIAO pin |
|---|---|
| black | GND (right column, 2nd pin from USB-C) |
| red | 3V3 (right column, 3rd pin). **Never 5V** |
| white | D4 (left column, 5th pin) |
| yellow | D5 (left column, 6th pin) |

Pin map of the XIAO nRF52840 Sense, USB-C pointing up, component side up: left column D0 D1 D2 D3 D4 D5 D6 top to bottom; right column 5V GND 3V3 D10 D9 D8 D7. Same layout as the ESP32-S3.

```
                USB-C
          ┌───────────────┐
   D0  ●  │               │  ●  5V
   D1  ●  │               │  ●  GND  ← black
   D2  ●  │  XIAO         │  ●  3V3  ← red
   D3  ●  │  nRF52840     │  ●  D10
   D4  ●  │  Sense        │  ●  D9      D4 ← white (SDA)
   D5  ●  │               │  ●  D8      D5 ← yellow (SCL)
   D6  ●  │               │  ●  D7
          └───────────────┘
```

3. Optional Talk button: one jumper wire in the D0 row; touching its free end to a GND-row hole counts as a press. (Or a push button from the Arduino kit between D0 and GND.)
4. Look before power: the red pin is in the 3V3 row, not 5V; no two pins share a row.

## Camera (Philip, 12:30): the spare vision board, on its own USB cable

The pod gets its eyes back: the **spare Grove Vision AI V2** with the ribbon camera from its box latched in. The laptop reads its pictures straight over the vision board's own USB-C (`hardware/pod-camera-bridge.py` asks it for a picture over and over and serves them at `http://localhost:3419/frame`). The watch's XIAO nRF52840 plugs into the vision board's back sockets, so the pod is one stack; the XIAO still reads the finger sensor and sends the numbers over ITS USB-C. Two USB cables to the laptop. The small OV3660 camera board does not fit the vision board's socket.

With the XIAO seated, the breadboard is not needed. The sensor reaches the XIAO's D4/D5 through the vision board's white **Grove port** on its back: plug the Grove cable from the vision board's box into it, cut the other plug off, twist its four wires to the DRV's four wires colour to colour (red–red, black–black, white–white, yellow–yellow), tape each twist. Before power, one meter check: Grove white pin to the XIAO's D4 pin top beeps; Grove red pin to the XIAO's 3V3 pin top beeps. (The pages for this build are not drawn yet; the breadboard booklet still shows the finger side correctly: same four wires, same four XIAO pins.)

Run, before the demo, two terminals:

```bash
python3 hardware/pod-camera-bridge.py
```

```bash
python3 hardware/pod-serial-bridge.py
```

Kiosk: `http://localhost:3418/kiosk?village=Katete&pod=localhost:3419` (the software side confirms the exact address).

## Program, bridge, test

1. USB-C cable from the laptop into the XIAO. Claude loads the program (`hardware/pod-nrf-firmware`, board Seeeduino:nrf52:xiaonRF52840Sense). The program prints one line a second: `{"finger":true,"hr":72,"spo2":98,"presses":0,"sensor":true}`.
2. In a terminal, before the demo and kept running:

```bash
python3 hardware/pod-serial-bridge.py
```

   It finds the pod on USB, posts a reading to the app every second, and prints one line a second (`finger=yes hr=72 spo2=98 presses=0 -> 200`). If it says pyserial is missing: `pip3 install pyserial`.
3. Chrome: `http://localhost:3418/kiosk?village=Katete`. Finger flat on the dark window for 10 seconds: the kiosk shows oxygen and pulse.

## Case

Faceplate and sensor shelf unchanged (sensor window-up in the shelf, cable through the notch). The base becomes a breadboard pocket: tell Claude the breadboard's size. No battery rails, no camera hole needed: the camera hole can stay as a design cue or be closed.

## If it goes wrong

| What you see | Do |
|---|---|
| bridge says "waiting for the pod on USB" | cable is power-only or not in the XIAO; try another USB-C cable |
| `"sensor":false` in the pod's line | red/black/white/yellow in the wrong rows, or an end not fully in. Swap white and yellow first |
| hr/spo2 stay 0 | finger flatter and stiller, lighter touch; keep fingers off for the first second after plugging in |
| bridge prints `-> no app` | the laptop app is not running on :3418 |

---

# Fallback: the soldered route (only if you decide pre-soldered parts are fine)

Four joints at home, before the venue. The picture booklet `hardware/booklet/Triage Pod — Four Joints.pdf` shows every step. Text version below.

## Measure first (2 min, send the numbers to Claude)

The case files are drawn from guesses. Send these and Claude re-exports the STLs before you queue a print:

| Measure | Guess in the file now |
|---|---|
| Red sensor board, long side | 26 mm |
| Red sensor board, short side | 18 mm |
| Tallest thing on the **underside** of the red board (the back, where the four wires come out of the holes) | 5 mm |
| Dark window: how far left/right of the board's centre | 0 mm |
| Camera board (Vision AI V2) width and height | 40 × 20 mm |
| Lens diameter | 10 mm |

A photo of the red board next to a ruler is enough.

## How the parts are wired today (from the Zoron booklets, nothing guessed)

Source: `~/Desktop/Zoron-Camera-Pod/LEGO-Instructions/spec/WIRING.md` and Book 2 (Watch) pages 48–53 and 67–81.

- **Pod:** the XIAO ESP32-S3 sits in the Vision AI V2's two sockets. Its underside BAT+ / BAT− pads carry the red and black battery wires (switch, charger). The brain board's D1 and GND blobs carry the resistor stick. **Every pin on the XIAO's top face is free**, including D4 and D5. None of this gets touched.
- **Watch:** the red MAX30101 has the Qwiic cable (black / red / blue / yellow) **soldered into its holes** (GND, 3.3V, SDA, SCL). The other end of that cable is a small white **plug** sitting in the DRV2605L's socket. The DRV2605L is the board with four wires soldered to the top of the XIAO nRF52840's header pins. **The sensor is only plugged in. Nothing on the sensor needs desoldering.**

## Part A — Take the red sensor out of the watch (2 min, no iron)

1. Slide the Round Display's ON/OFF switch to OFF.
2. Find the small white plug at the end of the sensor's four-colour cable, where it enters the DRV2605L board (the board with the buzz motor). Pinch the plug and pull it straight out of the socket. Wiggle, don't yank on the wires.
3. Lift the red sensor out with its cable. That is the whole removal: no cutting, no iron.
4. The rest of the watch stays as it is.

## Part B — Prepare the four wires (5 min)

5. Cut the white plug off the sensor's cable, 5 mm from the plug. You now have four loose wire ends, about 35 mm long, still soldered into the sensor:
   - black = GND
   - red = 3V3
   - blue = SDA (data)
   - yellow = SCL (clock)
6. Strip 2 mm from each end and tin it (iron and a little solder on the bare copper until it turns silver). This is watch Book 2, pages 68–75, done once more.

If 35 mm turns out too short to reach from the shelf to the XIAO, extend each wire with a piece of your silicone wire (joint, heat-shrink) before Part C. Measure in the case first.

## Part C — Solder the four wires to the XIAO ESP32-S3 (10 min)

The XIAO is the small board on top of the Vision AI V2, the one with the USB-C port. Pod switch OFF, battery plug pulled out of the charger. Hold the XIAO with the **USB-C port pointing up, away from you**. The pins run down both sides. Solder each wire **onto the top of the pin's existing joint**, the same technique you used on the watch's XIAO (Book 2, pages 48–53: red to 3V3, black to GND, white to D4, yellow to D5). Same four pin positions, same side of the board. The XIAO can stay seated in its sockets; if you lift it off, its red and black battery wires stay attached, so lift it straight up.

```
                USB-C
          ┌───────────────┐
   D0  ●  │               │  ●  5V
   D1  ●  │               │  ●  GND   ← black
   D2  ●  │  XIAO         │  ●  3V3   ← red
   D3  ●  │  ESP32-S3     │  ●  D10
   D4  ●  │               │  ●  D9      ← blue goes to D4 (left side, 5th pin)
   D5  ●  │               │  ●  D8      ← yellow goes to D5 (left side, 6th pin)
   D6  ●  │               │  ●  D7
          └───────────────┘
```

Joint 1 — **black (GND)** → right side, **2nd pin from the top** (GND).
Joint 2 — **red (3V3)** → right side, **3rd pin from the top** (3V3). Not 5V. 5V kills the sensor.
Joint 3 — **blue (SDA)** → left side, **5th pin from the top** (D4).
Joint 4 — **yellow (SCL)** → left side, **6th pin from the top** (D5).

For each joint: hold the tinned wire against the pin, touch the iron to both for 2 seconds, feed a little solder, lift the iron, hold the wire still for 3 seconds.

Checks before power:
- No solder blob joins two neighbouring pins. Look closely at GND next to 3V3 and at D4 next to D5. If two are joined, re-heat and wipe the iron tip through the gap.
- D6 and D7 (bottom left, bottom right) must stay free: the camera uses them.
- A multimeter on "beep": touch GND and 3V3. No beep = good. A beep = short, fix before plugging in.

Tape the four wires to the Vision AI board so they can't tug on the joints.

## Part D — First power (2 min)

6. Plug the XIAO into the laptop with the data cable. A small LED on the XIAO lights.
7. Nothing warm, nothing smelling? Good. If the XIAO gets hot or the LED stays off, unplug: a short, back to Part C.

## Part E — Flash the pod (Claude, 5 min)

8. Keep the XIAO plugged in. Tell Claude the hotspot name and password.
9. Claude writes `hardware/pod-firmware/secrets.h`, compiles, and uploads. If the upload does not start, hold the **BOOT** button on the XIAO, tap **RESET**, release BOOT, then Claude uploads again.
10. Claude checks `http://triagepod.local/vitals` and tells you what it saw. Then unplug the USB.

## Part F — Camera and antenna (2 min)

11. The camera ribbon is fully seated in the Vision AI V2's connector (black latch down, gold contacts facing the board).
12. The little Wi-Fi antenna is clipped onto the XIAO's tiny round connector (press straight down until it clicks). Without it the pod cannot reach the hotspot.

## Part G — Battery (while you do the rest)

13. Battery switch OFF. Charge the 1,200 mAh pack through the charger board's USB-C until its light says full.
14. Battery wiring stays exactly as the camera pod already has it.

## Part H — Print the case (venue station, free PLA, 3.5 h per print)

Three prints, all with a flat bottom, no supports. Tell the station: 0.28 mm layers, 15% infill. Queue the faceplate first, then the shelf (short), then the base.

| File | What it is | Plastic | Time (rough; the station's slicer gives the real number) |
|---|---|---|---|
| `pod-faceplate.stl` | Front panel 110 × 170 mm: camera hole near the top, a 50 mm slot for the shelf tongue, a wire hole under the slot, rails for the camera board on the back | 39 cm³ | ~1.5–2 h |
| `pod-sensor_shelf.stl` | Small wedge, 50 × 46 × 15 mm, tilted 15° toward the patient: the red board drops in window-up, a 20 mm cut-out at the front is where the fingertip lies, a notch at the back lets the wires out, and a flat tongue slides through the faceplate slot | 8 cm³ | ~25 min |
| `pod-base.stl` | Open-back tray 110 × 70 × 40 mm: battery rails, switch and charger holes on the left side, a groove at the front the faceplate stands in | 43 cm³ | ~2–2.5 h |

If the queue is long: shelf first, then faceplate, and a cardboard box as the base.

## Part I — Into the case (10 min)

15. **Shelf:** push the shelf's flat tongue through the slot in the faceplate from the front, until the shelf's back face sits flat against the panel. Behind the panel, tape the tongue down or run a zip tie through its two holes and around the panel's edge. The tilted top with the pocket faces the patient.
16. **Sensor:** drop the red board into the shelf pocket, dark window up, wires leaving through the notch at the back. The window should sit level with the shelf's top. Thread the four wires through the small hole in the faceplate just under the slot. A dab of tape on the board's edges keeps it in. The patient rests a fingertip flat on the window, pointing at the panel.
17. **Camera:** lens through the round hole near the top (patient's eye level). The Vision AI board sits in the rails behind the hole; tape it there. The XIAO is on top of it.
18. **Battery and charger** in the base tray between the rails; the switch and the charger's USB-C face the left side holes.
19. **Antenna** taped inside the base away from the battery.
20. Stand the faceplate in the base's front groove. Tape, nothing glued: you will want these parts back.

If the pocket is a bit tight, a few strokes with a nail file on the pocket walls fixes it. If it is loose, tape. If the tongue does not pass the slot, file the slot, not the tongue.

## Part J — Test (5 min)

21. Turn the hotspot on. Laptop joins it. Pod switch ON.
22. In Chrome on the laptop: `http://triagepod.local/vitals` → you should see `"camera": true` and `"sensor": true`.
23. Rest your index finger on the sensor window, still, for 10 seconds. Reload: pulse and oxygen numbers appear.
24. Open `http://localhost:3417/kiosk?village=Katete&pod=triagepod.local`, press **F**. You should see the pod's camera picture and the oxygen/pulse line.
25. Second window: `http://localhost:3417/staff`. Do one full test visit.

## If it goes wrong

| What you see | Do |
|---|---|
| `"sensor": false` | Joint 3 or 4 is loose, or SDA/SCL are swapped: swap blue and yellow. |
| Pulse reads 0 or jumps around | Finger flatter and stiller, lighter touch; keep fingers off for the first second after power-on. |
| `triagepod.local` not found | Both devices on the hotspot? Power-cycle the pod. Try the IP the hotspot shows for "triagepod". |
| `"camera": false` | Ribbon not seated (Part F). |
| XIAO hot | Unplug. Short between pins (Part C checks). |
| Upload will not start | Hold BOOT, tap RESET, release BOOT, upload again. |
