# Build the pod today, with what is on the desk

Read first, from the Cal Hacks 13.0 Hacker Guide (your Google Doc):
- **No soldering at the venue.** No irons, not permitted inside. All four solder joints happen **at home** (see `docs/LEGO-POD.md`).
- **3D Printing Station:** five printers, free PLA, **3.5 hours per print**, queue by form.
- **Rental booth** (6 PM Fri → 2 PM Sun): ESP32s, Raspberry Pis, Arduino kits, sensor modules.
- **MLH Hardware Lab:** Raspberry Pi kits, Arduinos, **Logitech webcams**, Google Home Mini, Echo Show/Dot.
- Venue Wi-Fi "Cal Hacks 13.0" / "hackers!". The pod does not need it: it talks to the laptop over its USB cable.
- Submit on Devpost by **Sunday 9:00 AM**; judging 10:30–12:30 at your table; live demo required.

## The plan in one line

**The pod is the spare vision board with the watch's XIAO in its back, built at your table, no soldering.** The spare Grove Vision AI V2 with its ribbon camera gives the pictures over its own USB cable; the watch's XIAO nRF52840 Sense plugs into the vision board's back sockets and reads the red MAX30101 sensor (wired through the vision board's Grove port to the DRV board's four wires), sending the numbers over its own USB cable. Two bridge programs on the laptop feed the app. Full steps in `docs/LEGO-POD.md`. The old Zoron camera pod and its soldered work stay untouched.

The pod program (`hardware/pod-nrf-firmware`) is written and compiles. It is **not loaded yet**: that happens the moment the XIAO is plugged into the laptop.

## 1. Get today (nothing to mail-order; it would not arrive)

| Get | Where | Why | Must / nice |
|---|---|---|---|
| USB-C **data** cable (the one you used on Oct 1 for the camera) | your bag | Flash the pod once | **Must** |
| **Arduino Uno kit** (breadboard + jumper wires) | Cal Hacks rental booth, from 6 PM Fri | All the pod wiring, no soldering | **Must** |
| **Qwiic-to-breadboard cable** (JST-SH plug → 4 pins) | MLH Hardware Lab list, else Amazon same-day (SparkFun PRT-14425 / Adafruit 4209) | Plugs the red sensor into the breadboard | **Must** (or the fallback below) |
| MAX30102 module with header pins | rental booth sensor assortment / Amazon same-day | Fallback finger sensor if no Qwiic cable turns up; same program | Fallback |
| USB power bank | have one? | Runs the pod at the table without the laptop cable | Recommended |
| Double-sided foam tape, a zip tie or two, a small cardboard box | any drugstore / the venue | Mount the boards even if the print queue is slow | **Must** (tape) |
| Fingertip pulse oximeter ($25–40) | Walgreens / CVS (Lombard St is a 15-min walk) | Side-by-side truth check for the red sensor; the fallback number you type into /staff | Strongly recommended |
| **Logitech webcam** (rent) | MLH Hardware Lab | Backup eyes if the pod's Wi-Fi camera drops on stage; plugs into the laptop, the kiosk uses it without the `?pod=` part | Recommended |
| Ring light with clip | Walgreens / Target, optional | Even light on the face: the scan is much more reliable | Nice |

Already on the desk and needed: the watch's XIAO nRF52840 Sense (DRV wires cut off at its pins), the red MAX30101 board (one plug pulled), a USB-C data cable. Not used: the camera pod, the spare brain board, the small camera, the screen board, DRV, motor, battery.

## 2. Order of work

1. **At home, before leaving (scissors only, no iron):** watch switch OFF; cut the four DRV wires at the XIAO's pins; lift the XIAO out of the screen board; pull the sensor's plug out of the DRV board and lift the sensor out. Measure the red board and the camera board while you have the ruler out (numbers Claude needs are listed in LEGO-POD, "Measure first").
1b. **At the table:** XIAO into the breadboard, Qwiic cable sensor→breadboard rows GND/3V3/D4/D5 (`docs/LEGO-POD.md`).
2. **Load the pod** (Claude does it, 2 min): plug the XIAO into the laptop with the data cable and say so. No hotspot needed: the pod talks over the cable.
3. **Print** the three case parts at the station (section 3). Queue the faceplate first.
4. **Mount:** camera lens through the faceplate hole at eye level; the sensor shelf's tongue through the faceplate slot, red board in the shelf window-up; battery and charger in the base. Tape, don't glue.
5. **Run:** three terminals, all kept running: `spacetime start`, `python3 hardware/pod-camera-bridge.py`, `python3 hardware/pod-serial-bridge.py`. Then Chrome `http://localhost:3418/kiosk?village=Katete&pod=localhost:3419` (press F for full screen) and `http://localhost:3418/staff` in a second window.

## 3. What to 3D print (venue station, 3.5 h per print, free PLA)

Everything is in `hardware/case/pod-case.scad`; the station's slicer takes the STL files next to it. Send Claude your measurements first so the STLs match your parts. Three prints, each with a flat bottom, no supports, 0.28 mm layers, 15% infill:

| Print | What it is | Plastic | Time (rough; the station's slicer gives the real number) |
|---|---|---|---|
| `pod-faceplate.stl` | Front panel 110 × 170 mm: a slot for the shelf tongue, a wire hole under it (the round hole near the top is now just a design cue; no camera on the pod) | 39 cm³ | ~1.5–2 h |
| `pod-sensor_shelf.stl` | Small tilted wedge the red sensor drops into, window up, with a fingertip cut-out at the front and a tongue that slides through the faceplate slot | 8 cm³ | ~25 min |
| `pod-base.stl` | Open-back tray 110 × 70 × 40 mm: battery rails, switch and charger holes on the left, front groove the faceplate stands in | 43 cm³ | ~2–2.5 h |

If the queue is long, print only the shelf and the faceplate and use a cardboard box as the base: the front is all the judges see. The shelf is the one part that is hard to fake with cardboard, so if you can only print one thing, print the shelf.

## 4. What is still software (Claude's list, no parts)

- Load `pod-nrf-firmware` onto the XIAO nRF52840 (needs the XIAO plugged into the laptop).
- Before the demo, three terminals: `spacetime start`, `python3 hardware/pod-camera-bridge.py`, `python3 hardware/pod-serial-bridge.py`.
- Everything the judges hear and see is the laptop app (`src/`, another session's job).

## 5. If it goes wrong on stage

| Problem | Do this |
|---|---|
| Camera not found | Is the camera bridge terminal printing `pictures N camera yes`? If `camera NO`: reseat the ribbon (latch down, contacts toward the gold fingers), replug the vision board's USB. Last resort: open the kiosk without `&pod=` and the laptop webcam takes over |
| Sensor reads nothing | Is the bridge terminal still running and printing? If not, restart it. Else clip the drugstore oximeter on, type the number into `/staff` |
| USB cable flaky | Swap the cable (data cable, not charge-only); the bridge reconnects by itself |
| Print not done | Cardboard box with a cut-out at eye level; tape the red sensor window-up to the front at chest height |
