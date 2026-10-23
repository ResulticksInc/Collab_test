const { contextBridge, ipcRenderer } = require("electron");

// Minimal bridge for the screen-share source picker window ONLY.
contextBridge.exposeInMainWorld("picker", {
  onSources(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("picker:sources", (_e, sources) => {
      try { callback(sources); } catch {}
    });
  },
  choose(id) {
    ipcRenderer.send("picker:choose", id || null);
  },
  cancel() {
    ipcRenderer.send("picker:choose", null);
  },
});
