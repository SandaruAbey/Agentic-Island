import { contextBridge, ipcRenderer } from 'electron'

/** Minimal bridge for the hidden meeting recorder: receive start/stop, hand back audio/video chunks. */
contextBridge.exposeInMainWorld('recorder', {
  onStart: (cb: (o: { screens: number; video: boolean; systemAudio: boolean; mic: boolean }) => void) => ipcRenderer.on('rec:start', (_e, o) => cb(o)),
  onStop: (cb: () => void) => ipcRenderer.on('rec:stop', () => cb()),
  chunk: (kind: 'pcm' | 'video', data: Uint8Array) => ipcRenderer.send('rec:chunk', kind, data),
  format: (ext: 'mp4' | 'webm') => ipcRenderer.send('rec:format', ext),
  stopped: () => ipcRenderer.send('rec:stopped'),
  error: (msg: string) => ipcRenderer.send('rec:error', msg)
})
