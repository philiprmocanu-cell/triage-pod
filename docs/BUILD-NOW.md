# Build the pod today, with what is on the desk

Read first, from the Cal Hacks 13.0 Hacker Guide (your Google Doc):
- **No soldering at the venue.** No irons, not permitted inside. All four solder joints happen **at home** (see `docs/LEGO-POD.md`).
- **3D Printing Station:** five printers, free PLA, **3.5 hours per print**, queue by form.
- **Rental booth** (6 PM Fri → 2 PM Sun): ESP32s, Raspberry Pis, Arduino kits, sensor modules.
- **MLH Hardware Lab:** Raspberry Pi kits, Arduinos, **Logitech webcams**, Google Home Mini, Echo Show/Dot.
- Venue Wi-Fi "Cal Hacks 13.0" / "hackers!". Venue Wi-Fi usually blocks devices from seeing each other: use your phone hotspot for pod ↔ laptop.
- Submit on Devpost by **Sunday 9:00 AM**; judging 10:30–12:30 at your table; live demo required.

## The plan in one line

**Built at your table, no soldering, nothing pre-built.** The guide says every project must be started during the event, so the pod is plugged together at the venue from stock parts: the spare (never-soldered) Vision AI V2 brain board, the XIAO ESP32-S3 with its factory pins on a breadboard, five jumper wires between them, the red MAX30101 sensor on a Qwiic-to-breadboard cable, power from a USB-C cable. The old soldered Zoron pod and the watch stay untouched. Full steps in `docs/LEGO-POD.md`.

The firmware for exactly this is written and compiles (`hardware/pod-firmware`): camera, finger sensor, BOOT button as Talk, Wi-Fi. It is **not flashed yet**: that happens the moment the XIAO is plugged in and Claude has the hotspot name and password.

## 1. Get today (nothing to mail-order; it would not arrive)

| Get | Where | Why | Must / nice |
|---|---|---|---|
| USB-C **data** cable (the one you used on Oct 1 for the camera) | your bag | Flash the pod once | **Must** |
| Phone with hotspot | your pocket | Pod and laptop on one network | **Must** |
| **Arduino Uno kit** (breadboard + jumper wires) | Cal Hacks rental booth, from 6 PM Fri | All the pod wiring, no soldering | **Must** |
| **Qwiic-to-breadboard cable** (JST-SH plug → 4 pins) | MLH Hardware Lab list, else Amazon same-day (SparkFun PRT-14425 / Adafruit 4209) | Plugs the red sensor into the breadboard | **Must** (or the fallback below) |
| MAX30102 module with header pins | rental booth sensor assortment / Amazon same-day | Fallback finger sensor if no Qwiic cable turns up; same program | Fallback |
| USB power bank | have one? | Runs the pod at the table without the laptop cable | Recommended |
| Double-sided foam tape, a zip tie or two, a small cardboard box | any drugstore / the venue | Mount the boards even if the print queue is slow | **Must** (tape) |
| Fingertip pulse oximeter ($25–40) | Walgreens / CVS (Lombard St is a 15-min walk) | Side-by-side truth check for the red sensor; the fallback number you type into /staff | Strongly recommended |
| **Logitech webcam** (rent) | MLH Hardware Lab | Backup eyes if the pod's Wi-Fi camera drops on stage; plugs into the laptop, the kiosk uses it without the `?pod=` part | Recommended |
| Spare ESP32 (rent) | Cal Hacks rental booth | Only if your XIAO ESP32-S3 fails to flash | Optional |
| Ring light with clip | Walgreens / Target, optional | Even light on the face: the scan is much more reliable | Nice |

Already on the desk and needed: the **spare** Grove Vision AI V2, the XIAO ESP32-S3 with its **Wi-Fi antenna clipped on** (battery wires cut off at its pads), camera + ribbon, the red MAX30101 board out of the watch (one plug pulled). Not used: the old pod's battery, charger, switch, resistor stick, the watch.

## 2. Order of work

1. **At home, before leaving (scissors only, no iron):** lift the XIAO off the old pod's brain and cut its two battery wires at the pads; move the camera ribbon to the spare brain; pull the sensor's plug out of the watch's DRV board. Measure the red board and the camera board while you have the ruler out (numbers Claude needs are listed in LEGO-POD, "Measure first").
1b. **At the table:** breadboard + five jumpers XIAO→brain, Qwiic cable sensor→breadboard (`docs/LEGO-POD.md`, "The wiring").
2. **Flash the pod** (Claude does it, 5 min): plug the XIAO in with the data cable, send Claude the hotspot name and password. In Chrome: `http://triagepod.local/vitals` → `"camera": true`, `"sensor": true`.
3. **Print** the three case parts at the station (section 3). Queue the faceplate first.
4. **Mount:** camera lens through the faceplate hole at eye level; the sensor shelf's tongue through the faceplate slot, red board in the shelf window-up; battery and charger in the base. Tape, don't glue.
5. **Test** with the laptop: `http://localhost:3417/kiosk?village=Katete&pod=triagepod.local` (press F for full screen) and `http://localhost:3417/staff` in a second window.

## 3. What to 3D print (venue station, 3.5 h per print, free PLA)

Everything is in `hardware/case/pod-case.scad`; the station's slicer takes the STL files next to it. Send Claude your measurements first so the STLs match your parts. Three prints, each with a flat bottom, no supports, 0.28 mm layers, 15% infill:

| Print | What it is | Plastic | Time (rough; the station's slicer gives the real number) |
|---|---|---|---|
| `pod-faceplate.stl` | Front panel 110 × 170 mm: camera hole at eye level, a slot for the shelf tongue, a wire hole under it, rails for the camera board on the back | 39 cm³ | ~1.5–2 h |
| `pod-sensor_shelf.stl` | Small tilted wedge the red sensor drops into, window up, with a fingertip cut-out at the front and a tongue that slides through the faceplate slot | 8 cm³ | ~25 min |
| `pod-base.stl` | Open-back tray 110 × 70 × 40 mm: battery rails, switch and charger holes on the left, front groove the faceplate stands in | 43 cm³ | ~2–2.5 h |

If the queue is long, print only the shelf and the faceplate and use a cardboard box as the base: the front is all the judges see. The shelf is the one part that is hard to fake with cardboard, so if you can only print one thing, print the shelf.

## 4. What is still software (Claude's list, no parts)

- Flash `pod-firmware` to the ESP32-S3 (needs the XIAO plugged in and the hotspot name/password).
- Nothing else on the pod side. Everything the judges hear and see is the laptop app (`src/`, another session's job).

## 5. If it goes wrong on stage

| Problem | Do this |
|---|---|
| Pod camera not found | Open `/kiosk` without `?pod=` → the laptop or rented webcam is the camera |
| Sensor reads nothing | Clip the drugstore oximeter on, type the number into `/staff` |
| Hotspot flaky | Both devices on the venue Wi-Fi as a second try; otherwise laptop camera only |
| Print not done | Cardboard box with a cut-out at eye level; tape the red sensor window-up to the front at chest height |
