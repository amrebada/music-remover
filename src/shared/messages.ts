import type { ModelId } from '../engine/models';
import type { ModelState } from '../engine/protocol';
import type { Settings } from './settings';

/** Per-tab state the content script reports for the badge and popup. */
export interface LookaheadState {
  active: boolean;
  /** Seconds of cleaned audio ready ahead of the playhead. */
  readySec?: number;
  waitingForGesture?: boolean;
}

export interface TabStatus {
  live: boolean;
  liveError?: string;
  lookahead?: LookaheadState;
}

export type RuntimeMessage =
  // popup → background
  | { type: 'live:toggle'; tabId: number }
  | { type: 'status:get'; tabId: number }
  // content script → background
  | { type: 'offscreen:ensure' }
  | { type: 'lookahead:state'; state: LookaheadState }
  // background → offscreen
  | { type: 'live:start'; target: 'offscreen'; tabId: number; streamId: string; settings: Settings }
  | { type: 'live:stop'; target: 'offscreen'; tabId: number }
  | { type: 'live:settings'; target: 'offscreen'; settings: Settings }
  | { type: 'engine:preload'; target: 'offscreen'; model: ModelId }
  | { type: 'engine:states'; target: 'offscreen' }
  /** Test hook: returns a live session's recording when the debug flag is on. */
  | { type: 'live:debug-dump'; target: 'offscreen'; tabId: number }
  // offscreen → background / popup
  | { type: 'live:ended'; tabId: number; error?: string }
  | { type: 'engine:model'; model: ModelId; state: ModelState };

export const SEPARATE_PORT = 'separate';

/** Content script → offscreen, over a port named SEPARATE_PORT. */
export type PortRequest =
  | {
      type: 'separate';
      id: number;
      model: ModelId;
      sampleRate: number;
      /** base64 16-bit interleaved stereo */
      pcm: string;
      keepFromSec: number;
      keepToSec: number;
      strength: number;
    }
  | { type: 'cancel'; ids: number[] };

export type PortResponse =
  | { type: 'result'; id: number; pcm: string }
  | { type: 'error'; id: number; message: string }
  | { type: 'model'; model: ModelId; state: ModelState };
