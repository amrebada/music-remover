// Audio-thread half of a live session. Captures the tab's audio in batches for the
// model and plays back the cleaned blocks the main thread sends in order.
const BATCH = 4096;

class LiveIO extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = [new Float32Array(BATCH), new Float32Array(BATCH)];
    this.batchLength = 0;
    this.queue = [];
    this.queueOffset = 0;
    this.queued = 0;
    this.prebuffer = 0;
    this.maxQueued = Infinity;
    this.playing = false;
    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'audio') {
        this.queue.push(msg.channels);
        this.queued += msg.channels[0].length;
        // Results can arrive in bursts; never let the delay grow past the target.
        while (this.queued > this.maxQueued && this.queue.length > 1) {
          const dropped = this.queue.shift();
          this.queued -= dropped[0].length - this.queueOffset;
          this.queueOffset = 0;
        }
      } else if (msg.type === 'config') {
        this.prebuffer = msg.prebuffer;
        this.maxQueued = msg.maxQueued;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const frames = out[0].length;
    const left = input[0];
    const right = input[1] ?? input[0];

    for (let i = 0; i < frames; i++) {
      this.batch[0][this.batchLength] = left ? left[i] : 0;
      this.batch[1][this.batchLength] = right ? right[i] : 0;
      if (++this.batchLength === BATCH) {
        this.port.postMessage({ type: 'capture', channels: this.batch }, [this.batch[0].buffer, this.batch[1].buffer]);
        this.batch = [new Float32Array(BATCH), new Float32Array(BATCH)];
        this.batchLength = 0;
      }
    }

    if (!this.playing && this.queued > 0 && this.queued >= this.prebuffer) this.playing = true;
    for (let i = 0; i < frames; i++) {
      if (!this.playing || this.queue.length === 0) {
        out[0][i] = 0;
        if (out[1]) out[1][i] = 0;
        continue;
      }
      const chunk = this.queue[0];
      out[0][i] = chunk[0][this.queueOffset];
      if (out[1]) out[1][i] = chunk[1][this.queueOffset];
      this.queued--;
      if (++this.queueOffset === chunk[0].length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    // Ran dry: wait for a full prebuffer again instead of stuttering.
    if (this.playing && this.queue.length === 0) this.playing = false;
    return true;
  }
}

registerProcessor('music-remover-live-io', LiveIO);
