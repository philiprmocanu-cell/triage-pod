# Triage Pod — step-by-step build (one board, four solder joints)

What you end up with: the camera pod you already have (XIAO ESP32-S3 on the Vision AI V2, 1,200 mAh battery) with the red oxygen/pulse sensor from the watch wired to it. It runs on battery, joins your phone hotspot, and the laptop does the talking.

Do all soldering at home. The venue does not allow it.

Tools: soldering iron, your silicone wire (or the Qwiic cable), wire stripper or small scissors, tape, a multimeter if you have one (optional), USB-C data cable, phone hotspot.

---

## Part A — Take the red sensor out of the watch (5 min)

1. Switch the watch OFF and unplug any USB cable.
2. Open the watch case. Find the red board (the small one with a dark square window; label says MAX30101).
3. Look at how it is connected:
   - **If it is on a 4-wire plug (Qwiic cable, white connectors):** unplug the cable from the watch's other board, leave the cable in the sensor. Done. Go to Part B, "Qwiic route".
   - **If wires are soldered to it:** cut those four wires about 2 cm from the **other** board (not the sensor), so the sensor keeps long leads. Go to Part B, "soldered route".
4. Lift the sensor out. Everything else in the watch stays where it is.
5. Put the watch aside. It is not used tonight.

## Part B — Prepare four wires (5 min)

**Qwiic route (easiest):** take the Qwiic cable in the sensor. Cut off the free white plug. Strip 3 mm from each of the four wires. Colours mean:
- black = GND
- red = 3V3
- blue = SDA (data)
- yellow = SCL (clock)

**Soldered route:** the four leads coming out of the sensor are printed on the sensor's edge: `3V3`, `GND`, `SDA`, `SCL`. Follow each wire from its pad and put a bit of tape with the name on it. Strip 3 mm from each end.

Tin each bare end: touch the iron and a little solder to the wire until it turns silver.

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
9. Claude writes `hardware/pod-firmware/secrets.h` and runs the upload. If the upload does not start, hold the **BOOT** button on the XIAO, tap **RESET**, release BOOT, then upload again.
10. Unplug the USB.

## Part F — Camera and antenna (2 min)

11. The camera ribbon is fully seated in the Vision AI V2's connector (black latch down, gold contacts facing the board).
12. The little Wi-Fi antenna is clipped onto the XIAO's tiny round connector (press straight down until it clicks). Without it the pod cannot reach the hotspot.

## Part G — Battery (while you do the rest)

13. Battery switch OFF. Charge the 1,200 mAh pack through the charger board's USB-C until its light says full.
14. Battery wiring stays exactly as the camera pod already has it.

## Part H — Into the case (10 min)

15. Faceplate: camera lens through the round hole near the top (patient's eye level). Tape the Vision AI board to the rails behind the hole.
16. Sensor: tape the red board **window up** on the shelf, or behind the finger slot, so a fingertip can rest flat on the dark window. Write "finger here" on the faceplate with a marker if you want.
17. Battery and charger board in the base tray; the switch and the charger's USB-C face the side hole.
18. Antenna taped inside the case away from the battery.
19. Close it with tape. Nothing glued: you will want these parts back.

## Part I — Test (5 min)

20. Turn the hotspot on. Laptop joins it. Pod switch ON.
21. In Chrome on the laptop: `http://triagepod.local/vitals` → you should see `"camera": true` and `"sensor": true`.
22. Rest your index finger on the sensor window, still, for 10 seconds. Reload: pulse and oxygen numbers appear.
23. Open `http://localhost:3417/kiosk?village=Katete&pod=triagepod.local`, press **F**. You should see the pod's camera picture and the oxygen/pulse line.
24. Second window: `http://localhost:3417/staff`. Do one full test visit.

## If it goes wrong

| What you see | Do |
|---|---|
| `"sensor": false` | Joint 3 or 4 is loose, or SDA/SCL are swapped: swap blue and yellow. |
| Pulse reads 0 or jumps around | Finger flatter and stiller, lighter touch; keep fingers off for the first second after power-on. |
| `triagepod.local` not found | Both devices on the hotspot? Power-cycle the pod. Try the IP the hotspot shows for "triagepod". |
| `"camera": false` | Ribbon not seated (Part F). |
| XIAO hot | Unplug. Short between pins (Part C checks). |
