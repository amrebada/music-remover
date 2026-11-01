import { createFile, Log, MP4BoxBuffer, type Movie } from 'mp4box';

Log.setLogLevel(Log.error);

export interface AudioTrackInfo {
  codec: string;
  sampleRate: number;
  channels: number;
  description?: Uint8Array;
  /** Seconds the edit list trims from the start (AAC priming); subtracted from timestamps. */
  editShift: number;
}

export interface DemuxedSample {
  /** Presentation time in seconds, before the SourceBuffer's timestampOffset. */
  timestamp: number;
  duration: number;
  data: Uint8Array;
}

interface SampleEntryLike {
  esds?: { esd: { descs?: { descs?: { data?: Uint8Array }[] }[] } };
  dOps?: {
    OutputChannelCount: number;
    PreSkip: number;
    InputSampleRate: number;
    OutputGain: number;
    ChannelMappingFamily: number;
    StreamCount: number;
    CoupledCount: number;
    ChannelMapping: number[];
  };
}

/** Builds the OpusHead header WebCodecs expects from an MP4 dOps box. */
function opusHead(dOps: NonNullable<SampleEntryLike['dOps']>): Uint8Array {
  const mapped = dOps.ChannelMappingFamily !== 0;
  const head = new Uint8Array(19 + (mapped ? 2 + dOps.OutputChannelCount : 0));
  const view = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  head[8] = 1;
  head[9] = dOps.OutputChannelCount;
  view.setUint16(10, dOps.PreSkip, true);
  view.setUint32(12, dOps.InputSampleRate, true);
  view.setInt16(16, dOps.OutputGain, true);
  head[18] = dOps.ChannelMappingFamily;
  if (mapped) {
    head[19] = dOps.StreamCount;
    head[20] = dOps.CoupledCount;
    head.set(dOps.ChannelMapping, 21);
  }
  return head;
}

/** Parses an init segment plus (optionally) one fragment and returns its audio samples. */
export function demux(init: ArrayBuffer, fragment?: ArrayBuffer): { track: AudioTrackInfo | null; samples: DemuxedSample[] } {
  const file = createFile();
  let track: AudioTrackInfo | null = null;
  const samples: DemuxedSample[] = [];

  file.onReady = (movie: Movie) => {
    const audio = movie.audioTracks[0];
    if (!audio?.audio) return;
    const trak = file.getTrackById(audio.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as SampleEntryLike;
    const edit = trak.edts?.elst?.entries?.[0];
    const isOpus = audio.codec.toLowerCase() === 'opus';
    track = {
      codec: isOpus ? 'opus' : audio.codec,
      sampleRate: audio.audio.sample_rate,
      channels: audio.audio.channel_count,
      description: isOpus && entry.dOps ? opusHead(entry.dOps) : entry.esds?.esd.descs?.[0]?.descs?.[0]?.data,
      editShift: edit && edit.media_time > 0 ? edit.media_time / audio.timescale : 0,
    };
    file.setExtractionOptions(audio.id, undefined, { nbSamples: Number.MAX_SAFE_INTEGER });
    file.start();
  };

  file.onSamples = (_id, _user, list) => {
    const shift = track?.editShift ?? 0;
    for (const s of list) {
      if (!s.data) continue;
      samples.push({ timestamp: s.cts / s.timescale - shift, duration: s.duration / s.timescale, data: s.data });
    }
  };

  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(init.slice(0), 0));
  if (fragment) file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(fragment.slice(0), init.byteLength));
  file.flush();
  return { track, samples };
}
