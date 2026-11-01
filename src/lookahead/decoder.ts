import type { Stereo } from '../engine/separator';
import type { AudioTrackInfo, DemuxedSample } from './demux';

export type DecodedHandler = (start: number, sampleRate: number, channels: Stereo) => void;

/** WebCodecs decoder for one SourceBuffer's audio; output is stereo f32. */
export class StreamDecoder {
  private decoder?: AudioDecoder;
  private configKey = '';

  constructor(
    private readonly onDecoded: DecodedHandler,
    private readonly onError: (err: Error) => void,
  ) {}

  /** Returns false when the browser cannot decode this codec. */
  async configure(track: AudioTrackInfo): Promise<boolean> {
    const config: AudioDecoderConfig = {
      codec: track.codec,
      sampleRate: track.sampleRate,
      numberOfChannels: track.channels,
      description: track.description,
    };
    const key = `${track.codec}/${track.sampleRate}/${track.channels}/${track.description?.join(',') ?? ''}`;
    if (key === this.configKey && this.decoder?.state === 'configured') return true;

    const support = await AudioDecoder.isConfigSupported(config);
    if (!support.supported) return false;
    this.close();
    this.decoder = new AudioDecoder({
      output: (data) => this.emit(data),
      error: (err) => this.onError(err),
    });
    this.decoder.configure(config);
    this.configKey = key;
    return true;
  }

  decode(samples: DemuxedSample[], timestampOffset: number) {
    const decoder = this.decoder;
    if (decoder?.state !== 'configured') return;
    for (const s of samples) {
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((s.timestamp + timestampOffset) * 1e6),
          duration: Math.round(s.duration * 1e6),
          data: s.data,
        }),
      );
    }
  }

  /** Emits frames the decoder is still holding, e.g. at the end of the stream. */
  async flush() {
    if (this.decoder?.state === 'configured') await this.decoder.flush().catch(() => {});
  }

  close() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined;
    this.configKey = '';
  }

  private emit(data: AudioData) {
    const frames = data.numberOfFrames;
    const read = (plane: number) => {
      const out = new Float32Array(frames);
      data.copyTo(out, { planeIndex: plane, format: 'f32-planar' });
      return out;
    };
    const left = read(0);
    const right = data.numberOfChannels > 1 ? read(1) : left.slice();
    this.onDecoded(data.timestamp / 1e6, data.sampleRate, [left, right]);
    data.close();
  }
}
