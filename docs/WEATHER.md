# Weather, floods and the roads: `/api/weather/*` and the forecast fields on `/api/satellite`

The question from the field: *how do we know a road will be flooded before the trucks leave?*
Medicines and vaccines have to go out **before** the roads close, so the dispatcher needs the next
two weeks, not the last month. This is what the pod now answers, from free sources with no key.

Checked live on 24 Oct 2026 from the venue. Code: `src/lib/weather/`, routes `src/app/api/weather/`.

## What the dispatcher sees

| Field (per post) | Meaning | Source |
| --- | --- | --- |
| `rainNext14Mm` | rain forecast for today + 13 days | Open-Meteo forecast |
| `wettestForecastDayMm`, `wettestForecastDate` | the single wettest day in the 16-day forecast | Open-Meteo forecast |
| `rainNext14Days[]` | `{ date, mm, prob }` per day (prob = chance of rain that day, %) | Open-Meteo forecast |
| `rain7Mm`, `rain72hMm` | rain in the last 7 days / 72 h, same-day latency | Open-Meteo past days |
| `floodRiskToday` | low / medium / high, with `floodRiskTodayReasons` | NASA flood map + last 72 h + river today |
| `floodRisk14d` | low / medium / high, with `floodRisk14dReasons` | forecast rain + ground saturation + GloFAS river |
| `cutOffRisk`, `cutOffDays`, `cutOffDate` | "roads may close in N days (…)" | first day the forecast reaches a road-closing amount |
| `malariaOutlook6w`, `malariaReason` | low / medium / high six weeks out | rain fallen + rain forecast + temperature |
| `river` | GloFAS forecast peak vs last year's 95th percentile (`ratio`), today's (`todayRatio`) | Copernicus GloFAS v4 via Open-Meteo |
| `floodNow` | % of the area within 10 km the satellite saw under unusual flood / recurring flood / normal water, and how much it could see at all | NASA LANCE MODIS/VIIRS via GIBS |

## Endpoints

### `GET /api/weather/outlook` (government-ready summary)

```json
{
  "posts": [ { "villageId", "id", "name", "lat", "lng", "hub",
               "floodRiskToday", "floodRiskTodayReasons", "floodRisk14d", "floodRisk14dReasons",
               "cutOffRisk", "cutOffDays", "cutOffDate",
               "rainNext14Mm", "wettestForecastDayMm", "wettestForecastDate", "rain72hMm", "rain7Mm", "rain30Mm", "meanTempC",
               "malariaOutlook6w", "malariaReason", "rainNext14Days", "river", "floodNow" } ],
  "sources": [ "Open-Meteo forecast (…), run 2026-10-24, 32 grid cells, fetched …",
               "Copernicus GloFAS v4 river discharge (5 km) via the Open-Meteo flood API, forecast to 2026-11-08, baseline 365 days …",
               "NASA LANCE MODIS/VIIRS near-real-time 3-day flood composite (… via GIBS …), composite date 2026-10-24, fetched …" ],
  "preliminary": "PRELIMINARY: rain beyond day 7 is model guidance … The dispatcher confirms with the district driver before a truck leaves.",
  "errors": {}, "fetchedAt": "…", "cached": true
}
```

`errors` names any source that failed on the last refresh (`forecast`, `river`, `flood`) and says
whether a saved copy is being shown.

### `GET /api/weather/road?from=<lat>,<lng>&to=<lat>,<lng>[&date=YYYY-MM-DD][&days=3]` (for the Routes agent)

