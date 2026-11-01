import type { ModelInfo } from './models';

const CACHE_NAME = 'music-remover-models-v1';

export type DownloadProgress = (loaded: number, total: number) => void;

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function isModelCached(info: ModelInfo): Promise<boolean> {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(info.url)) !== undefined;
}

/** Returns the model bytes, downloading and verifying them on first use. */
export async function loadModelBytes(info: ModelInfo, onProgress?: DownloadProgress): Promise<Uint8Array<ArrayBuffer>> {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(info.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const response = await fetch(info.url);
  if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);

  let bytes = new Uint8Array(info.bytes);
  let loaded = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (loaded + value.length > bytes.length) {
      const grown = new Uint8Array(Math.max(bytes.length * 2, loaded + value.length));
      grown.set(bytes.subarray(0, loaded));
      bytes = grown;
    }
    bytes.set(value, loaded);
    loaded += value.length;
    onProgress?.(loaded, info.bytes);
  }
  bytes = bytes.slice(0, loaded);

  const hash = await sha256Hex(bytes);
  if (hash !== info.sha256) throw new Error(`Model checksum mismatch for ${info.id}`);

  await cache.put(info.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  return bytes;
}
