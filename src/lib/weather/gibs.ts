import { decodePng } from "./png";

// NASA's near-real-time flood map (LANCE MODIS/VIIRS "MCDWD" 3-day composite) served as a picture
// by GIBS, which needs no Earthdata login: https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi
// Layer MODIS_Combined_Flood_3-Day, colour key from
// https://gibs.earthdata.nasa.gov/colormaps/v1.3/MODIS_Flood.xml:
//   transparent  no water          (50,210,245) surface water (normal rivers, lakes)
//   (255,255,0)  recurring flood   (250,30,36)  flood (water where there normally is none)
//   (175,175,175) insufficient data (cloud, or no clear pass in the 3 days)
// One picture of the whole province at about 550 m per pixel, kept as one byte per pixel.
// The raw product (250 m HDF) is behind Earthdata login; set NASA_EARTHDATA_TOKEN to use it
// later. Water shows at 250 m only where the sky was clear; it says an AREA is under water, not
// whether a particular road is passable.

export const FLOOD_CLASS = { nodata: 0, dry: 1, water: 2, recurring: 3, flood: 4 } as const;
export type FloodClass = (typeof FLOOD_CLASS)[keyof typeof FLOOD_CLASS];

export type FloodRaster = {
  date: string; // composite end date (UTC)
  bbox: { south: number; west: number; north: number; east: number };
  width: number; height: number;
  grid: string; // base64, one byte per pixel, row 0 = north
};

const PX_PER_DEG = 200; // ~550 m
const TIMEOUT = 15000;

function classify(r: number, g: number, b: number, a: number): FloodClass {
  if (a < 128) return FLOOD_CLASS.dry;
  const near = (x: number, y: number) => Math.abs(x - y) <= 12;
  if (near(r, 250) && near(g, 30) && near(b, 36)) return FLOOD_CLASS.flood;
  if (near(r, 255) && near(g, 255) && near(b, 0)) return FLOOD_CLASS.recurring;
  if (near(r, 50) && near(g, 210) && near(b, 245)) return FLOOD_CLASS.water;
  if (near(r, 175) && near(g, 175) && near(b, 175)) return FLOOD_CLASS.nodata;
  return FLOOD_CLASS.nodata;
}

export async function fetchFloodRaster(bbox: FloodRaster["bbox"], date: string): Promise<FloodRaster> {
  const width = Math.min(2048, Math.max(32, Math.round((bbox.east - bbox.west) * PX_PER_DEG)));
  const height = Math.min(2048, Math.max(32, Math.round((bbox.north - bbox.south) * PX_PER_DEG)));
  const url = `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=MODIS_Combined_Flood_3-Day&CRS=EPSG:4326&BBOX=${bbox.south},${bbox.west},${bbox.north},${bbox.east}&WIDTH=${width}&HEIGHT=${height}&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${date}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("image/png")) throw new Error(`GIBS ${res.status} ${res.headers.get("content-type") ?? ""}`);
  const img = decodePng(Buffer.from(await res.arrayBuffer()));
  const grid = Buffer.alloc(img.width * img.height);
  for (let i = 0; i < grid.length; i++) grid[i] = classify(img.px[i * 4], img.px[i * 4 + 1], img.px[i * 4 + 2], img.px[i * 4 + 3]);
  return { date, bbox, width: img.width, height: img.height, grid: grid.toString("base64") };
}

export type FloodNear = { observedPct: number; floodPct: number; recurringPct: number; waterPct: number; radiusKm: number; inside: boolean };

// What the satellite saw within `radiusKm` of a point: share of pixels that were observed at
// all, and of those, the share under unusual flood / recurring flood / normal surface water.
// The decoded grid of the raster last asked about, so forty posts or five road samples do not
// each unpack the same base64.
let decoded: { key: string; grid: Buffer } | null = null;
function gridOf(raster: FloodRaster): Buffer {
  const key = `${raster.date}|${raster.width}x${raster.height}|${raster.grid.length}`;
  if (decoded?.key !== key) decoded = { key, grid: Buffer.from(raster.grid, "base64") };
  return decoded.grid;
}

export function floodNear(raster: FloodRaster, lat: number, lng: number, radiusKm: number): FloodNear {
  const grid = gridOf(raster);
  const { bbox, width, height } = raster;
  const dLat = radiusKm / 111, dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  const col = (x: number) => Math.floor(((x - bbox.west) / (bbox.east - bbox.west)) * width);
  const row = (y: number) => Math.floor(((bbox.north - y) / (bbox.north - bbox.south)) * height);
  const c0 = Math.max(0, col(lng - dLng)), c1 = Math.min(width - 1, col(lng + dLng));
  const r0 = Math.max(0, row(lat + dLat)), r1 = Math.min(height - 1, row(lat - dLat));
  const inside = lat <= bbox.north && lat >= bbox.south && lng >= bbox.west && lng <= bbox.east;
  let total = 0, observed = 0, flood = 0, recurring = 0, water = 0;
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const v = grid[r * width + c];
      total++;
      if (v === FLOOD_CLASS.nodata) continue;
      observed++;
      if (v === FLOOD_CLASS.flood) flood++;
      else if (v === FLOOD_CLASS.recurring) recurring++;
      else if (v === FLOOD_CLASS.water) water++;
    }
  const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
  return { observedPct: pct(observed, total), floodPct: pct(flood, observed), recurringPct: pct(recurring, observed), waterPct: pct(water, observed), radiusKm, inside };
}
