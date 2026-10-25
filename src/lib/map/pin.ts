// Keeping things pinned to the ground on the globe pages.
//
// globe.gl draws HTML markers, particles and lines at `altitude × globe radius` above the surface.
// Anything above 0 parallaxes: seen obliquely (near the edge of the view, or zoomed in close) the
// marker slides away from its lat/lng by roughly 22,000 px per unit of altitude at the near zoom,
// so a marker at 0.004 floated ~90 px off its village. Everything that belongs on the ground uses
// GROUND (0); depth is added with CSS instead (translate the visible part inside a zero-size anchor).

export const GROUND = 0;

// Zoom bands shared by the pages: the camera altitude in globe radii.
export type Band = "far" | "mid" | "near";
export const bandOf = (alt: number): Band => (alt > 0.16 ? "far" : alt < 0.11 ? "near" : "mid");

export const GLOBE_R = 100; // three-globe's sphere radius, for writing marker positions in place
export const polar2Cartesian = (lat: number, lng: number, alt = 0) => {
  const phi = ((90 - lat) * Math.PI) / 180, theta = ((90 - lng) * Math.PI) / 180, r = GLOBE_R * (1 + alt);
  return { x: r * Math.sin(phi) * Math.cos(theta), y: r * Math.cos(phi), z: r * Math.sin(phi) * Math.sin(theta) };
};
// How many km one screen pixel covers at this camera altitude (fov 50°, view height in px).
export const kmPerPx = (alt: number, heightPx: number) => (2 * alt * GLOBE_R * Math.tan((25 * Math.PI) / 180) * 63.71) / Math.max(1, heightPx);

// Lines are three.js fat lines whose stroke is in PIXELS (not degrees): 0.028 was invisible.
// Re-stroke the existing line objects in place when the zoom band changes, without rebuilding them.
type LineLike = { __threeObjPath?: { children?: { material?: { linewidth?: number; needsUpdate?: boolean } }[] } };
export function restrokePaths<T>(paths: T[], width: (d: T) => number) {
  for (const p of paths) {
    const mat = (p as LineLike).__threeObjPath?.children?.[0]?.material;
    if (mat && "linewidth" in mat) { mat.linewidth = width(p); mat.needsUpdate = true; }
  }
}
