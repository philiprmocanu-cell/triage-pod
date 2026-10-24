// Triage Pod case: three prints that each fit a 3.5-hour slot at the Cal Hacks 3D printing station.
// Measure your parts and change the numbers in this block, then render one part at a time:
//   part = "faceplate";  part = "watch_shelf";  part = "base";
// Export STL (F6 then File > Export). 0.28 mm layers, 15% infill, no supports needed.

part = "faceplate"; // faceplate | watch_shelf | base

// ---- measure these (mm) ----
camera_board_w   = 40;   // Grove Vision AI V2 board width  (measure yours)
camera_board_h   = 20;   // Grove Vision AI V2 board height (measure yours)
lens_d           = 10;   // hole for the camera lens
watch_d          = 42;   // round display outer diameter (measure yours; ~40–44)
watch_thick      = 16;   // watch body thickness incl. battery, screen to sensor window
sensor_x         = 0;    // sensor window offset from the watch centre, mm (measure on the back)
sensor_y         = 8;
battery_w        = 36;   // 1200 mAh LiPo
battery_h        = 64;
battery_t        = 6;

// ---- case sizes ----
face_w           = 120;  // front panel width
face_h           = 190;  // front panel height; camera window near the top = patient's eye level
wall             = 2.4;
shelf_tilt       = 25;   // degrees, screen tilted up toward the patient
depth            = 70;   // base tray depth

$fn = 96;

module faceplate() {
  difference() {
    // panel with rounded corners
    linear_extrude(wall) offset(r = 6) offset(delta = -6) square([face_w, face_h]);
    // camera window: lens hole plus a shallow pocket for the camera board behind it
    translate([face_w / 2, face_h - 30, -1]) cylinder(d = lens_d, h = wall + 2);
    // slot the watch shelf hooks into
    translate([face_w / 2 - 25, 70, -1]) cube([50, 3.2, wall + 2]);
    // "Finger here" lettering, 0.6 mm deep, below the shelf
    translate([face_w / 2, 52, wall - 0.6]) linear_extrude(1) text("Ponga su dedo aqui", size = 6, halign = "center", font = "Liberation Sans:style=Bold");
    translate([face_w / 2, 42, wall - 0.6]) linear_extrude(1) text("Finger here", size = 5, halign = "center");
    translate([face_w / 2, 12, wall - 0.6]) linear_extrude(1) text("TRIAGE POD", size = 7, halign = "center", font = "Liberation Sans:style=Bold");
  }
  // camera board pocket rails on the back
  translate([face_w / 2 - camera_board_w / 2 - wall, face_h - 30 - camera_board_h / 2 - wall, wall])
    difference() {
      cube([camera_board_w + 2 * wall, camera_board_h + 2 * wall, 6]);
      translate([wall, wall, -1]) cube([camera_board_w, camera_board_h, 8]);
    }
}

// Tilted cradle: the watch lies screen-up; a slot underneath lets a fingertip reach the sensor.
module watch_shelf() {
  r = watch_d / 2 + wall;
  rotate([shelf_tilt, 0, 0]) difference() {
    union() {
      cylinder(r = r, h = watch_thick + wall);
      // hook tab that goes through the faceplate slot
      translate([-25, -r - 3, 0]) cube([50, 3, watch_thick + wall]);
    }
    // watch pocket
    translate([0, 0, wall]) cylinder(d = watch_d + 0.6, h = watch_thick + 2);
    // finger slot from the front, under the sensor window
    translate([sensor_x - 11, -r - 5, -1]) cube([22, r + sensor_y + 5, wall + 2]);
    // cable notch for the watch's USB-C
    translate([r - 8, -6, wall]) cube([12, 12, watch_thick + 2]);
  }
}

// Open-back tray: battery and charger lie flat; the faceplate clips to the front lip.
module base() {
  difference() {
    cube([face_w, depth, 40]);
    translate([wall, wall, wall]) cube([face_w - 2 * wall, depth - wall, 40]);
    // front lip groove for the faceplate
    translate([-1, wall, 30]) cube([face_w + 2, wall + 0.4, 12]);
    // switch and charger USB-C holes on the left side
    translate([-1, depth / 2, 12]) rotate([0, 90, 0]) cylinder(d = 8, h = wall + 2);
    translate([-1, depth / 2 + 14, 10]) cube([wall + 2, 10, 5]);
  }
  // battery rails
  translate([face_w / 2 - battery_w / 2 - wall, wall, wall]) cube([wall, battery_h, battery_t + 3]);
  translate([face_w / 2 + battery_w / 2, wall, wall]) cube([wall, battery_h, battery_t + 3]);
}

if (part == "faceplate") faceplate();
if (part == "watch_shelf") watch_shelf();
if (part == "base") base();
