// Decides which block of media to clean next. Blocks sit on a fixed grid of
// `blockSec`; each job adds `contextSec` of audio on both sides so the model hears
// what surrounds the block, and only the block itself is kept.

export interface PlanInput {
  playhead: number;
  /** Media duration; Infinity for live streams or when unknown. */
  duration: number;
  blockSec: number;
  contextSec: number;
  /** How far ahead of the playhead to work. */
  aheadSec: number;
  /** Block already cleaned or in flight. */
  isTaken: (block: number) => boolean;
  coveredFrom: (time: number) => number;
  coveredUntil: (time: number) => number;
}

export interface PlannedJob {
  block: number;
  windowStart: number;
  windowEnd: number;
  /** Media time range to keep from the result. */
  keepStart: number;
  keepEnd: number;
}

const EPS = 1e-3;
/** At the very end, decoders may hold back the last frame or two. */
const END_SLACK = 0.25;

export function blockAt(time: number, blockSec: number): number {
  return Math.floor(time / blockSec + EPS);
}

export function planNextJob(p: PlanInput): PlannedJob | null {
  const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : Infinity;
  const first = blockAt(p.playhead, p.blockSec);
  const last = blockAt(Math.min(p.playhead + p.aheadSec, duration - EPS), p.blockSec);

  for (let block = first; block <= last; block++) {
    if (p.isTaken(block)) continue;
    // The playhead's own block starts at the playhead, so a seek mid-block works right away.
    const keepStart = block === first ? Math.max(block * p.blockSec, Math.min(p.playhead, p.coveredFrom(p.playhead))) : block * p.blockSec;
    let keepEnd = Math.min((block + 1) * p.blockSec, duration);
    if (keepEnd - keepStart < EPS) continue;

    const windowStart = Math.max(keepStart - p.contextSec, p.coveredFrom(keepStart), 0);
    let windowEnd = Math.min(keepEnd + p.contextSec, duration);
    const covered = p.coveredUntil(keepStart);
    const atEnd = windowEnd >= duration - EPS && covered >= duration - END_SLACK;
    // Blocks are cleaned in order; wait for the player to append more audio.
    if (p.coveredFrom(keepStart) > keepStart + EPS || (covered < windowEnd - EPS && !atEnd)) return null;
    if (atEnd) {
      windowEnd = Math.min(windowEnd, covered);
      keepEnd = Math.min(keepEnd, covered);
    }
    return { block, windowStart, windowEnd, keepStart, keepEnd };
  }
  return null;
}
