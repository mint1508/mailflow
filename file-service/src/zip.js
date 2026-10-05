// Minimal ZIP writer using stored entries so exports need no native/runtime dependency.
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = buffer => { let crc = 0xffffffff; for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }

export function createZip(entries) {
  const local = []; const central = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/^\/+|\.\.(?:\/|$)/g, '_')); const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data); const crc = crc32(data)
    const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name])
    local.push(header, data)
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]))
    offset += header.length + data.length
  }
  const directory = Buffer.concat(central); return Buffer.concat([...local, directory, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(directory.length), u32(offset), u16(0)])
}
