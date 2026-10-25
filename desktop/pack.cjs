"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
fs.writeFileSync(path.join(__dirname, "project-root.txt"), `${root}\n`);

const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
const result = spawnSync(
  path.join(root, "node_modules", ".bin", "electron-builder"),
  ["--mac", "dir", "--publish", "never"],
  { cwd: root, env, stdio: "inherit" },
);
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

const built = path.join(root, "dist-app", "mac-arm64", "Triage Pod.app");
const destDir = path.join(require("os").homedir(), "Applications");
const dest = path.join(destDir, "Triage Pod.app");
if (fs.existsSync(built)) {
  fs.mkdirSync(destDir, { recursive: true });
  spawnSync("rm", ["-rf", dest], { stdio: "inherit" });
  spawnSync("ditto", [built, dest], { stdio: "inherit" });
  spawnSync("xattr", ["-cr", dest], { stdio: "inherit" });
  process.stdout.write(`Installed ${dest}\n`);
}
process.exit(0);
