import type { Quality } from '../shared/settings';

export type ModelId = 'umx-vocals' | 'htdemucs';

export interface ModelInfo {
  id: ModelId;
  label: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Execution providers to try, in order. */
  providers: ('webgpu' | 'wasm')[];
  /** Lookahead blocks: seconds kept per job, and context added on each side. */
  blockSec: number;
  contextSec: number;
}

// Both models are MIT-licensed; revisions are pinned so the sha256 stays valid.
export const MODELS: Record<ModelId, ModelInfo> = {
  'umx-vocals': {
    id: 'umx-vocals',
    label: 'Fast (Open-Unmix, 36 MB)',
    url: 'https://huggingface.co/MixDirective/open-unmix-umxhq-vocals-onnx/resolve/e06097d3193a4c3168b5ddd2a479a680b1176c16/model.onnx',
    sha256: 'f27742bb52b24cb039614dc76d0764e279df3eb2a9d6daa82c6daee3369ec747',
    bytes: 35_623_512,
    // The network is LSTM-based, which the WebGPU provider does not run.
    providers: ['wasm'],
    blockSec: 4,
    contextSec: 1.5,
  },
  htdemucs: {
    id: 'htdemucs',
    label: 'High quality (HTDemucs, 181 MB, needs a GPU)',
    url: 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx',
    sha256: 'e5e425c17683f163a472462eb5f5a4ffcd11c31858d57fbd0833b012d8b88077',
    bytes: 180_534_758,
    providers: ['webgpu', 'wasm'],
    // The graph takes exactly 7.8 s, so block + 2 × context must stay under that.
    blockSec: 5.6,
    contextSec: 1,
  },
};

export const MODEL_FOR_QUALITY: Record<Quality, ModelId> = {
  fast: 'umx-vocals',
  high: 'htdemucs',
};

export const LIVE_MODEL: ModelId = 'umx-vocals';
