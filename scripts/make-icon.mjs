// Renders build/icon.png (256×256) — the Isla face on a black squircle — with no image dependencies.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

const S = 256
const SS = 4 // supersampling
const px = new Float32Array(S * S * 4)

const blobR = th => 38 * (1 + 0.06 * Math.sin(th * 2 + 0.9) + 0.03 * Math.cos(th * 3 - 0.4))
const eyes = [
  { x: 55, y: 61, w: 5.5, h: 11, r: 8 },
  { x: 68, y: 59, w: 5.5, h: 11, r: 8 }
]

function inEye(x, y, e) {
  const a = (-e.r * Math.PI) / 180
  const dx = x - e.x
  const dy = y - e.y
  const rx = dx * Math.cos(a) - dy * Math.sin(a)
  const ry = dx * Math.sin(a) + dy * Math.cos(a)
  const rad = Math.min(e.w, e.h) / 2
  const hx = e.w / 2 - rad
  const hy = e.h / 2 - rad
  const qx = Math.max(Math.abs(rx) - hx, 0)
  const qy = Math.max(Math.abs(ry) - hy, 0)
  return qx * qx + qy * qy <= rad * rad
}

function sample(u, v) {
  // u,v in 0..1. Squircle background.
  const bx = Math.abs(u - 0.5) / 0.5
  const by = Math.abs(v - 0.5) / 0.5
  if (Math.pow(bx, 5) + Math.pow(by, 5) > 1) return [0, 0, 0, 0]
  // Face space 0..100 with some padding.
  const x = 8 + u * 84
  const y = 6 + v * 84
  const dx = x - 50
  const dy = y - 54
  const th = Math.atan2(dy, dx)
  if (Math.hypot(dx, dy) <= blobR(th)) {
    if (eyes.some(e => inEye(x, y, e))) return [17, 18, 23, 255]
    const shade = Math.hypot((x - 34) / 30, (y - 80) / 18) < 1
    return shade ? [199, 205, 234, 255] : [223, 227, 246, 255]
  }
  return [12, 12, 14, 255]
}

for (let j = 0; j < S; j++)
  for (let i = 0; i < S; i++) {
    const acc = [0, 0, 0, 0]
    for (let a = 0; a < SS; a++)
      for (let b = 0; b < SS; b++) {
        const c = sample((i + (a + 0.5) / SS) / S, (j + (b + 0.5) / SS) / S)
        acc[0] += c[0] * c[3]
        acc[1] += c[1] * c[3]
        acc[2] += c[2] * c[3]
        acc[3] += c[3]
      }
    const o = (j * S + i) * 4
    const al = acc[3] / (SS * SS)
    px[o] = acc[3] ? acc[0] / acc[3] : 0
    px[o + 1] = acc[3] ? acc[1] / acc[3] : 0
    px[o + 2] = acc[3] ? acc[2] / acc[3] : 0
    px[o + 3] = al
  }

// PNG encode
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let j = 0; j < S; j++) {
  raw[j * (S * 4 + 1)] = 0
  for (let i = 0; i < S * 4; i++) raw[j * (S * 4 + 1) + 1 + i] = Math.round(px[j * S * 4 + i])
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc = buf => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc(td))
  return Buffer.concat([len, td, c])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('build/icon.png written')
