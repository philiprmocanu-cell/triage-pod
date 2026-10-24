# Triage Pod — build it at the venue, no soldering, nothing pre-built

Rule check (Cal Hacks 13.0 Hacker Guide, "Project Submission & Judging"): **"All projects must be started during the event."** There is no written rule against bringing parts, but a pod that was soldered together weeks ago for another project reads as "started before the event". The guide also says no soldering inside the venue. So the clean way is a pod you plug together at your table from stock parts, with no iron at all. That is this plan.

Nothing from the Zoron pod's soldered work is used: not its brain board, charger, switch, battery or resistor stick. They stay in the old case. The watch is not touched either.

## What you take from home

| Part | Where it is now | What to do to it |
|---|---|---|
| **Spare Vision AI V2** (the clean one, never soldered) | the spare brain board | nothing |
| **Fisheye camera + ribbon** | latched into the old pod's brain | unlatch the ribbon from the old brain, latch it into the spare brain (Book 1, pages 2–6) |
| **XIAO ESP32-S3** (radio board, factory-soldered pins) | plugged into the old pod's brain, two battery wires on its underside | lift it off the old brain; cut the red and black wires off right at the underside pads with scissors (no iron). It is a stock board again |
| **Wi-Fi antenna** | clipped on the XIAO | stays clipped on |
| **Red MAX30101 sensor** | in the watch, plugged into the DRV board | pull its small plug out of the DRV board and lift it out. Its old soldered cable stays on it but is not used: the sensor has **two empty Qwiic sockets** |
| **USB-C data cable** | your bag | flashing, and power at the table |

## What you get at the venue (rental booth, from 6 PM Friday)

- **Arduino Uno kit** from the rental booth: it has a **breadboard** and **jumper wires** (male–male). That is all the wiring you need.
- **Qwiic-to-breadboard cable** (4-pin JST-SH plug on one end, four pins on the other; SparkFun "Qwiic Cable – Breadboard Jumper" or Adafruit 4209). Check the MLH Hardware Lab list first; if nobody has one, Amazon same-day. **Fallback:** a **MAX30102 module with header pins** from the rental booth's sensor assortment (same chip family, same program, plugs straight into the breadboard).
- **Power:** the laptop's USB-C port, or any USB power bank. No battery, no charger, no switch.

## The wiring (every joint is a plug, nothing is soldered)

Push the XIAO into the breadboard so it straddles the middle gap, USB-C pointing out to the edge. Its two pin rows are now in two breadboard rows. Then five jumper wires from the XIAO's rows into the spare brain board's socket holes (the two black 7-hole strips on the brain's back face; the words are printed next to the holes):

| From XIAO pin | To brain hole | Jumper colour (any colour works; these help) |
|---|---|---|
| 5V | **5V** | red |
| 3V3 | **3V3** | orange |
| GND | **GND** | black |
| D6 | **RXD** | white |
| D7 | **TXD** | yellow |

(These are exactly the five connections the socket made when the XIAO sat on the brain. D3 to RST is not needed.)

Then the sensor. Plug the Qwiic cable into either socket on the red board and push its four pins into the breadboard rows next to these XIAO pins:

| Qwiic wire | XIAO pin |
|---|---|
| black | GND |
| red | 3V3 (**never 5V**) |
| blue | D4 (SDA) |
| yellow | D5 (SCL) |

Fallback module (MAX30102 with pins): four jumpers, VIN→3V3, GND→GND, SDA→D4, SCL→D5.

Pin map of the XIAO, USB-C pointing up: left column D0 D1 D2 D3 D4 D5 D6 top to bottom; right column 5V GND 3V3 D10 D9 D8 D7.

```
                USB-C
          ┌───────────────┐
   D0  ●  │               │  ●  5V   → brain 5V
   D1  ●  │               │  ●  GND  → brain GND, sensor black
   D2  ●  │  XIAO         │  ●  3V3  → brain 3V3, sensor red
   D3  ●  │  ESP32-S3     │  ●  D10
   D4  ●  │               │  ●  D9      D4 ← sensor blue (SDA)
   D5  ●  │               │  ●  D8      D5 ← sensor yellow (SCL)
   D6  ●  │               │  ●  D7      D6 → brain RXD,  D7 → brain TXD
          └───────────────┘
```

Checks before power (no meter needed, just eyes): no jumper in the brain's 5V hole except the one from XIAO 5V; the sensor's red pin is on the 3V3 row, not the 5V row; the ribbon latch on the brain is closed with the silver contacts facing the gold fingers.

## Power, program, test

1. USB-C cable from the laptop into the **XIAO** (not the brain). Tell Claude the hotspot name and password; Claude writes `hardware/pod-firmware/secrets.h` and uploads. The program is the same one as before: nothing changes because the pins are the same.
2. If the upload will not start: hold BOOT on the XIAO, tap RESET, release BOOT, upload again.
3. Chrome: `http://triagepod.local/vitals` → `"camera": true`, `"sensor": true`.
4. Finger flat on the dark window for 10 seconds, reload: pulse and oxygen numbers.
5. Kiosk: `http://localhost:3417/kiosk?village=Katete&pod=triagepod.local`, press F.

For the demo the pod runs from a power bank on the USB-C cable; the laptop stays on the hotspot.

## Case

Same three prints. The base tray no longer needs battery rails: it holds the breadboard instead. Tell Claude the breadboard's size (a half-size board is about 82 × 55 mm, a mini one 46 × 35 mm) and the base gets a pocket for it. Faceplate and sensor shelf are unchanged; the sensor sits in the shelf window-up with the Qwiic cable leaving through the notch.

## If it goes wrong

| What you see | Do |
|---|---|
| `"sensor": false` | blue/yellow swapped, or a pin not fully in the breadboard. Swap blue and yellow. |
| `"camera": false` | RXD/TXD swapped (swap the white and yellow jumpers), or the ribbon latch is open. |
| Nothing lights on the brain | 5V/3V3/GND jumpers in the wrong holes; recount from the printed words. |
| `triagepod.local` not found | both devices on the hotspot? Try the IP the hotspot shows for "triagepod". |
| Upload will not start | hold BOOT, tap RESET, release BOOT, upload again. |

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
