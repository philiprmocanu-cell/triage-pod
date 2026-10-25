"use strict";

// Thin Mac shell: start the local stack (SpacetimeDB if needed, then Next.js) and
// show it in a native window so you do not need a browser tab.

const { app, BrowserWindow, Menu, session, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn } = require("child_process");

const PORT = Number(process.env.TRIAGE_POD_PORT ?? 3418);
const SPACETIME_PORT = Number(process.env.SPACETIME_PORT ?? 3000);
const children = [];
let startedSpacetime = false;
let mainWindow = null;

function homeBin(name) {
  return path.join(os.homedir(), ".local", "bin", name);
}

function which(name) {
  const extra = [
    path.dirname(homeBin(name)),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  process.env.PATH = [...extra, process.env.PATH || ""].join(path.delimiter);
  const candidates = extra.map((dir) => path.join(dir, name));
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return name;
}

function projectRoot() {
  if (process.env.TRIAGE_POD_ROOT) return process.env.TRIAGE_POD_ROOT;
  if (!app.isPackaged) return path.join(__dirname, "..");
  const marker = path.join(process.resourcesPath, "project-root.txt");
  if (fs.existsSync(marker)) {
    const listed = fs.readFileSync(marker, "utf8").trim();
    if (listed && fs.existsSync(listed)) return listed;
  }
  const fromDist = path.resolve(process.resourcesPath, "..", "..", "..", "..", "..");
  if (fs.existsSync(path.join(fromDist, "package.json"))) return fromDist;
  return path.join(os.homedir(), "code", "triage-pod");
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await portOpen(port)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`nothing answered on ${port}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function spawnLogged(bin, args, opts) {
  const child = spawn(bin, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const tag = opts.tag;
  child.stdout.on("data", (buf) => process.stdout.write(`[${tag}] ${buf}`));
  child.stderr.on("data", (buf) => process.stderr.write(`[${tag}] ${buf}`));
  child.on("exit", (code) => {
    const i = children.indexOf(child);
    if (i >= 0) children.splice(i, 1);
    if (code && code !== 0) process.stderr.write(`[${tag}] exited ${code}\n`);
  });
  return child;
}

async function ensureSpacetime(root) {
  if (await portOpen(SPACETIME_PORT)) return;
  const spacetime = which("spacetime");
  startedSpacetime = true;
  spawnLogged(spacetime, ["start"], { cwd: path.join(root, "spacetime"), tag: "spacetime" });
  try {
    await waitForPort(SPACETIME_PORT, 20000);
  } catch {
    startedSpacetime = false;
  }
}

async function ensureNext(root) {
  if (await portOpen(PORT)) return;
  const node = which("node");
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  if (!fs.existsSync(nextBin)) {
    throw new Error(`Next.js is not installed in ${root}. Run npm install there.`);
  }
  const prodDir = path.join(root, ".next-prod");
  const devDir = path.join(root, ".next");
  const env = { PORT: String(PORT) };
  let args;
  if (fs.existsSync(path.join(prodDir, "BUILD_ID"))) {
    env.NEXT_DIST = ".next-prod";
    args = [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"];
  } else if (fs.existsSync(path.join(devDir, "BUILD_ID"))) {
    args = [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"];
  } else {
    args = [nextBin, "dev", "-p", String(PORT), "-H", "127.0.0.1"];
  }
  spawnLogged(node, args, { cwd: root, env, tag: "next" });
  await waitForPort(PORT, 120000);
}

function loadingHtml(message) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>Triage Pod</title>
<style>
  html,body{margin:0;height:100%;background:#060b14;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center}
  .box{text-align:center;max-width:28rem}
  p{opacity:.7;line-height:1.5}
  .pulse{width:10px;height:10px;border-radius:50%;background:#38bdf8;margin:0 auto 1.25rem;animation:p 1s ease-in-out infinite}
  @keyframes p{50%{opacity:.25;transform:scale(.7)}}
</style></head><body><div class="box"><div class="pulse"></div>
<h1 style="font-weight:600;letter-spacing:.02em">Triage Pod</h1>
<p>${message}</p></div></body></html>`)}`;
}

function allowMedia() {
  const allowed = new Set(["media", "mediaKeySystem", "notifications", "bluetooth"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  session.defaultSession.setDevicePermissionHandler?.((details) => details.deviceType === "bluetooth");
}

function openWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: "Triage Pod",
    backgroundColor: "#060b14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function go(pathname) {
  if (!mainWindow) return;
  mainWindow.loadURL(`http://127.0.0.1:${PORT}${pathname}`);
}

function buildMenu() {
  const screens = [
    { label: "Home", path: "/" },
    { label: "Patient pod", path: "/kiosk?village=Katete" },
    { label: "Health worker", path: "/staff" },
    { label: "Live map", path: "/globe" },
    { label: "Routes", path: "/routes" },
    { label: "Government", path: "/government" },
    { label: "Patients", path: "/patients" },
    { label: "Community", path: "/community" },
    { label: "Crisis", path: "/crisis" },
    { label: "Demo script", path: "/demo" },
    { label: "Mosquito listener", path: "/mosquito" },
  ];
  const template = [
    { role: "appMenu" },
    {
      label: "Screens",
      submenu: screens.map((s) => ({ label: s.label, click: () => go(s.path) })),
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function stopChildren() {
  for (const child of [...children]) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
}

app.commandLine.appendSwitch("enable-webgl");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.name = "Triage Pod";

app.whenReady().then(async () => {
  allowMedia();
  buildMenu();
  const root = projectRoot();
  const win = openWindow();
  await win.loadURL(loadingHtml("Starting the local pod&hellip;"));

  try {
    if (!fs.existsSync(path.join(root, "package.json"))) {
      throw new Error(`Could not find the project at ${root}`);
    }
    await win.loadURL(loadingHtml("Checking SpacetimeDB&hellip;"));
    await ensureSpacetime(root);
    await win.loadURL(loadingHtml("Starting the pod server&hellip;"));
    await ensureNext(root);
    go("/");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox("Triage Pod could not start", message);
    await win.loadURL(loadingHtml(message));
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  stopChildren();
});

app.on("will-quit", () => {
  if (startedSpacetime) {
    // spacetime start is the only process we spawned for the database; SIGTERM above already sent.
  }
});
