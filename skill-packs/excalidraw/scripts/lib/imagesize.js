// Minimal, dependency-free image dimension reader. Supports PNG, JPEG, GIF, WebP, BMP.
// Returns { width, height, mime } or throws.
const fs = require('fs');

function fromBuffer(buf) {
  // PNG: \x89PNG\r\n\x1a\n, IHDR width/height at bytes 16..24 (big-endian)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  // GIF: 'GIF87a' / 'GIF89a', width/height little-endian at bytes 6..10
  if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), mime: 'image/gif' };
  }
  // BMP
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), mime: 'image/bmp' };
  }
  // WebP: RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, mime: 'image/webp' };
    } else if (fmt === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, mime: 'image/webp' };
    } else if (fmt === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width: w, height: h, mime: 'image/webp' };
    }
  }
  // JPEG: scan SOFn markers
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      // SOF0..SOF15 except DHT(c4) DAC(cc) RSTn — these carry frame dims
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buf.readUInt16BE(off + 5);
        const width = buf.readUInt16BE(off + 7);
        return { width, height, mime: 'image/jpeg' };
      }
      const len = buf.readUInt16BE(off + 2);
      off += 2 + len;
    }
  }
  throw new Error('unsupported or unrecognized image format');
}

function imageSize(filePath) {
  // Read enough bytes for any header (JPEG may need more; read up to 256KB)
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const n = Math.min(stat.size, 262144);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    return fromBuffer(buf);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { imageSize, fromBuffer };
