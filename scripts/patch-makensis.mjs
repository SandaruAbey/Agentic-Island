import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const localAppData = process.env.LOCALAPPDATA || ''
const paths = [
  join(localAppData, 'electron-builder', 'Cache', 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'Bin', 'makensis.exe'),
  join(localAppData, 'electron-builder', 'Cache', 'nsis-3.0.4.1', 'nsis-3.0.4.1-1mx3n', 'makensis.exe')
]

for (const p of paths) {
  if (existsSync(p)) {
    const buf = readFileSync(p)
    const peOffset = buf.readInt32LE(0x3c)
    const charOffset = peOffset + 22
    const characteristics = buf.readUInt16LE(charOffset)
    console.log(`Checking ${p}: characteristics=0x${characteristics.toString(16)}`)
    if ((characteristics & 0x0020) === 0) {
      buf.writeUInt16LE(characteristics | 0x0020, charOffset)
      writeFileSync(p, buf)
      console.log(`Enabled LARGEADDRESSAWARE on ${p} (now 0x${(characteristics | 0x0020).toString(16)})`)
    } else {
      console.log(`Already LARGEADDRESSAWARE: ${p}`)
    }
  }
}
