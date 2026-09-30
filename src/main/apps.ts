import { execFile } from 'node:child_process'
import type { InstalledApp } from '@shared/types'

/**
 * Scans installed applications on the PC via the Windows registry and running processes.
 * Returns a deduplicated list of apps with their process names and install paths.
 */
const SCAN_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$apps = @()
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($p in $paths) {
  Get-ItemProperty $p |
    Where-Object { $_.DisplayName -and $_.DisplayName -ne '' } |
    ForEach-Object {
      $exe = ''
      if ($_.InstallLocation) { $exe = $_.InstallLocation }
      elseif ($_.DisplayIcon) { $exe = $_.DisplayIcon -replace ',.*$','' }
      $apps += [pscustomobject]@{ n=$_.DisplayName; e=$exe }
    }
}
# Also add currently running GUI processes for completeness
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
  $apps += [pscustomobject]@{ n=$_.ProcessName; e=[string]$_.Path }
}
$apps | Select-Object -Property n,e -Unique | ConvertTo-Json -Compress
`

/** Well-known processes that map to readable app names. */
const KNOWN_APPS: Record<string, string> = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Mozilla Firefox',
  brave: 'Brave Browser',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  code: 'Visual Studio Code',
  'code - insiders': 'VS Code Insiders',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  antigravity: 'Antigravity',
  kiro: 'Kiro',
  outlook: 'Microsoft Outlook',
  olk: 'Outlook (New)',
  teams: 'Microsoft Teams',
  'ms-teams': 'Microsoft Teams',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  signal: 'Signal',
  zoom: 'Zoom',
  spotify: 'Spotify',
  windowsterminal: 'Windows Terminal',
  powershell: 'PowerShell',
  cmd: 'Command Prompt',
  winword: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpnt: 'Microsoft PowerPoint',
  onenote: 'OneNote',
  'lm studio': 'LM Studio',
  chatgpt: 'ChatGPT',
  ollama: 'Ollama'
}

export function scanInstalledApps(): Promise<InstalledApp[]> {
  return new Promise(res => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCAN_SCRIPT],
      { windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, out) => {
        if (err || !out.trim()) return res(defaultApps())
        try {
          const j = JSON.parse(out)
          const list: any[] = Array.isArray(j) ? j : [j]
          const seen = new Set<string>()
          const apps: InstalledApp[] = []
          for (const item of list) {
            const name = String(item.n || '').trim()
            if (!name || name.length < 2) continue
            // Derive a process name from the app name or exe path
            const exePath = String(item.e || '').trim()
            let proc = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
            if (exePath) {
              const m = exePath.match(/([^/\\]+)\.(exe|app)$/i)
              if (m) proc = m[1].toLowerCase()
            }
            if (seen.has(proc)) continue
            seen.add(proc)
            apps.push({ name, process: proc, path: exePath || null })
          }
          // Merge in known apps that might not have been in the registry scan
          for (const [proc, name] of Object.entries(KNOWN_APPS)) {
            if (!seen.has(proc)) apps.push({ name, process: proc, path: null })
          }
          res(apps.sort((a, b) => a.name.localeCompare(b.name)))
        } catch {
          res(defaultApps())
        }
      }
    )
  })
}

/** Fallback: return well-known apps if the registry scan fails. */
function defaultApps(): InstalledApp[] {
  return Object.entries(KNOWN_APPS).map(([process, name]) => ({ name, process, path: null }))
}
