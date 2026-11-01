// Messages from the MAIN-world MediaSource tap to the isolated content script.

export const TAP_SOURCE = 'music-remover-tap';

export type TapMessage =
  | { kind: 'ms-url'; msId: number; url: string }
  | { kind: 'ms-end'; msId: number }
  | { kind: 'sb-add'; msId: number; sbId: number; mime: string }
  | { kind: 'sb-type'; sbId: number; mime: string }
  | { kind: 'append'; sbId: number; bytes: ArrayBuffer; timestampOffset: number }
  | { kind: 'remove'; sbId: number; start: number; end: number }
  | { kind: 'abort'; sbId: number };

export interface TapEnvelope {
  source: typeof TAP_SOURCE;
  msg: TapMessage;
}

/** True for SourceBuffers that carry audio, including muxed audio+video ones. */
export function isAudioMime(mime: string): boolean {
  return /^audio\/|mp4a|opus|ac-3|ec-3|flac/i.test(mime);
}
