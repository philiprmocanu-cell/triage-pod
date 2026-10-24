// Triage Pod case: three prints that each fit a 3.5-hour slot at the Cal Hacks 3D printing station.
// Measure your parts and change the numbers in this block, then render one part at a time:
//   part = "faceplate";  part = "sensor_shelf";  part = "base";
// Export STL (F6 then File > Export), or from the terminal in this folder:
//   /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD -o pod-faceplate.stl -D 'part="faceplate"' pod-case.scad
// Print: 0.28 mm layers, 15% infill, no supports needed (every part has a flat bottom).

part = "faceplate"; // faceplate | sensor_shelf | base
lettering = false;  // true engraves "Finger here / TRIAGE POD" on the faceplate

// ---- measure these (mm) ----
camera_board_w   = 40;   // Grove Vision AI V2 board width  (measure yours)
camera_board_h   = 20;   // Grove Vision AI V2 board height (measure yours)
lens_d           = 10;   // hole for the camera lens

// The red SparkFun MAX30101 board taken out of the watch. Lay it window-up on a ruler.
sensor_w         = 26;   // board width, the long side (measure; SparkFun Qwiic boards are ~25.4)
sensor_h         = 18;   // board height, the short side (measure)
sensor_board_t   = 1.6;  // bare board thickness
sensor_under     = 5;    // tallest thing on the UNDERSIDE of the board (Qwiic plug + cable); 0 if the underside is flat
sensor_win_x     = 0;    // dark window offset from the board centre, mm (+ = right when the wires leave at the back)
sensor_win_y     = 0;    //                                             (+ = toward the faceplate)

battery_w        = 36;   // 1200 mAh LiPo
battery_h        = 64;
battery_t        = 6;

// ---- case sizes ----
face_w           = 110;  // front panel width
face_h           = 170;  // front panel height; camera window near the top = patient's eye level
face_t           = 2.0;  // front panel thickness (keeps the print under 2 h)
wall             = 2.4;
shelf_tilt       = 15;   // degrees the sensor window tilts up toward the patient
shelf_y          = 70;   // height of the shelf slot on the faceplate, from its bottom edge
depth            = 70;   // base tray depth

$fn = 96;

tab_w = 50;   // tongue that slides through the faceplate slot
tab_t = 3;

module faceplate() {
  difference() {
    // panel with rounded corners
    linear_extrude(face_t) offset(r = 6) offset(delta = -6) square([face_w, face_h]);
    // camera window: lens hole; the camera board sits in the rails behind it
    translate([face_w / 2, face_h - 30, -1]) cylinder(d = lens_d, h = face_t + 2);
    // slot the sensor shelf's tongue slides through
    translate([face_w / 2 - tab_w / 2 - 0.3, shelf_y, -1]) cube([tab_w + 0.6, tab_t + 0.3, face_t + 2]);
    // hole for the sensor's four wires, just below the slot
    translate([face_w / 2 - 6, shelf_y - 9, -1]) cube([12, 6, face_t + 2]);
    // optional lettering, 0.6 mm deep
    if (lettering) translate([face_w / 2, 52, face_t - 0.6]) linear_extrude(1) text("Ponga su dedo aqui", size = 6, halign = "center", font = "Liberation Sans:style=Bold");
    if (lettering) translate([face_w / 2, 42, face_t - 0.6]) linear_extrude(1) text("Finger here", size = 5, halign = "center");
    if (lettering) translate([face_w / 2, 12, face_t - 0.6]) linear_extrude(1) text("TRIAGE POD", size = 7, halign = "center", font = "Liberation Sans:style=Bold");
  }
  // camera board pocket rails on the back
  translate([face_w / 2 - camera_board_w / 2 - wall, face_h - 30 - camera_board_h / 2 - wall, face_t])
    difference() {
      cube([camera_board_w + 2 * wall, camera_board_h + 2 * wall, 6]);
      translate([wall, wall, -1]) cube([camera_board_w, camera_board_h, 8]);
    }
}

// Sensor shelf: a small wedge in front of the faceplate. The red board drops into a pocket,
// window up, flush with the top; the patient rests a fingertip on it from the front (-y).
// A flat tongue at the back slides through the faceplate slot and is taped behind the panel.
// The faceplate is at +y; the patient is at -y. Prints flat, no supports.
module sensor_shelf() {
  t      = shelf_tilt;
  pw     = sensor_w + 0.6;                    // pocket with a little clearance
  ph     = sensor_h + 0.6;
  pocket = sensor_under + sensor_board_t;     // pocket depth so the board top sits flush
  bw     = pw + 2 * wall;                     // block outer width
  bd     = ph + 2 * wall;                     // block depth, front wall to back wall
  top    = wall + pocket;                     // block height in its own (untilted) frame
  foot   = bd * sin(t) + 2;                   // extra material below so the tilted block has a flat bottom
  extra  = (top + foot) * tan(t) + 2;         // extra depth at the back, trimmed to a vertical face below
  y_back = (bd - wall) * cos(t) - (foot + wall) * sin(t) + wall;   // where the vertical back face ends up
  tongue = face_t + 22;                       // how far the tongue reaches behind the faceplate
  difference() {
    rotate([t, 0, 0]) translate([-bw / 2, 0, -foot]) difference() {
      cube([bw, bd + extra, top + foot]);
      // board pocket, open at the top
      translate([wall, wall, foot + wall]) cube([pw, ph, pocket + 5]);
      // finger rest: the front wall is cut down to just below board level, 20 mm wide
      translate([bw / 2 - 10 + sensor_win_x, -1, foot + wall + pocket - 1.2]) cube([20, wall + 2, 10]);
      // wire notch through the back wall, from the pocket floor up
      translate([bw / 2 - 5, bd - wall - 1, foot + wall]) cube([10, wall + extra + 2, pocket + 5]);
    }
    // flat bottom
    translate([-100, -100, -50]) cube([200, 200, 50]);
    // flat vertical back face that rests against the faceplate
    translate([-100, y_back, -1]) cube([200, 100, 100]);
  }
  // tongue: a 3 mm plate that slides through the faceplate slot, with two holes for tape or a zip tie
  difference() {
    translate([-tab_w / 2, y_back - 8, 2]) cube([tab_w, 8 + tongue, tab_t]);
    for (x = [-15, 15]) translate([x, y_back + face_t + 14, -1]) cylinder(d = 4, h = 10);
  }
}

// Open-back tray: battery and charger lie flat; the faceplate stands in the front groove.
module base() {
  difference() {
    cube([face_w, depth, 40]);
    translate([wall, wall, wall]) cube([face_w - 2 * wall, depth - wall, 40]);
    // front groove for the faceplate
    translate([-1, wall, 30]) cube([face_w + 2, face_t + 0.4, 12]);
    // switch and charger USB-C holes on the left side
    translate([-1, depth / 2, 12]) rotate([0, 90, 0]) cylinder(d = 8, h = wall + 2);
    translate([-1, depth / 2 + 14, 10]) cube([wall + 2, 10, 5]);
  }
  // battery rails
  translate([face_w / 2 - battery_w / 2 - wall, wall, wall]) cube([wall, battery_h, battery_t + 3]);
  translate([face_w / 2 + battery_w / 2, wall, wall]) cube([wall, battery_h, battery_t + 3]);
}

if (part == "faceplate") faceplate();
if (part == "sensor_shelf" || part == "watch_shelf") sensor_shelf();
if (part == "base") base();
