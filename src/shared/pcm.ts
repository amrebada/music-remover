// Extension messaging is JSON-only, so audio crosses contexts as base64 16-bit PCM.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Interleaves channels into 16-bit PCM and base64-encodes it. */
export function encodePcm(channels: Float32Array[]): string {
  const frames = channels[0].length;
  const count = channels.length;
  const out = new Int16Array(frames * count);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const s = channels[c][i];
      out[i * count + c] = s >= 1 ? 32767 : s <= -1 ? -32768 : Math.round(s * 32767);
    }
  }
  return bytesToBase64(new Uint8Array(out.buffer));
}

export function decodePcm(base64: string, channelCount: number): Float32Array<ArrayBuffer>[] {
  const bytes = base64ToBytes(base64);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const frames = samples.length / channelCount;
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) channels[c][i] = samples[i * channelCount + c] / 32768;
  }
  return channels;
}
