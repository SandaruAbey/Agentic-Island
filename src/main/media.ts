import type { MediaState } from '@shared/types'
import { winHelper } from './winhelper'

/**
 * Now-playing info + controls via Windows' system media controls (GlobalSystemMediaTransportControls).
 * Works for any app that shows in the Windows media flyout: YouTube in Chrome/Edge/Firefox, Spotify, Media Player, VLC…
 * Runs inside the shared Windows helper: it prints JSON when something changes and takes transport commands.
 */

const APP_NAMES: [RegExp, string][] = [
  [/spotify/i, 'Spotify'],
  [/chrome/i, 'Chrome'],
  [/msedge|edge/i, 'Edge'],
  [/firefox|308046B0AF4A39CB/i, 'Firefox'],
  [/brave/i, 'Brave'],
  [/opera/i, 'Opera'],
  [/zunemusic|media ?player/i, 'Media Player'],
  [/vlc/i, 'VLC'],
  [/itunes|applemusic/i, 'Apple Music'],
  [/teams/i, 'Teams']
]

export function friendlyApp(aumid: string): string {
  for (const [re, name] of APP_NAMES) if (re.test(aumid)) return name
  return aumid.replace(/\.exe$/i, '').split(/[!_\\]/)[0] || 'Media'
}

export class MediaWatcher {
  state: MediaState | null = null
  private started = false

  constructor(private onChange: (m: MediaState | null) => void) {}

  start(): void {
    if (this.started) return
    this.started = true
    winHelper.onMedia = line => {
      let j: any
      try {
        j = JSON.parse(line)
      } catch {
        return
      }
      if (j.error) return
      if (j.none || !j.title) {
        if (this.state) {
          this.state = null
          this.onChange(null)
        }
        return
      }
      const app = String(j.app ?? '')
      // The artwork is only sent when the track changes; otherwise keep the one we have.
      const thumbnail =
        typeof j.thumbnail === 'string' && j.thumbnail.startsWith('data:image/')
          ? j.thumbnail
          : j.sameThumb && this.state && this.state.app === app && this.state.title === String(j.title).slice(0, 300)
            ? this.state.thumbnail
            : null
      this.state = {
        app,
        appName: friendlyApp(app),
        title: String(j.title).slice(0, 300),
        artist: String(j.artist ?? '').slice(0, 200),
        album: String(j.album ?? '').slice(0, 200),
        status: j.status,
        canToggle: !!j.canToggle,
        canNext: !!j.canNext,
        canPrev: !!j.canPrev,
        position: Number(j.position) || 0,
        duration: Number(j.duration) || 0,
        receivedAt: Date.now(),
        thumbnail
      }
      this.onChange(this.state)
    }
    winHelper.enable('media')
  }

  control(cmd: 'toggle' | 'next' | 'prev'): void {
    if (this.started) winHelper.mediaControl(cmd)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    winHelper.disable('media')
    if (this.state) {
      this.state = null
      this.onChange(null)
    }
  }
}
