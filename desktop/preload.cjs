"use strict";

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("triagePod", {
  desktop: true,
});
