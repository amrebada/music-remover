// Audio-thread half of a live session. Captures the tab's audio in small batches
// for the model, and plays the cleaned blocks the main thread sends back (in
// order) through a small jitter buffer that keeps the delay low.

const CAPACITY = 1 << 17; // ~3 s at 44.1 kHz
const MASK = CAPACITY - 1;
/** Excess delay (frames) worth trimming, and how much the cushion grows after a gap. */
const SHED_THRESHOLD = 256;
const CUSHION_STEP = 512;

class LiveIO extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batchSize = options.processorOptions.batch;
    this.batch = [new Float32Array(this.batchSize), new Float32Array(this.batchSize)];
    this.batchLength = 0;

    this.ring = [new Float32Array(CAPACITY), new Float32Array(CAPACITY)];
    this.readPos = 0;
    this.writePos = 0;
    /** Silence played before the queue starts, and again after it runs dry. */
    this.cushion = 0;
    this.maxCushion = 0;
    this.playing = false;
    this.waiting = 0;
    /** Lowest queue level seen in the current one-second window: the spare delay. */
    this.lowWater = Infinity;
    this.windowLeft = sampleRate;
    this.shed = 0;

    this.underruns = 0;
    this.lastUnderrun = 0;
    this.dropped = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'audio') this.write(msg.channels);
      else if (msg.type === 'config') {
        this.cushion = msg.cushion;
        this.maxCushion = msg.cushion * 2;
      } else if (msg.type === 'stats') {
        const sinceUnderrun = this.underruns ? currentTime - this.lastUnderrun : null;
        this.port.postMessage({ type: 'stats', underruns: this.underruns, sinceUnderrun, dropped: this.dropped, cushion: this.cushion });
      }
    };
  }

  get queued() {
    return this.writePos - this.readPos;
  }

  write([left, right]) {
    for (let i = 0; i < left.length; i++) {
      const j = (this.writePos + i) & MASK;
      this.ring[0][j] = left[i];
      this.ring[1][j] = right[i];
    }
    this.writePos += left.length;
    if (this.queued > CAPACITY) {
      this.dropped += this.queued - CAPACITY;
      this.readPos = this.writePos - CAPACITY;
    }
  }

  capture(input, frames) {
    const left = input[0];
    const right = input[1] ?? input[0];
    for (let i = 0; i < frames; i++) {
      this.batch[0][this.batchLength] = left ? left[i] : 0;
      this.batch[1][this.batchLength] = right ? right[i] : 0;
      if (++this.batchLength === this.batchSize) {
        this.port.postMessage({ type: 'capture', channels: this.batch }, [this.batch[0].buffer, this.batch[1].buffer]);
        this.batch = [new Float32Array(this.batchSize), new Float32Array(this.batchSize)];
        this.batchLength = 0;
      }
    }
  }

  /** Once a second, plans to drop whatever the queue never needed beyond the cushion. */
  trackSpareDelay(frames) {
    this.lowWater = Math.min(this.lowWater, this.queued);
    this.windowLeft -= frames;
    if (this.windowLeft > 0) return;
    if (this.lowWater - this.cushion > SHED_THRESHOLD) this.shed = this.lowWater - this.cushion;
    this.lowWater = Infinity;
    this.windowLeft = sampleRate;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    const [ring0, ring1] = this.ring;
    this.capture(inputs[0], frames);

    if (!this.playing && this.queued > 0) {
      this.playing = true;
      this.waiting = this.cushion;
      this.lowWater = Infinity;
      this.windowLeft = sampleRate;
    }
    if (this.playing && this.waiting === 0) this.trackSpareDelay(frames);

    let i = 0;
    let starved = false;
    if (this.shed > 0 && this.waiting === 0 && this.queued >= this.shed + frames) {
      // Jump ahead, crossfading over this render quantum so the cut is not heard.
      for (; i < frames; i++) {
        const w = (i + 0.5) / frames;
        const a = (this.readPos + i) & MASK;
        const b = (this.readPos + this.shed + i) & MASK;
        out[0][i] = ring0[a] * (1 - w) + ring0[b] * w;
        if (out[1]) out[1][i] = ring1[a] * (1 - w) + ring1[b] * w;
      }
      this.readPos += this.shed + frames;
      this.dropped += this.shed;
      this.shed = 0;
    }
    for (; i < frames; i++) {
      if (this.waiting > 0 || this.queued === 0) {
        if (this.waiting > 0) this.waiting--;
        else starved = this.playing;
        out[0][i] = 0;
        if (out[1]) out[1][i] = 0;
        continue;
      }
      const j = this.readPos++ & MASK;
      out[0][i] = ring0[j];
      if (out[1]) out[1][i] = ring1[j];
    }

    if (starved) {
      // Ran dry: a block came late. Start again with a slightly bigger cushion.
      this.playing = false;
      this.shed = 0;
      this.underruns++;
      this.lastUnderrun = currentTime;
      this.cushion = Math.min(this.maxCushion, this.cushion + CUSHION_STEP);
    }
    return true;
  }
}

registerProcessor('music-remover-live-io', LiveIO);