The leg is sampled at 3 points (under 40 km), 4 (under 120 km) or 5 along the straight line.
Each sample reads its 0.25° forecast cell (nearest cached cell if the point is just outside the
posts' grid), the GloFAS cell and the flood map within 5 km. The leg carries its worst sample.

- `date`: the day the truck leaves (default today). `days`: how many days the trip is exposed
  (default 3, max 16). The window is `[date, date + days)`.
- Answer: `{ risk: "low"|"medium"|"high", reasons: string[], distanceKm, date, days, samples: [{ lat, lng, risk, reasons, rain72hMm, rainWindowMm, wettestWindowMm, wettestWindowDate, floodPct, observedPct, cell }], sources, preliminary, fetchedAt }`.
  `reasons` always has at least one line, naming the worst sample's coordinates.
- Speed: ~15 ms once the three-hourly cache is warm (measured), 1–4 s on the first call after a
  cold start while the sources are fetched. Never more than the 15 s per-source timeout.
- 400 with an example URL when `from`/`to` are malformed; 502 with `risk: "low"` and the error in
  `reasons` if no weather can be had at all.

Examples, 24 Oct 2026 (end of the dry season):

- Chipata → Katete (80 km, leaving today, 3 days): **low** — "0 mm in the last 72 h, 0 mm forecast over 3 days (wettest 0 mm); no flood water on the satellite map (14.7% of the area observed)".
- Chipata → Chama (274 km, leaving 1 Nov, 4 days): **medium** — "28.2 mm forecast on 2026-11-02 (near -11.217, 33.167)"; the four samples further south stay low (7–17 mm wettest day).

### `GET /api/weather/seasons` (the ten-year calendar, for pre-positioning)

The forecast sees 16 days. The season calendar says what *usually* happens, so the dispatcher can
plan the whole wet season: when the rains start and end at each post, which weeks usually close the
road, how many days a month the post is usually cut off, and when malaria peaks. Code
`src/lib/weather/seasons.ts`, cache `data/seasons.json` (kept a month; recomputed when the ten-year
window moves on 1 July).

Source: **Open-Meteo archive API** (`archive-api.open-meteo.com/v1/archive`, ERA5 reanalysis, keyless),
daily `precipitation_sum` for ten hydrological years (1 July 2016 → 30 June 2026), one 0.25° cell per
post (32 cells for 40 posts, four cells a call with a pause: the free quota weighs ten-year requests
heavily and answers 429 when pushed; the fetch keeps what arrived and finishes on the next call).

Per post: `{ wetSeasonStart, wetSeasonEnd, typical {start,end}, closureWeeks[{from,to,frequency}],
closureStart, closureEnd, cutOffDaysByMonth[12] (January first), cutOffDaysInSeason,
malariaPeak {from,to}, confidence, confidenceWhy, seasonRainMm, rainByMonth[12], years, source }`.
Dates are placed in the current or coming season (1 July → 30 June); `?refresh=1` recomputes.

How each number is made (`computeCellSeason`):

- **Onset**: the first day from 1 September with 25 mm in the trailing 10 days and no 10-day dry spell
  in the following 30 (the usual agro-meteorological definition); median over the ten seasons.
  **End**: the last day after 1 January with rain and 20 mm in the trailing 10 days; median.
- **Closure weeks**: the road-closing marks from `model.ts` (one day ≥ 40 mm or 72 h ≥ 80 mm) applied
  to the cell average **× 1.5** (`AREA_TO_POINT`: an ERA5 cell is ~28 km across and its daily extremes
  are softer than one road's gauge; the factor is an estimate for the district to tune). A season week
  (from 1 July) is a closure week when **3 of the 10 years** closed the road in it (`CLOSURE_WEEK_MIN_FREQ`).
- **Cut-off days**: a closing day plus the two after it (`CLOSURE_LASTS_DAYS` = 3), averaged per
  calendar month.
- **Malaria peak**: the wettest four weeks of the climatology, shifted 4 weeks (start) and 8 weeks
  (end): the lag from rain to cases.
- **Confidence**: how much the onset moves between years: ±12 days high, ±24 medium, else low
  (and low under 7 seasons).

Checked 24 Oct 2026 (ten seasons each, medium confidence, onset ±15–16 days):

| Post | Rains | Closure weeks | Cut-off days by month (Dec, Jan, Feb, Mar) | Malaria peak | Season rain |
| --- | --- | --- | --- | --- | --- |
| **Katete** | 22 Nov → 5 Apr | 13 Jan → 9 Feb (4 weeks, 3–4 of 10 years) | 0.6, 3.1, 3.2, 1.7 (8.6 a season) | 27 Jan → 24 Mar | 814 mm |
| **Chama** | 1 Dec → 24 Apr | 23 Dec → 16 Mar (5 weeks: 23 Dec, 30 Dec, 20 Jan at 5 of 10 years, 17 Feb, 10 Mar) | 2.9, 3.9, 2.6, 2.1 (11.9) | 20 Jan → 17 Mar | 970 mm |
| Chipata | 22 Nov → 11 Apr | 30 Dec → 2 Mar (8 weeks) | 2.4, 5.7, 4.2, 1.6 (14.7) | 13 Jan → 10 Mar | 930 mm |
| Mfuwe | 27 Nov → 10 Apr | 25 Nov → 9 Mar (10 weeks) | 3.8, 5.8, 4.5, 2.5 (18) | 13 Jan → 10 Mar | 956 mm |
| Lundazi | 4 Dec → 12 Apr | 23 Dec week only (4 of 10 years) | 1.8, 2.1, 0.5, 0.4 (5.1) | 20 Jan → 17 Mar | 808 mm (high confidence, ±11 days) |

Honest limit: this is a reanalysis cell average, scaled by a guess, not a log of which roads closed
when. The ×1.5 factor and the 3-of-10 rule are named constants for the district to replace with its
own record. The dispatch planner uses it for *seasonal* pre-positioning (docs/DISPATCH.md).

### `GET /api/weather/outlook?meta=1`

Only `{ fetchedAt, cacheAgeSec, ttlSec, errors }`, for the Routes page's watcher (it re-checks every
live route when `fetchedAt` changes). The full answer also carries `cacheAgeSec` and `ttlSec` now.

### `GET /api/satellite` (unchanged fields + overlay)

Every field the government page already reads is exactly as before (`rain30Mm`, `lastYearRain30Mm`,
`meanTempC`, `malariaRisk`, `floodRisk`, `suspectDays`, `wettestDayMm`, `days`, `villageId`, `id`,
`name`, `lat`, `lng`, `hub`, top-level `source`, `cached`, `fetchedAt`). Added per post:
`rain7Mm`, `rain72hMm`, `rainNext14Mm`, `wettestForecastDayMm`, `wettestForecastDate`,
`rainNext14Days`, `floodRiskToday`, `floodRisk14d`, `floodRisk14dReasons`, `cutOffRisk`,
`cutOffDays`, `malariaOutlook6w`, `malariaReason`, `floodNowPct`, `riverRiseRatio`; top-level
`forecastSource[]`, `forecastNote`, `forecastErrors`. The overlay is merged at answer time from its
own cache, so if the forecast services are down the POWER answer still comes through untouched.

Example, 24 Oct 2026: Katete `rain30Mm` 378 (NASA POWER preliminary; last year 0) vs Open-Meteo
`rain30Mm` 27.9, `rainNext14Mm` 10.4, `malariaOutlook6w` low. Chama `rainNext14Mm` 60.6, wettest day
28.2 mm on 2 Nov, `floodRisk14d` medium, `malariaOutlook6w` medium.

## Sources, what was keyless and what was not

| Source | Used for | Access | Status 24 Oct 2026 |
| --- | --- | --- | --- |
| **Open-Meteo forecast** `api.open-meteo.com/v1/forecast` | 16 days ahead, 30 days back (`past_days=30`); daily `precipitation_sum`, `precipitation_probability_max`, `temperature_2m_max/min` | keyless, free for non-commercial use, 10 000 calls/day | **live**; all 32 cells in two batched calls (comma-separated coordinates) |
| **Copernicus GloFAS v4** via `flood-api.open-meteo.com/v1/flood` | daily river discharge, 365 days back + 16 ahead, `models=seamless_v4` | keyless | **live**. Direct Copernicus access (`ewds.climate.copernicus.eu/api/retrieve/v1/processes/cems-glofas-forecast`) answers 401 "authentication required" without an ECMWF account token; not needed |
| **NASA LANCE MODIS/VIIRS flood (MCDWD, 3-day composite)** via GIBS WMS `gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi`, layer `MODIS_Combined_Flood_3-Day` | what is under water right now, one picture of the province at ~550 m per pixel; colour key `colormaps/v1.3/MODIS_Flood.xml` (red = flood, yellow = recurring flood, cyan = surface water, grey = not observed) | keyless | **live**. The raw 250 m HDF files at `nrt3.modaps.eosdis.nasa.gov/api/v2/content/archives/allData/61/MCDWD_L3_NRT/` list without a login but every download redirects (303) to the Earthdata licence/login page |
| NASA POWER (already in `/api/satellite`) | the last 30 days, finished record a year ago | keyless | live; lags 2 days, recent weeks preliminary |
| **Open-Meteo archive** `archive-api.open-meteo.com/v1/archive` (ERA5) | ten years of daily rain per cell for the season calendar | keyless; heavy requests hit a per-minute quota (429) | **live**; 32 cells in 8 calls with pauses, cached a month |
| Google Flood Hub API `floodforecasting.googleapis.com` | gauge-level flood forecasts | needs a Google Cloud API key (403 "unregistered callers") | **not used**; a free key would add river gauges on the Luangwa |

Optional later: `NASA_EARTHDATA_TOKEN` — an Earthdata Login bearer token. Nothing reads it today; it
would unlock the raw 250 m LANCE flood files (instead of the picture) and NASA POWER's finished data
sooner. Keep it out of the browser.

## How the three words are decided (`src/lib/weather/model.ts`)

Thresholds are named constants so the district can tune them from experience:

- Road-closing rain: one day ≥ **40 mm** (the same mark `/api/satellite` already uses for `floodRisk`)
  or three days ≥ **80 mm**. Warning: ≥ 20 mm / ≥ 40 mm. `cutOffDays` is the first forecast day that
  reaches a closing amount, counted from today (0 = today). "Roads may already be cut" when the
  satellite sees unusual flood water within 10 km or 80 mm fell in the last 72 h.
- `floodRisk14d`: high if the wettest forecast day ≥ 40 mm, or ≥ 150 mm over 14 days, or the ground is
  already wet (≥ 40 mm in 7 days) with ≥ 80 mm more coming, or the GloFAS river is forecast ≥ 1.5× last
  year's 95th percentile, or it is flooded now. Medium at half those marks. The GloFAS ratio is ignored
  where the cell's baseline is under 0.05 m³/s (no real river in the 5 km cell).
- `floodRiskToday`: high if unusual flood pixels ≥ 1% of what the satellite could see within 10 km, or
  ≥ 80 mm in 72 h, or the river today ≥ 1.5× the baseline; medium if standing water ≥ 10%, ≥ 40 mm in
  72 h, or the river ≥ 1× the baseline.
- `malariaOutlook6w`: Anopheles need standing water and 18–32 °C; cases follow the rain by 4–8 weeks.
  Water = rain in the last 30 days + rain forecast for 14 days. High ≥ 120 mm, medium ≥ 50 mm, only if
  the mean temperature over the window is 18–32 °C; otherwise low. `malariaReason` prints the numbers.
- Road sample: high if flood pixels ≥ 1% within 5 km, a window day ≥ 40 mm, last 72 h + window ≥ 100 mm,
  or the river ≥ 1.5×; medium at the warning marks.

## Caching, timeouts, slow internet

- All three sources are fetched at most every **3 hours**, kept in memory and in `data/weather.json`
  (about 0.9 MB; the flood picture is one byte per pixel). A failed refresh keeps the last good copy
  and reports it in `errors`. Concurrent callers share one in-flight fetch.
- Every external call has a **15 s** timeout. The satellite route's own 6 h POWER cache is untouched.
- Warm answers: outlook ~35 ms, road ~15 ms. Cold (empty disk, first call): 3–5 s.

## The honest limit

Satellites and models give **area** flooding, not road passability. The MODIS/VIIRS map only sees
water where the sky was clear (on 24 Oct it observed 15–38% of the area around each post) and only
patches of 250 m or more; a washed-out culvert or a flooded ford is invisible to it. Rain beyond
day 7 is guidance that changes with every model run, and Open-Meteo's "past days" are the model's
own analysis, not rain gauges. The GloFAS cells over these posts are small tributaries (last year's
95th percentile is 0.2–0.9 m³/s), so the river signal is relative, not a flood stage. Treat every
badge as "ask before you send": **the dispatcher confirms with the district driver** before a truck
leaves, and the pod records what the driver said next to what the satellite said.

## What is left

- Show the fields on the government page and the planner (another agent's lane); the data is there.
- A Google Flood Hub key (free Cloud project) would add real gauge forecasts for the Luangwa and Lundazi rivers.
- With `NASA_EARTHDATA_TOKEN`: the 250 m LANCE product and Sentinel-1 radar flood maps (see through cloud), which would lift the "observed" share from ~25% to near 100%.
- Tune the thresholds with the district's own record of which roads closed on which days.
