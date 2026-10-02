import { closeSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'

/**
 * MediaRecorder writes a *fragmented* MP4 (moof/mdat pieces, no sample index), which players can't seek in and
 * show with a wrong length. This rewrites it into a normal MP4 (moov with full sample tables + one mdat) without
 * re-encoding — the video and audio data are copied byte for byte.
 */

interface Box {
  type: string
  start: number
  size: number
  header: number
}

interface Sample {
  dur: number
  size: number
  flags: number
  cto: number
}
interface Run {
  track: number
  offset: number // where the data sits in the source file
  samples: Sample[]
}
interface Trex {
  dur: number
  size: number
  flags: number
}
interface Node {
  type: string
  data?: Buffer
  kids?: Node[]
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, b, got, len - got, pos + got)
    if (n <= 0) break
    got += n
  }
  return got === len ? b : b.subarray(0, got)
}

function boxesIn(buf: Buffer, from = 0, to = buf.length): Box[] {
  const out: Box[] = []
  let p = from
  while (p + 8 <= to) {
    let size = buf.readUInt32BE(p)
    let header = 8
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(p + 8))
      header = 16
    } else if (size === 0) size = to - p
    if (size < header || p + size > to) break
    out.push({ type: buf.toString('latin1', p + 4, p + 8), start: p, size, header })
    p += size
  }
  return out
}

