// SPIKE ONLY. Sandboxed preload: a small API, and each MessagePort handed on to the page.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('spike', {
  runs: () => ipcRenderer.invoke('spike:runs'),
  resume: (runId) => ipcRenderer.invoke('spike:resume', runId),
  start: () => ipcRenderer.invoke('spike:start'),
  attach: (termId) => ipcRenderer.send('spike:attach', termId),
  onRuns: (fn) => ipcRenderer.on('spike:runs', (_e, runs) => fn(runs)),
})
ipcRenderer.on('spike:port', (e, msg) => window.postMessage({ type: 'spike:port', id: msg.id }, '*', e.ports))
