import type { ModelId } from './models';
import type { Samples } from './separator';

export interface SeparateJob {
  id: number;
  model: ModelId;
  /** Lower runs first: live audio must not wait behind lookahead work. */
  priority: number;
  sampleRate: number;
  left: Samples;
  right: Samples;
  /** Region of the window to return, in seconds from the window start. */
  keepFromSec: number;
  keepToSec: number;
  strength: number;
}

export type ModelState =
  | { status: 'idle' }
  | { status: 'downloading'; loaded: number; total: number }
  | { status: 'loading' }
  | { status: 'ready'; backend: string }
  | { status: 'error'; message: string };

export type WorkerRequest =
  | { type: 'separate'; job: SeparateJob }
  | { type: 'load'; model: ModelId }
  | { type: 'cancel'; ids: number[] };

export type WorkerEvent =
  /** Output is always 44.1 kHz stereo. */
  | { type: 'result'; id: number; left: Samples; right: Samples }
  | { type: 'error'; id: number; message: string }
  | { type: 'model'; model: ModelId; state: ModelState };
