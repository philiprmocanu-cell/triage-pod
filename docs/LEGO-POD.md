# Triage Pod — step-by-step build (one board, four solder joints)

What you end up with: the camera pod you already have (XIAO ESP32-S3 on the Grove Vision AI V2, 1,200 mAh battery) with the red oxygen/pulse sensor from the old watch wired to it, in a three-part printed case. It runs on battery, joins your phone hotspot, and the laptop does the talking.

Do all soldering at home. The venue does not allow it.

Tools: soldering iron, your silicone wire (or the Qwiic cable), wire stripper or small scissors, tape, a ruler, a multimeter if you have one (optional), USB-C data cable, phone hotspot.

Where things live:
- Firmware: `hardware/pod-firmware/pod-firmware.ino` (compiles; not flashed yet). Hotspot name/password go in `hardware/pod-firmware/secrets.h`, which is not committed.
- Case: `hardware/case/pod-case.scad` plus the three exported files `pod-faceplate.stl`, `pod-sensor_shelf.stl`, `pod-base.stl`.
- This file is the single source of truth for the physical pod.

---

## Measure first (2 min, send the numbers to Claude)

The case files are drawn from guesses. Send these and Claude re-exports the STLs before you queue a print:

| Measure | Guess in the file now |
|---|---|
| Red sensor board, long side | 26 mm |
| Red sensor board, short side | 18 mm |
| Tallest thing on the **underside** of the red board (a Qwiic plug is about 5 mm; 0 if the back is flat) | 5 mm |
| Dark window: how far left/right of the board's centre | 0 mm |
| Camera board (Vision AI V2) width and height | 40 × 20 mm |
| Lens diameter | 10 mm |

A photo of the red board next to a ruler is enough.

## Part A — Take the red sensor out of the watch (5 min)

1. Switch the watch OFF and unplug any USB cable.
2. Open the watch case. Find the red board (the small one with a dark square window; label says MAX30101).
3. Look at how it is connected:
   - **If it is on a 4-wire plug (Qwiic cable, white connectors):** unplug the cable from the watch's other board, leave the cable in the sensor. Done. Go to Part B, "Qwiic route".
   - **If wires are soldered to it:** cut those four wires about 2 cm from the **other** board (not the sensor), so the sensor keeps long leads. Go to Part B, "soldered route".
4. Lift the sensor out. The rest of the watch is spare parts now.

## Part B — Prepare four wires (5 min)

**Qwiic route (easiest):** take the Qwiic cable in the sensor. Cut off the free white plug. Strip 3 mm from each of the four wires. Colours mean:
- black = GND
- red = 3V3
- blue = SDA (data)
- yellow = SCL (clock)

**Soldered route:** the four leads coming out of the sensor are printed on the sensor's edge: `3V3`, `GND`, `SDA`, `SCL`. Follow each wire from its pad and put a bit of tape with the name on it. Strip 3 mm from each end.

Tin each bare end: touch the iron and a little solder to the wire until it turns silver.

Leave the wires at least 15 cm long: they have to reach from the shelf on the front of the faceplate, through the wire hole, to the XIAO in the base.

## Part C — Solder the four wires to the XIAO ESP32-S3 (10 min)

The XIAO is the small board on top of the Vision AI V2, the one with the USB-C port. Hold it with the **USB-C port pointing up, away from you**. The pins run down both sides. Solder onto the **top of the header pins** (the metal tips sticking up), or onto the gold pads if your XIAO has no headers.

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
