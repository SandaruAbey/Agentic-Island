import { contextBridge, ipcRenderer } from 'electron'
import type { IslandApi, IslandEvent } from '@shared/types'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

const api: IslandApi = {
  getSnapshot: () => invoke('snapshot'),
  ask: (text, context) => invoke('ask', text, context),
  readMail: uid => invoke('mail:read', uid),
  refreshInbox: () => invoke('mail:refresh'),
  onEvent: cb => {
    const listener = (_e: unknown, ev: IslandEvent) => cb(ev)
    ipcRenderer.on('island:event', listener)
    return () => ipcRenderer.removeListener('island:event', listener)
  },
  setInteractive: v => ipcRenderer.send('set-interactive', v === true),
  dragStart: (w, h, ox, oy) => ipcRenderer.send('dock:drag-start', { w, h, ox, oy }),
  dragEnd: () => ipcRenderer.send('dock:drag-end'),
  setHidden: hidden => ipcRenderer.send('dock:hidden', hidden === true),
  setPeekActive: active => invoke('dock:peek-active', active === true),
  mediaControl: cmd => ipcRenderer.send('media:control', cmd),
  updateSettings: patch => invoke('settings:update', patch),
  setMailPassword: pw => invoke('mail:set-password', pw),
  clearMailPassword: () => invoke('mail:clear-password'),
  testMail: () => invoke('mail:test'),
  googleSignIn: () => invoke('google:signin'),
  googleSignOut: () => invoke('google:signout'),
  openUrl: url => invoke('open-url', url),
  pasteToApp: text => invoke('paste-to-app', text),
  addWorkspace: () => invoke('workspace:add'),
  removeWorkspace: p => invoke('workspace:remove', p),
  setActiveWorkspace: p => invoke('workspace:set-active', p),
  refreshProviders: () => invoke('providers:refresh'),
  requestRun: req => invoke('run:request', req),
  approveRun: id => invoke('run:approve', id),
  rejectRun: id => invoke('run:reject', id),
  cancelRun: id => invoke('run:cancel', id),
  clearRuns: () => invoke('run:clear'),
  createTask: input => invoke('scheduler:create', input),
  updateTask: (id, patch) => invoke('scheduler:update', id, patch),
  deleteTask: id => invoke('scheduler:delete', id),
  runTaskNow: id => invoke('scheduler:run-now', id),
  toggleTask: (id, enabled) => invoke('scheduler:toggle', id, enabled),
  openInAntigravity: prompt => invoke('antigravity:open', prompt),
  gitAction: op => invoke('git:op', op),
  commit: (message, push, diffHash, allowSecrets) => invoke('git:commit', message, push, diffHash, allowSecrets === true),
  reviewChanges: () => invoke('git:review'),
  doSuggestion: id => invoke('suggestion:do', id),
  copyText: text => invoke('clipboard:write', text),
  copyOtp: id => invoke('otp:copy', id),
  dismissOtp: id => invoke('otp:dismiss', id),
  dismissSuggestion: id => invoke('suggestion:dismiss', id),
  predictNext: () => invoke('predict'),
  getUsage: () => invoke('usage'),
  getProcesses: () => invoke('processes'),
  getAudit: () => invoke('audit'),
  killSwitch: () => invoke('security:kill'),
  resume: () => invoke('security:resume'),
  shutdown: () => invoke('security:shutdown'),
  scanInstalledApps: () => invoke('apps:scan'),
  setAppPermission: (process: string, name: string, allowed: boolean) => invoke('apps:set-permission', process, name, allowed)
}

contextBridge.exposeInMainWorld('island', api)
