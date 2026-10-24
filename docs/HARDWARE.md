# Build a demo pod tonight

Two screens: the **pod screen** faces the patient (`/kiosk`: questions only, no diagnoses) and the
**health-worker screen** (`/staff`: live diagnosis, decision path, vitals entry). Everything else
(`/agents`, `/dashboard`, `/deploy`) is for the judges.

## Tier 0 — $0, 30 minutes (what you already have)

| Part | Use |
|---|---|
| MacBook | Runs the app; its screen is the pod screen |
| **iPhone as webcam** (Continuity Camera — already available on this Mac) | Mount it at eye level on top of a box, landscape, ~50 cm from the patient's face. In Chrome pick "iPhone Camera" when asked |
| A cardboard box | Pod body: laptop inside or behind, phone on top, cut a window for the screen |
| Teammate's laptop or phone | Health-worker screen: open `/staff` (see "Two devices" below) |
| Space bar | The pod's one button |

## Tier 1 — about $100–200, buy today (Best Buy / Target / CVS / Walgreens)

| Part | ~Price | Why it matters on stage |
|---|---|---|
| USB/Bluetooth speakerphone (Jabra Speak, Anker PowerConf, eMeet) | $60–100 | Echo-cancelling mic + loud speaker. Hackathon halls are loud; this is what makes hands-free voice work |
| Ring light (8–10") with phone clip | $20–35 | Even light on the face → better camera scan, face droop check and heart rate |
| **Fingertip pulse oximeter** | $20–30 | The single most useful real measurement (oxygen + pulse). Type the number into `/staff` → low oxygen turns the case red automatically |
| Digital thermometer | $10 | Fever ≥ 38 °C counts as fever in the rules |
| Presentation clicker (any) | $15–25 | Becomes the pod's big button (PageDown / arrow / Enter all work) |
| Portable USB-C monitor 13–16" | $80–150 | Patient-facing pod screen while the laptop shows `/staff` |

Optional: automatic BP cuff ($30–60, typed into `/staff`; ≥160/110 → red), glucometer ($20 + strips; < 70 mg/dL → red).
A big arcade button + USB encoder board (~$15 online) can replace the clicker if you have a day.

## Build (≈1 hour)

1. Box: tape a cardboard or foam-board box ~40 cm tall. Cut a window for the screen facing the patient.
2. Camera: phone (or webcam) on top of the box at the patient's eye level, ring light right behind it.
3. Speakerphone on the front ledge, facing the patient.
4. Clicker or button on the front: label it **"Hablar / Talk"**.
5. Tape a sign: "Asistente de salud · Health pod — no reemplaza al médico".
6. Oximeter + thermometer in a little tray beside it, for the health worker.

## Run it

1. Start the app (it is already running at `http://localhost:3417`).
2. **Pod screen:** in Chrome open `http://localhost:3417/kiosk`, allow camera + microphone (choose the
   iPhone camera and the speakerphone mic), press **F** for full screen. Drag it to the portable monitor if you have one.
3. **Health-worker screen:** a second Chrome window on the laptop at `http://localhost:3417/staff`.

### Two devices (staff screen on a phone / teammate laptop)
Browsers only allow camera and mic on `https://` (or localhost), so share the app over a secure tunnel:

```bash
cloudflared tunnel --url http://localhost:3417
```

It prints an `https://….trycloudflare.com` link. Open `/staff` on the other device with that link.
Anyone with the link can use the app (and your API credits) — stop it with Ctrl+C after the demo.

## 90-second demo script

1. Patient sits → pod greets in Spanish by itself, asks name / village / consent.
2. "Mi niño tiene tos y calentura" → pod says it back ("Entiendo que…, ¿es así?") → asks since when, how bad.
3. Health worker clips the **oximeter**, types 88 % into `/staff` → case turns **red: low oxygen**, referral + supplies.
4. Switch to `/agents`: the visit arrives, doctor queue assigns it, referral router books transport.
5. `/dashboard` → start an outbreak → drones fly. Close on `/deploy`: where it goes next, lives per year.

## Known demo risks

- Loud room → use the clicker to start talking; the speakerphone helps most.
- Venue Wi-Fi → bring a phone hotspot; Jev, Cartesia and Claude all need internet.
- Lighting → ring light on; avoid a bright window behind the patient.
