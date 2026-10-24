"""Builds the three case parts as STL files without OpenSCAD (same shapes as pod-case.scad).

    pip install trimesh manifold3d
    python3 make_stl.py            -> pod-faceplate.stl, pod-sensor_shelf.stl, pod-base.stl

Measure your parts and change the numbers below first. Two differences from the .scad file:
the sensor shelf is printed flat (no tilt) and the optional lettering is left to the slicer.
"""
import numpy as np
import trimesh
from trimesh.creation import box, cylinder

# ---- measure these (mm) ----
camera_board_w, camera_board_h = 40.0, 20.0
lens_d = 10.0
sensor_w, sensor_h = 26.0, 18.0     # red MAX30101 board, long side x short side
sensor_board_t = 1.6
sensor_under = 5.0                  # tallest thing on the underside of the board (Qwiic plug); 0 if flat
sensor_win_x = 0.0                  # dark window offset from the board centre
battery_w, battery_h, battery_t = 36.0, 64.0, 6.0
# ---- case sizes ----
face_w, face_h, face_t = 110.0, 170.0, 2.0
wall = 2.4
shelf_y = 70.0
depth = 70.0
tab_w, tab_t = 50.0, 3.0


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
    panel = B(face_w, face_h, face_t, (0, 0, 0))
    panel = cut(
        panel,
        C(lens_d, face_t + 2, (face_w / 2, face_h - 30, -1)),
        B(tab_w + 0.6, tab_t + 0.3, face_t + 2, (face_w / 2 - tab_w / 2 - 0.3, shelf_y, -1)),   # shelf tongue slot
        B(12, 6, face_t + 2, (face_w / 2 - 6, shelf_y - 9, -1)),                                  # sensor wire hole
    )
    rails = cut(
        B(camera_board_w + 2 * wall, camera_board_h + 2 * wall, 6, (face_w / 2 - camera_board_w / 2 - wall, face_h - 30 - camera_board_h / 2 - wall, face_t)),
        B(camera_board_w, camera_board_h, 8, (face_w / 2 - camera_board_w / 2, face_h - 30 - camera_board_h / 2, face_t - 1)),
    )
    return panel.union(rails)


def sensor_shelf():
    """Flat block: the red board drops into a pocket window-up; fingertip cut-out at the front (-y);
    wire notch at the back; a tongue that slides through the faceplate slot and is taped behind it."""
    pw, ph = sensor_w + 0.6, sensor_h + 0.6
    pocket = sensor_under + sensor_board_t
    bw, bd = pw + 2 * wall, ph + 2 * wall
    top = wall + pocket
    body = cut(
        B(bw, bd, top, (-bw / 2, 0, 0)),
        B(pw, ph, pocket + 5, (-pw / 2, wall, wall)),
        B(20, wall + 2, 10, (-10 + sensor_win_x, -1, wall + pocket - 1.2)),
        B(10, wall + 2, pocket + 5, (-5, bd - wall - 1, wall)),
    )
    tongue = cut(
        B(tab_w, 8 + face_t + 22, tab_t, (-tab_w / 2, bd - 8, 2)),
        C(4, 10, (-15, bd + face_t + 14, -1)),
        C(4, 10, (15, bd + face_t + 14, -1)),
    )
    return body.union(tongue)


def base():
    tray = cut(
        B(face_w, depth, 40, (0, 0, 0)),
        B(face_w - 2 * wall, depth - wall, 40, (wall, wall, wall)),
        B(face_w + 2, face_t + 0.4, 12, (-1, wall, 30)),
        C(8, wall + 2, (-1, depth / 2, 12), axis="x"),
        B(wall + 2, 10, 5, (-1, depth / 2 + 14, 10)),
    )
    rails = B(wall, battery_h, battery_t + 3, (face_w / 2 - battery_w / 2 - wall, wall, wall)).union(
        B(wall, battery_h, battery_t + 3, (face_w / 2 + battery_w / 2, wall, wall))
    )
    return tray.union(rails)


if __name__ == "__main__":
    for name, fn in [("faceplate", faceplate), ("sensor_shelf", sensor_shelf), ("base", base)]:
        m = fn()
        m.export(f"pod-{name}.stl")
        x, y, z = m.extents
        print(f"pod-{name}.stl  {x:.0f} x {y:.0f} x {z:.0f} mm  watertight={m.is_watertight}")