function parseNode(buf: Buffer, b: Box): Node {
  const body = buf.subarray(b.start + b.header, b.start + b.size)
  if (!CONTAINERS.has(b.type)) return { type: b.type, data: body }
  return { type: b.type, kids: boxesIn(body).map(k => parseNode(body, k)) }
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const make = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts)
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body])
}
const full = (type: string, version: number, flags: number, ...parts: Buffer[]) => make(type, Buffer.from([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts)

function serialize(n: Node): Buffer {
  return n.kids ? make(n.type, ...n.kids.map(serialize)) : make(n.type, n.data ?? Buffer.alloc(0))
}
const kid = (n: Node, type: string) => n.kids?.find(k => k.type === type)

export function remuxFragmentedMp4(file: string): boolean {
  const out = file + '.fixed'
  const fd = openSync(file, 'r')
  const total = statSync(file).size
  let ofd = -1
  try {
    // ---- top level: ftyp, moov, then moof+mdat pairs (only box headers are read)
    let ftyp: Buffer | null = null
    let moovBuf: Buffer | null = null
    const runs: Run[] = []
    const trex = new Map<number, Trex>()
    let pos = 0
    while (pos + 8 <= total) {
      const head = readAt(fd, pos, 16)
      let size = head.readUInt32BE(0)
      const type = head.toString('latin1', 4, 8)
      let header = 8
      if (size === 1) {
        size = Number(head.readBigUInt64BE(8))
        header = 16
      } else if (size === 0) size = total - pos
      if (size < header) break
      if (pos + size > total) size = total - pos // a cut-off last box
      if (type === 'ftyp') ftyp = readAt(fd, pos, size)
      else if (type === 'moov') moovBuf = readAt(fd, pos, size)
      else if (type === 'moof') {
        const moof = readAt(fd, pos, size)
        for (const traf of boxesIn(moof, 8).filter(b => b.type === 'traf')) {
          let track = 0
          let defDur = 0
          let defSize = 0
          let defFlags = 0
          let baseOffset = pos
          for (const c of boxesIn(moof, traf.start + traf.header, traf.start + traf.size)) {
            const o = c.start + c.header
            if (c.type === 'tfhd') {
              const fl = moof.readUIntBE(o + 1, 3)
              track = moof.readUInt32BE(o + 4)
              let q = o + 8
              if (fl & 1) {
                baseOffset = Number(moof.readBigUInt64BE(q))
                q += 8
              }
              if (fl & 2) q += 4
              const t = trex.get(track)
              defDur = fl & 8 ? moof.readUInt32BE(q) : t?.dur ?? 0
              if (fl & 8) q += 4
              defSize = fl & 0x10 ? moof.readUInt32BE(q) : t?.size ?? 0
              if (fl & 0x10) q += 4
              defFlags = fl & 0x20 ? moof.readUInt32BE(q) : t?.flags ?? 0
            } else if (c.type === 'trun') {
              const version = moof[o]
              const fl = moof.readUIntBE(o + 1, 3)
              const count = moof.readUInt32BE(o + 4)
              let q = o + 8
              let dataOffset = 0
              if (fl & 1) {
                dataOffset = moof.readInt32BE(q)
                q += 4
              }
              let first = defFlags
              if (fl & 4) {
                first = moof.readUInt32BE(q)
                q += 4
              }
              const samples: Sample[] = []
              for (let i = 0; i < count; i++) {
                const s: Sample = { dur: defDur, size: defSize, flags: i === 0 && fl & 4 ? first : defFlags, cto: 0 }
                if (fl & 0x100) { s.dur = moof.readUInt32BE(q); q += 4 }
                if (fl & 0x200) { s.size = moof.readUInt32BE(q); q += 4 }
                if (fl & 0x400) { s.flags = moof.readUInt32BE(q); q += 4 }
                if (fl & 0x800) { s.cto = version ? moof.readInt32BE(q) : moof.readUInt32BE(q); q += 4 }
                samples.push(s)
              }
              runs.push({ track, offset: baseOffset + dataOffset, samples })
            }
          }
        }
      }
      pos += size
      if (type === 'moov' && moovBuf) {
        const m = parseNode(moovBuf, { type: 'moov', start: 0, size: moovBuf.length, header: 8 })
        const mvex = kid(m, 'mvex')
        // mvex isn't a container in CONTAINERS — read trex boxes straight from its body
        if (mvex?.data) {
          for (const b of boxesIn(mvex.data)) {
            if (b.type !== 'trex') continue
            const o = b.start + 8
            trex.set(mvex.data.readUInt32BE(o + 4), { dur: mvex.data.readUInt32BE(o + 12), size: mvex.data.readUInt32BE(o + 16), flags: mvex.data.readUInt32BE(o + 20) })
          }
        }
      }
    }
    if (!ftyp || !moovBuf || !runs.length) return false

    // ---- sample tables per track
    const moov = parseNode(moovBuf, { type: 'moov', start: 0, size: moovBuf.length, header: 8 })
    const traks = moov.kids!.filter(k => k.type === 'trak')
    const idOf = (t: Node) => {
      const d = kid(t, 'tkhd')!.data!
      return d.readUInt32BE(d[0] === 1 ? 20 : 12)
    }
    // Lay out the new mdat: runs in file order. Chunk offsets are relative to the start of the mdat payload.
    let rel = 0
    const chunkRel = runs.map(r => {
      const at = rel
      rel += r.samples.reduce((a, s) => a + s.size, 0)
      return at
    })
    const mdatPayload = rel

    const mvhd = kid(moov, 'mvhd')!.data!
    const movieScale = mvhd.readUInt32BE(mvhd[0] === 1 ? 20 : 12)
    let movieDur = 0

    const build = (mdatStart: number): Buffer => {
      movieDur = 0
      const newTraks: Node[] = []
      for (const t of traks) {
        const id = idOf(t)
        const mine = runs.map((r, i) => ({ r, i })).filter(x => x.r.track === id)
        const mdia = kid(t, 'mdia')!
        const mdhd = kid(mdia, 'mdhd')!.data!
        const v1 = mdhd[0] === 1
        const scale = mdhd.readUInt32BE(v1 ? 20 : 12)
        const handler = kid(mdia, 'hdlr')!.data!.toString('latin1', 8, 12)
        const stbl = kid(kid(mdia, 'minf')!, 'stbl')!
        const stsd = kid(stbl, 'stsd')!
        const all = mine.flatMap(x => x.r.samples)
        const dur = all.reduce((a, s) => a + s.dur, 0)

        // stts (run-length)
        const stts: [number, number][] = []
        for (const s of all) {
          const last = stts[stts.length - 1]
          if (last && last[1] === s.dur) last[0]++
          else stts.push([1, s.dur])
        }
        // stsc: one chunk per run
        const stsc: [number, number][] = []
        mine.forEach((x, idx) => {
          const n = x.r.samples.length
          const last = stsc[stsc.length - 1]
          if (!last || last[1] !== n) stsc.push([idx + 1, n])
        })
        const offsets = mine.map(x => mdatStart + chunkRel[x.i])
        const stblKids: Buffer[] = [
          serialize(stsd),
          full('stts', 0, 0, u32(stts.length), ...stts.map(([c, d]) => Buffer.concat([u32(c), u32(d)]))),
          full('stsc', 0, 0, u32(stsc.length), ...stsc.map(([f, n]) => Buffer.concat([u32(f), u32(n), u32(1)]))),
          full('stsz', 0, 0, u32(0), u32(all.length), ...all.map(s => u32(s.size))),
          full('stco', 0, 0, u32(offsets.length), ...offsets.map(o => u32(o)))
        ]
        if (handler === 'vide') {
          const NON_SYNC = 0x10000
          const sync = all.map((s, i) => (s.flags & NON_SYNC ? 0 : i + 1)).filter(Boolean)
          if (sync.length && sync.length < all.length) stblKids.push(full('stss', 0, 0, u32(sync.length), ...sync.map(u32)))
          if (all.some(s => s.cto)) {
            const neg = all.some(s => s.cto < 0)
            const ctts: [number, number][] = []
            for (const s of all) {
              const last = ctts[ctts.length - 1]
              if (last && last[1] === s.cto) last[0]++
              else ctts.push([1, s.cto])
            }
            stblKids.push(
              full('ctts', neg ? 1 : 0, 0, u32(ctts.length), ...ctts.map(([c, o]) => Buffer.concat([u32(c), neg ? Buffer.from(new Int32Array([o]).buffer).reverse() : u32(o)])))
            )
          }
        }
        // patch durations in mdhd / tkhd, rebuild the tree without edit lists
        const mdhdNew = Buffer.from(mdhd)
        if (v1) mdhdNew.writeBigUInt64BE(BigInt(dur), 24)
        else mdhdNew.writeUInt32BE(dur, 16)
        const tkDur = Math.round((dur / scale) * movieScale)
        movieDur = Math.max(movieDur, tkDur)
        const tkhd = Buffer.from(kid(t, 'tkhd')!.data!)
        if (tkhd[0] === 1) tkhd.writeBigUInt64BE(BigInt(tkDur), 28)
        else tkhd.writeUInt32BE(tkDur, 20)
        const stblNode: Node = { type: 'stbl', data: Buffer.concat(stblKids) }
        const minf = kid(mdia, 'minf')!
        const minfKids = minf.kids!.map(k => (k.type === 'stbl' ? stblNode : k))
        const mdiaKids = mdia.kids!.map(k => (k.type === 'mdhd' ? { type: 'mdhd', data: mdhdNew } : k.type === 'minf' ? { type: 'minf', kids: minfKids } : k))
        newTraks.push({ type: 'trak', kids: t.kids!.filter(k => k.type !== 'edts').map(k => (k.type === 'tkhd' ? { type: 'tkhd', data: tkhd } : k.type === 'mdia' ? { type: 'mdia', kids: mdiaKids } : k)) })
      }
      const mvhdNew = Buffer.from(mvhd)
      if (mvhd[0] === 1) mvhdNew.writeBigUInt64BE(BigInt(movieDur), 24)
      else mvhdNew.writeUInt32BE(movieDur, 16)
      const kids: Node[] = [{ type: 'mvhd', data: mvhdNew }, ...newTraks]
      // `stbl` nodes above carry pre-serialized children as raw data, which serialize() wraps correctly.
      return serialize({ type: 'moov', kids })
    }

    // moov goes before mdat (fast start); its size doesn't depend on the offsets, so build twice.
    const ftypOut = ftyp
    const size1 = build(0).length
    const mdatHeader = mdatPayload + 8 > 0xffffffff ? 16 : 8
    const mdatStart = ftypOut.length + size1 + mdatHeader
    if (mdatStart + mdatPayload > 0xffffffff) return false // >4 GB: leave the original alone
    const moovOut = build(mdatStart)

    ofd = openSync(out, 'w')
    let w = 0
    const put = (b: Buffer) => {
      writeSync(ofd, b, 0, b.length, w)
      w += b.length
    }
    put(ftypOut)
    put(moovOut)
    put(Buffer.concat([u32(mdatPayload + 8), Buffer.from('mdat', 'latin1')]))
    for (const r of runs) {
      let left = r.samples.reduce((a, s) => a + s.size, 0)
      let at = r.offset
      while (left > 0) {
        const chunk = readAt(fd, at, Math.min(left, 1 << 20))
        if (!chunk.length) throw new Error('source ended early')
        put(chunk)
        at += chunk.length
        left -= chunk.length
      }
    }
    closeSync(ofd)
    ofd = -1
    closeSync(fd)
    renameSync(out, file)
    return true
  } catch (e) {
    console.error('remux failed', e)
    return false
  } finally {
    try { closeSync(fd) } catch {}
    if (ofd >= 0) try { closeSync(ofd) } catch {}
    try { rmSync(out, { force: true }) } catch {}
  }
}
