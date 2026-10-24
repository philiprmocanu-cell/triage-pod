"""Builds the three case parts as STL files without OpenSCAD (same shapes as pod-case.scad).

    python3 make_stl.py            -> pod-faceplate.stl, pod-watch_shelf.stl, pod-base.stl

Measure your parts and change the numbers below first. Text lettering is left to the slicer
(or a label) because mesh text needs fonts; everything else matches the .scad file.
"""
import numpy as np
import trimesh
from trimesh.creation import box, cylinder

# ---- measure these (mm) ----
camera_board_w, camera_board_h = 40.0, 20.0
lens_d = 10.0
watch_d = 42.0
watch_thick = 16.0
sensor_x, sensor_y = 0.0, 8.0
battery_w, battery_h, battery_t = 36.0, 64.0, 6.0
# ---- case sizes ----
face_w, face_h = 120.0, 190.0
wall = 2.4
shelf_tilt = 25.0
depth = 70.0


def B(w, h, d, at):
    """Box with its min corner at `at` (like OpenSCAD cube + translate)."""
    m = box(extents=[w, h, d])
    m.apply_translation([at[0] + w / 2, at[1] + h / 2, at[2] + d / 2])
    return m


def C(d, h, at, axis="z"):
    m = cylinder(radius=d / 2, height=h, sections=96)
    if axis == "x":
        m.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, [0, 1, 0]))
        m.apply_translation([at[0] + h / 2, at[1], at[2]])
    else:
        m.apply_translation([at[0], at[1], at[2] + h / 2])
    return m


def cut(a, *bs):
    for b in bs:
        a = a.difference(b)
    return a


def faceplate():
    panel = B(face_w, face_h, wall, (0, 0, 0))
    panel = cut(
        panel,
        C(lens_d, wall + 2, (face_w / 2, face_h - 30, -1)),
        B(50, 3.2, wall + 2, (face_w / 2 - 25, 70, -1)),
    )
    # camera board pocket rails on the back
    rails = cut(
        B(camera_board_w + 2 * wall, camera_board_h + 2 * wall, 6, (face_w / 2 - camera_board_w / 2 - wall, face_h - 30 - camera_board_h / 2 - wall, wall)),
        B(camera_board_w, camera_board_h, 8, (face_w / 2 - camera_board_w / 2, face_h - 30 - camera_board_h / 2, wall - 1)),
    )
    return panel.union(rails)


def watch_shelf():
    r = watch_d / 2 + wall
    body = C(2 * r, watch_thick + wall, (0, 0, 0)).union(B(50, 3, watch_thick + wall, (-25, -r - 3, 0)))
    body = cut(
        body,
        C(watch_d + 0.6, watch_thick + 2, (0, 0, wall)),
        B(22, r + sensor_y + 5, wall + 2, (sensor_x - 11, -r - 5, -1)),
        B(12, 12, watch_thick + 2, (r - 8, -6, wall)),
    )
    body.apply_transform(trimesh.transformations.rotation_matrix(np.radians(shelf_tilt), [1, 0, 0]))
    # drop it onto the build plate
    body.apply_translation([0, 0, -body.bounds[0][2]])
    return body


def base():
    tray = cut(
        B(face_w, depth, 40, (0, 0, 0)),
        B(face_w - 2 * wall, depth - wall, 40, (wall, wall, wall)),
        B(face_w + 2, wall + 0.4, 12, (-1, wall, 30)),
        C(8, wall + 2, (-1, depth / 2, 12), axis="x"),
        B(wall + 2, 10, 5, (-1, depth / 2 + 14, 10)),
    )
    rails = B(wall, battery_h, battery_t + 3, (face_w / 2 - battery_w / 2 - wall, wall, wall)).union(
        B(wall, battery_h, battery_t + 3, (face_w / 2 + battery_w / 2, wall, wall))
    )
    return tray.union(rails)


if __name__ == "__main__":
    for name, fn in [("faceplate", faceplate), ("watch_shelf", watch_shelf), ("base", base)]:
        m = fn()
        m.export(f"pod-{name}.stl")
        x, y, z = m.extents
        print(f"pod-{name}.stl  {x:.0f} x {y:.0f} x {z:.0f} mm  watertight={m.is_watertight}")
