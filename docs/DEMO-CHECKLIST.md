# Demo-day checklist: wireless pod

Checked tonight (2026-10-24): Jev, Cartesia, Claude and World Bank all answer; the app runs with
all keys; regional voices are cached; the pod firmware compiles for the XIAO ESP32-S3.
Not done yet: flashing the firmware onto the XIAO and testing it on the real boards.

## 1. Pack

**Pod (you have these)**
- [ ] XIAO ESP32-S3
- [ ] Grove Vision AI V2 + its camera + ribbon cable
- [ ] Red MAX30101 finger sensor + its 4-wire Qwiic cable
- [ ] A box, tape, a marker for the "Ponga su dedo aquí" sign

**Power: your own battery**
- [ ] The 1,200 mAh pod battery with its charger board + on/off switch (the same wiring your camera
      pod already used) — roughly 3 hours with Wi-Fi + camera on. **Charge it fully tonight** (USB-C
      into the charger board, switch OFF while charging).
- [ ] The small watch battery (wired into the round screen) is only ~1 hour and would need
      re-wiring: leave it in the watch.
- [ ] Power bank only as a spare (optional)

**Buy tonight if you don't have them**
- [ ] A USB-C **data** cable for flashing (charge-only cables can't flash)
- [ ] Drugstore fingertip pulse oximeter (~$25) — backup reading and side-by-side proof on stage
- [ ] Optional: ring light (~$25), speakerphone (~$60–100) for a loud room

**Laptop side**
- [ ] Laptop + charger
- [ ] Phone with hotspot turned on (the pod and laptop both join it)

**Backup if the sensor cable doesn't reach the XIAO's pins**
- [ ] Female-to-female jumper wires or a soldering iron (4 wires: 3V3, GND, D4, D5)

## 2. At home first (~20 minutes, with Claude)

1. Plug the XIAO into the laptop with the **data** cable.
2. Tell Claude your hotspot name + password; Claude puts them in
   `hardware/pod-firmware/secrets.h` (never uploaded) and flashes the board.
3. Wire camera + sensor, power from the laptop's USB, and check
   `http://triagepod.local/vitals` shows `"camera": true` and `"sensor": true`.
4. Put a finger on the sensor: `/vitals` should show a pulse and oxygen after ~5–10 s.
5. Unplug the USB, flip the pod's switch ON (battery) and check `/vitals` again.

## 3. At the venue (10 minutes)

1. Phone hotspot on; laptop joins it; power the pod.
2. Start the app if it isn't running:
   `cd ~/code/triage-pod && npm run dev -- --port 3417`
3. Chrome window 1 (patient): `http://localhost:3417/kiosk?pod=triagepod.local` → press **F**.
4. Chrome window 2 (you): `http://localhost:3417/staff`.
5. Allow the microphone. Turn the laptop volume up. Do one full test visit.
6. Clear the test visits: delete `data/registry.json` (it holds tonight's test patients).

## 4. If something fails on stage

| Problem | Do this |
|---|---|
| Pod camera not showing | Open `/kiosk` without `?pod=…` — uses the laptop/iPhone camera instead |
| Finger sensor not reading | Clip on the drugstore oximeter; type the number into `/staff` |
| Pod not found on Wi-Fi | Both on the phone hotspot? Power-cycle the pod; check `http://triagepod.local` |
| Mic not hearing in a loud room | Press the pod button / Space before speaking; or type the answer |
| Internet down | Nothing works offline (Jev, Cartesia, Claude are cloud). Hotspot is the backup |
