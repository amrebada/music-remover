// Minimal 16-bit PCM WAV reader/writer for scripts and tests.
import { readFileSync, writeFileSync } from 'node:fs';

export const SR = 44100;

export function readWav(path) {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let fmt;
  while (pos < buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      fmt = { channels: view.getUint16(pos + 10, true), bits: view.getUint16(pos + 22, true) };
    } else if (id === 'data') {
      if (fmt.bits !== 16) throw new Error('only 16-bit wav supported');
      const frames = size / 2 / fmt.channels;
      const ch = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.channels; c++) {
          ch[c][i] = view.getInt16(pos + 8 + (i * fmt.channels + c) * 2, true) / 32768;
        }
      }
      return ch;
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

export function writeWav(path, channels) {
  const frames = channels[0].length;
  const n = channels.length;
  const buf = Buffer.alloc(44 + frames * n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + frames * n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(n, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * n * 2, 28);
  buf.writeUInt16LE(n * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(frames * n * 2, 40);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < n; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(s * 32767), 44 + (i * n + c) * 2);
    }
  }
  writeFileSync(path, buf);
}
