import type { AudioDevice, IslandEvent } from '@shared/types'
import { winHelper } from './winhelper'

const LOW_BATTERY = 15
/** Earbuds/headphones that Windows doesn't flag as audio (e.g. some LE-only buds). */
const AUDIO_NAME = /(bud|pod|head ?(set|phone)|ear|airpod|galaxy buds|wh-|wf-|jabra|soundcore|beats|bose|sony|jbl|anc)/i

/**
 * Connected Bluetooth earbuds/headphones and their battery (polled by the shared Windows helper).
 * Peeks once when a device connects and once when its battery runs low — like the iPhone island.
 */
export class BluetoothWatcher {
  devices: AudioDevice[] = []
  private started = false
  private warned = new Set<string>()

  constructor(
    private onChange: () => void,
    private notify: (e: Extract<IslandEvent, { type: 'notify' }>) => void
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    winHelper.onBluetooth = line => this.update(line)
    winHelper.enable('bt')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    winHelper.disable('bt')
    this.devices = []
    this.warned.clear()
    this.onChange()
  }

  private update(line: string): void {
    let list: { name?: unknown; battery?: unknown; audio?: unknown }[]
    try {
      const j = JSON.parse(line)
      list = Array.isArray(j) ? j : j ? [j] : []
    } catch {
      return
    }
    const next: AudioDevice[] = list
      .filter(d => d.audio === true || AUDIO_NAME.test(String(d.name ?? '')))
      .map(d => {
        const b = Number(d.battery)
        return { name: String(d.name ?? 'Headphones').slice(0, 60), battery: d.battery === null || !Number.isFinite(b) ? null : Math.max(0, Math.min(100, Math.round(b))) }
      })
    const before = new Map(this.devices.map(d => [d.name, d]))
    for (const d of next) {
      const pct = d.battery === null ? '' : ` · ${d.battery}% battery`
      if (!before.has(d.name)) this.notify({ type: 'notify', kind: 'device', title: `${d.name} connected`, body: `Connected${pct}` })
      if (d.battery !== null && d.battery <= LOW_BATTERY && !this.warned.has(d.name)) {
        this.warned.add(d.name)
        this.notify({ type: 'notify', kind: 'device', title: `${d.name} battery low`, body: `${d.battery}% left — charge soon` })
      }
      if (d.battery !== null && d.battery > LOW_BATTERY + 10) this.warned.delete(d.name)
    }
    for (const name of before.keys()) if (!next.some(d => d.name === name)) this.warned.delete(name)
    const changed = JSON.stringify(next) !== JSON.stringify(this.devices)
    this.devices = next
    if (changed) this.onChange()
  }
}
