// One-shot icon generator. No image libraries are installed on this machine and the
// app needs real PNGs for the iOS home screen, so the pixels are written by hand.
// Run: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BG = [0xbf, 0x57, 0x00]      // UT burnt orange
const FG = [0xff, 0xff, 0xff]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  const body = out.subarray(4, 8 + data.length)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}

/** A plate: orange field, white rim, white centre. Reads at 40px on a home screen. */
function pixel(x, y, size) {
  const cx = size / 2
  const cy = size / 2
  const d = Math.hypot(x - cx, y - cy)
  const rim = size * 0.34
  const thickness = size * 0.055
  if (Math.abs(d - rim) < thickness) return FG
  if (d < size * 0.16) return FG
  return BG
}

function png(size) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let p = 0
  for (let y = 0; y < size; y++) {
    raw[p++] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5, size)
      raw[p++] = r; raw[p++] = g; raw[p++] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const root = fileURLToPath(new URL('../', import.meta.url))
for (const size of [180, 512]) {
  writeFileSync(`${root}icon-${size}.png`, png(size))
  console.log(`icon-${size}.png`)
}

writeFileSync(`${root}icon.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#bf5700"/>
  <circle cx="256" cy="256" r="174" fill="none" stroke="#fff" stroke-width="56"/>
  <circle cx="256" cy="256" r="82" fill="#fff"/>
</svg>
`)
console.log('icon.svg')
