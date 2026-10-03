// Builds build/IslaHelper.exe from native/IslaHelper.cs with the C# compiler that ships with Windows (.NET Framework 4.x).
// No SDK needed. The installer copies it next to the app (electron-builder extraResources).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const win = process.env.WINDIR || 'C:\\Windows'
const fw = join(win, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
const md = join(win, 'System32', 'WinMetadata')
const csc = join(fw, 'csc.exe')
if (!existsSync(csc)) {
  console.warn('csc.exe not found — IslaHelper.exe not built; Isla will fall back to PowerShell.')
  process.exit(0)
}

// Stop any running instances so csc.exe can write to build\IslaHelper.exe
try {
  execFileSync('taskkill', ['/F', '/IM', 'IslaHelper.exe', '/T'], { stdio: 'ignore' })
} catch {}

mkdirSync('build', { recursive: true })
const refs = [
  join(fw, 'System.Runtime.dll'),
  join(fw, 'System.Runtime.WindowsRuntime.dll'),
  join(fw, 'System.Management.dll'),
  ...['Windows.Foundation', 'Windows.Media', 'Windows.Storage', 'Windows.Graphics', 'Windows.Globalization', 'Windows.Devices'].map(n => join(md, `${n}.winmd`))
]
execFileSync(csc, ['-nologo', '-optimize+', '-target:winexe', '-platform:x64', '-out:build\\IslaHelper.exe', ...refs.map(r => `-r:${r}`), 'native\\IslaHelper.cs'], {
  stdio: 'inherit'
})
console.log('build/IslaHelper.exe built')
