// Splits the bytes a player appends to a SourceBuffer into the init segment
// (ftyp+moov) and complete fragments (moof+mdat). Players may append partial
// boxes, so incomplete data is kept until the rest arrives.

export interface Assembled {
  init?: ArrayBuffer;
  fragments: ArrayBuffer[];
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export class FragmentAssembler {
  private pending = new Uint8Array(0);
  private ftyp?: Uint8Array;

  push(bytes: ArrayBuffer): Assembled {
    const buf = concat(this.pending, new Uint8Array(bytes));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out: Assembled = { fragments: [] };
    let pos = 0;
    let moofStart = -1;

    while (pos + 8 <= buf.length) {
      let size = view.getUint32(pos);
      const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
      if (size === 1) {
        if (pos + 16 > buf.length) break;
        size = view.getUint32(pos + 8) * 2 ** 32 + view.getUint32(pos + 12);
      } else if (size === 0) {
        size = buf.length - pos; // box runs to the end of the stream
      }
      if (size < 8 || pos + size > buf.length) break;

      const box = buf.subarray(pos, pos + size);
      if (type === 'ftyp') {
        this.ftyp = box.slice();
      } else if (type === 'moov') {
        out.init = (this.ftyp ? concat(this.ftyp, box) : box.slice()).buffer as ArrayBuffer;
        moofStart = -1;
      } else if (type === 'moof') {
        moofStart = pos;
      } else if (type === 'mdat' && moofStart >= 0) {
        out.fragments.push(buf.slice(moofStart, pos + size).buffer);
        moofStart = -1;
      }
      pos += size;
    }

    this.pending = buf.slice(moofStart >= 0 ? moofStart : pos);
    return out;
  }

  /** Drops partial data, e.g. after SourceBuffer.abort(). The init segment is kept. */
  reset() {
    this.pending = new Uint8Array(0);
  }
}
