import type { LiveLatency } from '../shared/settings';

/** Seconds per block, future context (adds delay) and past context (free). */
export const LIVE_PRESETS: Record<LiveLatency, { block: number; future: number; past: number }> = {
  low: { block: 0.5, future: 0.25, past: 2 },
  balanced: { block: 1, future: 0.5, past: 3 },
  clean: { block: 2, future: 1, past: 3 },
};

/** Approximate delay live mode adds: one block, its future context and half a block of prebuffer. */
export function liveDelaySec(latency: LiveLatency): number {
  const p = LIVE_PRESETS[latency];
  return p.block * 1.5 + p.future;
}
