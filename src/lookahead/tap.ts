import { isAudioMime, TAP_SOURCE, type TapEnvelope, type TapMessage } from './tapProtocol';

declare global {
  interface Window {
    __musicRemoverTap?: boolean;
    ManagedMediaSource?: typeof MediaSource;
  }
}

function copyBytes(data: BufferSource): ArrayBuffer {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return view.slice().buffer;
}

/**
 * Runs in the page's MAIN world before any site script. Wraps MediaSource and
 * SourceBuffer so the isolated content script gets a copy of every audio segment
 * the player appends, without changing what the player sees.
 */
export function installTap() {
  if (window.__musicRemoverTap || typeof MediaSource === 'undefined') return;
  window.__musicRemoverTap = true;

  let nextId = 1;
  const msIds = new WeakMap<MediaSource, number>();
  const sbIds = new WeakMap<SourceBuffer, number>();

  const send = (msg: TapMessage, transfer: Transferable[] = []) => {
    window.postMessage({ source: TAP_SOURCE, msg } satisfies TapEnvelope, '*', transfer);
  };
  const idOf = (ms: MediaSource) => {
    let id = msIds.get(ms);
    if (id === undefined) {
      id = nextId++;
      msIds.set(ms, id);
    }
    return id;
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj: Blob | MediaSource) {
    const url = createObjectURL.call(URL, obj);
    if (obj instanceof MediaSource) send({ kind: 'ms-url', msId: idOf(obj), url });
    return url;
  };

  const msProto = MediaSource.prototype;
  const addSourceBuffer = msProto.addSourceBuffer;
  msProto.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = addSourceBuffer.call(this, mime);
    if (isAudioMime(mime)) {
      const sbId = nextId++;
      sbIds.set(sb, sbId);
      send({ kind: 'sb-add', msId: idOf(this), sbId, mime });
    }
    return sb;
  };

  const endOfStream = msProto.endOfStream;
  msProto.endOfStream = function (this: MediaSource, error?: EndOfStreamError) {
    send({ kind: 'ms-end', msId: idOf(this) });
    return endOfStream.call(this, error);
  };

  const sbProto = SourceBuffer.prototype;
  const appendBuffer = sbProto.appendBuffer;
  sbProto.appendBuffer = function (this: SourceBuffer, data: BufferSource) {
    const sbId = sbIds.get(this);
    if (sbId !== undefined) {
      const bytes = copyBytes(data);
      send({ kind: 'append', sbId, bytes, timestampOffset: this.timestampOffset }, [bytes]);
    }
    return appendBuffer.call(this, data);
  };

  const remove = sbProto.remove;
  sbProto.remove = function (this: SourceBuffer, start: number, end: number) {
    const sbId = sbIds.get(this);
    if (sbId !== undefined) send({ kind: 'remove', sbId, start, end });
    return remove.call(this, start, end);
  };

  const abort = sbProto.abort;
  sbProto.abort = function (this: SourceBuffer) {
    const sbId = sbIds.get(this);
    if (sbId !== undefined) send({ kind: 'abort', sbId });
    return abort.call(this);
  };

  const changeType = sbProto.changeType;
  if (changeType) {
    sbProto.changeType = function (this: SourceBuffer, mime: string) {
      const sbId = sbIds.get(this);
      if (sbId !== undefined) send({ kind: 'sb-type', sbId, mime });
      return changeType.call(this, mime);
    };
  }

  // YouTube prefers Opus in WebM; reporting WebM audio as unsupported makes it serve
  // AAC in fragmented MP4, which is the only container we demux.
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)) {
    for (const ctor of [MediaSource, window.ManagedMediaSource]) {
      if (!ctor?.isTypeSupported) continue;
      const isTypeSupported = ctor.isTypeSupported.bind(ctor);
      ctor.isTypeSupported = (type: string) => !/^audio\/webm/i.test(type) && isTypeSupported(type);
    }
  }
}
