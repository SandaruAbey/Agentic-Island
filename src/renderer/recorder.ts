// Hidden recorder. Captures what the user picked:
//  • one or more screens (several are combined side by side into one video),
//  • computer sound (what you hear — other people in a call, videos…) via Windows loopback,
//  • your microphone.
// Sound goes to a 16 kHz mono PCM stream for transcription; picture + sound are recorded as MP4 (WebM fallback).

interface StartOptions {
  /** How many screens to ask the main process for (it hands them out one per getDisplayMedia call). */
  screens: number
  video: boolean
  systemAudio: boolean
  mic: boolean
}
interface RecorderBridge {
  onStart(cb: (o: StartOptions) => void): void
  onStop(cb: () => void): void
  chunk(kind: 'pcm' | 'video', data: Uint8Array): void
  format(ext: 'mp4' | 'webm'): void
  stopped(): void
  error(msg: string): void
}
const rec = (window as unknown as { recorder: RecorderBridge }).recorder

let ctx: AudioContext | null = null
let videoCtx: AudioContext | null = null
let proc: ScriptProcessorNode | null = null
let videoRec: MediaRecorder | null = null
let drawTimer = 0
let streams: MediaStream[] = []
/** Chunks still being converted/sent — wait for all of them before saying "stopped". */
const inFlight = new Set<Promise<void>>()
const send = (blob: Blob) => {
  const p = blob.arrayBuffer().then(b => rec.chunk('video', new Uint8Array(b)))
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}

/** Several screens → one canvas, side by side (scaled to stay within what the H.264 encoder handles). */
async function combine(tracks: MediaStreamTrack[]): Promise<MediaStreamTrack> {
  const videos = await Promise.all(
    tracks.map(async t => {
      const v = document.createElement('video')
      v.muted = true
      v.srcObject = new MediaStream([t])
      await v.play()
      return v
    })
  )
  const sumW = videos.reduce((s, v) => s + v.videoWidth, 0)
  const maxH = Math.max(...videos.map(v => v.videoHeight))
  const scale = Math.min(1, 3840 / sumW, 1440 / maxH)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round((sumW * scale) / 2) * 2
  canvas.height = Math.round((maxH * scale) / 2) * 2
  const g = canvas.getContext('2d')!
  // setInterval, not requestAnimationFrame: this window is hidden, so rAF would not run.
  drawTimer = window.setInterval(() => {
    g.fillStyle = '#000'
    g.fillRect(0, 0, canvas.width, canvas.height)
    let x = 0
    for (const v of videos) {
      const w = v.videoWidth * scale
      const h = v.videoHeight * scale
      g.drawImage(v, x, (canvas.height - h) / 2, w, h)
      x += w
    }
  }, 1000 / 30)
  return canvas.captureStream(30).getVideoTracks()[0]
}

rec.onStart(async o => {
  try {
    // 1) Screens. The main process answers each getDisplayMedia call with the next chosen screen;
    //    only the first one carries the computer sound.
    const displays: MediaStream[] = []
    for (let i = 0; i < o.screens; i++) {
      const d = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: i === 0 && o.systemAudio })
      displays.push(d)
      streams.push(d)
    }
    const systemTracks = displays.flatMap(d => d.getAudioTracks())
    if (o.systemAudio && !systemTracks.length) rec.error('Computer sound could not be captured — recording without it.')

    // 2) Microphone.
    let mic: MediaStream | null = null
    if (o.mic) {
      try {
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        streams.push(mic)
      } catch {
        rec.error('Microphone unavailable — recording without your voice.')
      }
    }
    const audioSources: MediaStream[] = [...(systemTracks.length ? [new MediaStream(systemTracks)] : []), ...(mic ? [mic] : [])]

    // 3) 16 kHz PCM for the transcript (the AudioContext resamples for us).
    ctx = new AudioContext({ sampleRate: 16_000 })
    const sum = ctx.createGain()
    for (const s of audioSources) ctx.createMediaStreamSource(s).connect(sum)
    proc = ctx.createScriptProcessor(4096, 1, 1)
    proc.onaudioprocess = e => {
      const f = e.inputBuffer.getChannelData(0)
      const out = new Int16Array(f.length)
      for (let i = 0; i < f.length; i++) {
        const v = Math.max(-1, Math.min(1, f[i]))
        out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
      }
      rec.chunk('pcm', new Uint8Array(out.buffer))
    }
    sum.connect(proc)
    // ScriptProcessor only runs when connected to the output; a muted gain keeps it silent.
    const mute = ctx.createGain()
    mute.gain.value = 0
    proc.connect(mute)
    mute.connect(ctx.destination)

    // 4) Video (+ its own 48 kHz sound mix — the MP4/AAC encoder refuses 16 kHz).
    const videoTracks = displays.flatMap(d => d.getVideoTracks())
    if (o.video && videoTracks.length) {
      const picture = videoTracks.length > 1 ? await combine(videoTracks) : videoTracks[0]
      videoCtx = new AudioContext({ sampleRate: 48_000 })
      const vmix = videoCtx.createMediaStreamDestination()
      for (const s of audioSources) videoCtx.createMediaStreamSource(s).connect(vmix)
      const tracks = [picture, ...(audioSources.length ? vmix.stream.getAudioTracks() : [])]
      const big = videoTracks.length > 1
      // MP4 (H.264 + AAC) plays everywhere on Windows; WebM only as a fallback.
      const type = [
        ...(big ? ['video/mp4;codecs=avc1.640033,mp4a.40.2'] : []),
        'video/mp4;codecs=avc1.640028,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm'
      ].find(t => MediaRecorder.isTypeSupported(t))
      rec.format(type?.startsWith('video/mp4') ? 'mp4' : 'webm')
      videoRec = new MediaRecorder(new MediaStream(tracks), {
        mimeType: type,
        videoBitsPerSecond: big ? 5_000_000 : 2_500_000,
        audioBitsPerSecond: 128_000
      })
      videoRec.ondataavailable = ev => {
        if (ev.data.size) send(ev.data)
      }
      videoRec.onerror = ev => rec.error(`Video recording failed: ${(ev as unknown as { error?: Error }).error?.message ?? 'encoder error'}`)
      videoRec.start(2000)
    } else {
      // Sound only: the screen capture was just the way to get computer sound.
      for (const t of videoTracks) t.stop()
    }
  } catch (e) {
    rec.error(`Could not start recording: ${(e as Error).message}`)
  }
})

rec.onStop(async () => {
  try {
    if (videoRec && videoRec.state !== 'inactive') {
      await new Promise<void>(res => {
        videoRec!.onstop = () => res()
        videoRec!.stop()
      })
      // The final dataavailable fires before onstop; wait until every chunk has reached the main process.
      await Promise.all([...inFlight])
    }
    window.clearInterval(drawTimer)
    proc?.disconnect()
    for (const s of streams) for (const t of s.getTracks()) t.stop()
    await ctx?.close()
    await videoCtx?.close()
  } finally {
    streams = []
    videoCtx = null
    videoRec = null
    rec.stopped()
  }
})
