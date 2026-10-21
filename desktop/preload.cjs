const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  if (typeof callback !== "function")
    throw new TypeError("A callback is required");
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld(
  "branchDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    version: "1.5.1",
    windowAction: (action) => ipcRenderer.invoke("desktop:window", action),
    getWindowState: () => ipcRenderer.invoke("desktop:state"),
    onWindowState: (callback) => subscribe("desktop:window-state", callback),
    saveFile: (options) => ipcRenderer.invoke("desktop:save-file", options),
    openFile: () => ipcRenderer.invoke("desktop:open-file"),
    importMaterials: () => ipcRenderer.invoke("desktop:import-materials"),
    openDataDirectory: () => ipcRenderer.invoke("desktop:open-data-directory"),
    chooseDataDirectory: () => ipcRenderer.invoke("desktop:choose-data-directory"),
    chooseAgentDirectory: () => ipcRenderer.invoke("desktop:choose-agent-directory"),
    openAgentDirectory: () => ipcRenderer.invoke("desktop:open-agent-directory"),
    applyDataDirectory: (options) => ipcRenderer.invoke("desktop:apply-data-directory", options),
    copyText: (text) => ipcRenderer.invoke("desktop:copy-text", text),
    onCommand: (callback) => subscribe("desktop:command", callback),
    onCloseRequested: (callback) => subscribe("desktop:before-close", callback),
    closeReady: (saved) =>
      ipcRenderer.invoke("desktop:close-ready", saved === true),
    appReady: () => ipcRenderer.send("desktop:application-ready"),
  }),
);

window.addEventListener(
  "DOMContentLoaded",
  () => ipcRenderer.send("desktop:renderer-ready"),
  { once: true },
);
