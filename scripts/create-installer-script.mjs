import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const installerBat = `@echo off
title Installing Agentic Island...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $target = (Get-Item '%~dp0win-unpacked\\Agentic Island.exe').FullName; if (-not (Test-Path $target)) { $target = (Get-Item '%~dp0Agentic Island.exe').FullName }; $desktop = [System.Environment]::GetFolderPath('Desktop'); $startMenu = [System.Environment]::GetFolderPath('StartMenu') + '\\Programs'; $s1 = $ws.CreateShortcut($desktop + '\\Agentic Island.lnk'); $s1.TargetPath = $target; $s1.IconLocation = $target + ',0'; $s1.Save(); $s2 = $ws.CreateShortcut($startMenu + '\\Agentic Island.lnk'); $s2.TargetPath = $target; $s2.IconLocation = $target + ',0'; $s2.Save(); Write-Host 'Agentic Island installed successfully! Shortcuts created on Desktop and Start Menu.' -ForegroundColor Green; Start-Process $target"
echo Done!
pause
`

writeFileSync('release/Install-Agentic-Island.bat', installerBat, 'utf8')
writeFileSync('release/win-unpacked/Install-Agentic-Island.bat', installerBat, 'utf8')
console.log('Created Install-Agentic-Island.bat in release/ and release/win-unpacked/')
