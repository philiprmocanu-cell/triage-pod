# Build the pod today, with what is on the desk

Read first, from the Cal Hacks 13.0 Hacker Guide (your Google Doc):
- **No soldering at the venue.** No irons, not permitted inside. So the plan below needs **zero soldering**.
- **3D Printing Station:** five printers, free PLA, **3.5 hours per print**, queue by form.
- **Rental booth** (6 PM Fri → 2 PM Sun): ESP32s, Raspberry Pis, Arduino kits, sensor modules.
- **MLH Hardware Lab:** Raspberry Pi kits, Arduinos, **Logitech webcams**, Google Home Mini, Echo Show/Dot.
- Venue Wi-Fi "Cal Hacks 13.0" / "hackers!". Venue Wi-Fi usually blocks devices from seeing each other: use your phone hotspot for pod ↔ laptop.
- Submit on Devpost by **Sunday 9:00 AM**; judging 10:30–12:30 at your table; live demo required.

## Update: you can solder at home

That opens the simpler build, and it is the one to do:

**One-board pod.** Put a finger sensor on the camera pod's XIAO ESP32-S3 with four wires (3V3, GND, D4 = SDA, D5 = SCL). The firmware for exactly this is already written and compiles (`hardware/pod-firmware`): camera, finger sensor, BOOT button as Talk, Wi-Fi. No watch firmware to write tonight. The watch stays whole and can join later over Bluetooth as a second screen.

**Order now (one item):** a **MAX30102 heart-rate/oxygen module** (the "GY-MAX30102" boards, ~$8–10, Amazon same-day in SF). Same chip family as the red sensor in your watch, same library, same four wires; it means you do not pull the watch apart. If you would rather not wait for it, unsolder the red sensor from the watch instead and use that.

Four solder joints at home, before you come back to the venue (no soldering allowed there). Everything else below still applies.

## The plan in one line

Nothing gets unwired. The **camera pod** stays as it is (XIAO ESP32-S3 on the Vision AI V2 + 1200 mAh battery) and talks to the laptop over Wi-Fi. The **watch** stays as it is (XIAO nRF52840 Sense + round touch screen + red MAX30101 sensor + small battery) and talks to the laptop over Bluetooth. The laptop is the voice and the brain. The two boxes never need a wire between them.

So the one solder job you were expecting, "camera to the XIAO Sense", does not exist: the camera already sits on the ESP32-S3, which has Wi-Fi; the Sense has only Bluetooth and could not carry pictures anyway.

## 1. Get today (nothing to mail-order; it would not arrive)

| Get | Where | Why | Must / nice |
|---|---|---|---|
| USB-C **data** cable (the one you used on Oct 1 for the camera) | your bag | Flash both boards once | **Must** |
| Phone with hotspot | your pocket | Pod and laptop on one network | **Must** |
| Fingertip pulse oximeter ($25–40) | Walgreens / CVS (Lombard St is a 15-min walk) | Side-by-side truth check for the red sensor; the fallback number you type into /staff | Strongly recommended |
| **Logitech webcam** (rent) | MLH Hardware Lab | Backup eyes if the pod's Wi-Fi camera drops on stage; plugs into the laptop, the kiosk uses it without the `?pod=` part | Recommended |
| Spare ESP32 (rent) | Cal Hacks rental booth | Only if your XIAO ESP32-S3 fails to flash | Optional |
| Double-sided foam tape, velcro dots, a small cardboard box | any drugstore / the venue | Mount the boards inside the case tonight even if the print queue is slow | **Must** (tape) |
| Small USB power bank | have one? | Keeps the watch charged through judging (its battery is ~1 h) | Recommended |
| Ring light with clip | Walgreens / Target, optional | Even light on the face: the scan is much more reliable | Nice |

Already on the desk and needed: XIAO ESP32-S3 with its **Wi-Fi antenna clipped on**, Grove Vision AI V2 + camera + ribbon, 1200 mAh battery with charger board + switch, the watch (XIAO nRF52840 Sense, round touch display, red MAX30101, small battery).

## 2. Assembly, no soldering (20 minutes)

1. **Camera pod:** leave it exactly as built. Check the antenna is clipped to the ESP32-S3's u.FL connector. Charge the 1200 mAh battery (switch OFF while charging).
2. **Watch:** leave it exactly as built. Charge it over USB-C.
3. **Flash the camera pod** (Claude does it): plug the ESP32-S3 in with the data cable, tell Claude the hotspot name and password, it writes `hardware/pod-firmware/secrets.h` and uploads. Unplug, switch ON. In Chrome: `http://triagepod.local/vitals` → `"camera": true`.
4. **Flash the watch** (Claude writes it today): it advertises over Bluetooth as "Triage Pod" with oxygen + pulse from the red sensor, and the round touch screen becomes the **Talk** button and shows the current question. Chrome on the laptop connects with one click ("Connect watch" on the kiosk).
5. **Mount:** camera pod at the patient's eye level, lens looking straight out. Watch on a small tilted shelf below it, screen up, with an open slot underneath so the patient slides a fingertip under the watch onto the sensor window. Tape, don't glue; you will want them back.

Open on the laptop: `http://localhost:3417/kiosk?village=Katete&pod=triagepod.local` (press F for full screen) and `http://localhost:3417/staff` in a second window.

## 3. What to 3D print (venue station, 3.5 h per print, free PLA)

Everything is in `hardware/case/pod-case.scad` (open in OpenSCAD or the station's slicer takes an STL exported from it). Measure your parts and change the numbers at the top of the file before exporting. Three prints, each under 3.5 h at 0.28 mm layers, 15% infill:

| Print | What it is | Time (approx.) |
|---|---|---|
| `faceplate` | Front panel: camera window at eye level, a slot for the watch shelf, the "Ponga su dedo aquí / Finger here" lettering | ~1.5 h |
| `watch_shelf` | Tilted cradle the watch sits in, screen up, with the finger slot underneath that lines up with the red sensor | ~1 h |
| `base` | Open-back tray that holds the battery, charger and the camera board; the faceplate clips to its front | ~2.5 h |

If the queue is long, print only `faceplate` + `watch_shelf` and use a cardboard box as the base: the front is all the judges see.

Queue tip: the form opens after the opening ceremony; put the faceplate in first, it is the one that matters.

## 4. What is still software (Claude's list, no parts)

- Flash `pod-firmware` to the ESP32-S3 (needs the data cable and the hotspot name/password).
- Write and flash the watch firmware (Bluetooth oxygen/pulse + touch-to-talk + question on the round screen).
- Add "Connect watch" (Web Bluetooth) to the kiosk so the finger sensor and the Talk button come from the watch instead of Wi-Fi.

## 5. If it goes wrong on stage

| Problem | Do this |
|---|---|
| Pod camera not found | Open `/kiosk` without `?pod=` → the laptop or rented webcam is the camera |
| Watch not connecting | Clip the drugstore oximeter on, type the number into `/staff` |
| Hotspot flaky | Both devices on the venue Wi-Fi as a second try; otherwise laptop camera only |
| Print not done | Cardboard box with a cut-out at eye level; tape the watch to the front at chest height |
