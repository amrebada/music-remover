import type { LiveLatency } from '../shared/settings';

export const LIVE_RATE = 44100;

/**
 * In frames: the block cleaned and played as one piece, the future context the
 * model sees after it (both add delay), and the past context before it (adds no
 * delay, but costs model time on every block). Open-Unmix keeps most of its
 * quality with only ~50 ms of future context.
 */
export const LIVE_PRESETS: Record<LiveLatency, { block: number; future: number; past: number }> = {
  low: { block: 2048, future: 1536, past: 22050 },
  balanced: { block: 2048, future: 2048, past: 33075 },
  clean: { block: 3072, future: 2048, past: 44100 },
};

/** Silence played before the first block, so blocks that arrive a little late do not stutter. */
export const LIVE_CUSHION = 1536;

/** Frames the audio worklet collects before sending them for cleaning. */
export const LIVE_CAPTURE_BATCH = 512;

/** Typical model time per second of window on a laptop CPU; a block plays only once it is cleaned. */
const MODEL_MS_PER_SEC = 28;

/** Delay live mode adds, in milliseconds, not counting the audio device's own latency. */
export function liveDelayMs(latency: LiveLatency): number {
  const p = LIVE_PRESETS[latency];
  const frames = p.block + p.future + LIVE_CUSHION + LIVE_CAPTURE_BATCH / 2;
  const modelMs = ((p.past + p.block + p.future) / LIVE_RATE) * MODEL_MS_PER_SEC;
  return Math.round((frames / LIVE_RATE) * 1000 + modelMs);
}
