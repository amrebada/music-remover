// Builds test audio in fixtures/: a speech track, a synthetic music track, their
// mix, and fragmented-MP4 versions of the mix for the MSE test page.
//
//   node scripts/make-fixtures.mjs [speech.wav]
//
// Without an argument the speech is generated with macOS `say`. Needs ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readWav, SR, writeWav } from './wav.mjs';

const OUT = join(import.meta.dirname, '..', 'fixtures');
const MUSIC_GAIN_DB = -8; // music level relative to speech RMS in the mix

mkdirSync(OUT, { recursive: true });

function ffmpeg(...args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

function speechTrack(src) {
  const wav = join(OUT, 'speech.wav');
  if (src) {
    ffmpeg('-i', src, '-ar', String(SR), '-ac', '2', '-c:a', 'pcm_s16le', wav);
  } else {
    const aiff = join(OUT, 'speech.aiff');
    const text =
      'Welcome back to the channel. Today we are going to talk about how sound works on the web. ' +
      'Every video you watch carries an audio track, and that track is a mix of voices, music and effects. ' +
      'Separating them used to need a studio. Now a small neural network can do it right inside your browser. ' +
      'Let us look at how the model hears the difference between a voice and a guitar.';
    execFileSync('say', ['-o', aiff, text]);
    ffmpeg('-i', aiff, '-ar', String(SR), '-ac', '2', '-c:a', 'pcm_s16le', wav);
  }
  return readWav(wav);
}

// A small band: pad chords, bass, plucked melody and drums at 100 bpm.
function musicTrack(frames) {
  const out = new Float32Array(frames);
  const beat = 60 / 100;
  const chords = [
    [261.63, 329.63, 392.0],
    [196.0, 246.94, 293.66],
    [220.0, 261.63, 329.63],
    [174.61, 220.0, 261.63],
  ];
  const melody = [523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25, 440.0];
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;

  for (let i = 0; i < frames; i++) {
    const t = i / SR;
    const beatIdx = Math.floor(t / beat);
    const tb = t - beatIdx * beat;
    const chord = chords[Math.floor(beatIdx / 4) % chords.length];
    let v = 0;
    for (const f of chord) {
      for (let k = 1; k <= 5; k++) v += (0.05 / k) * Math.sin(2 * Math.PI * f * k * t);
    }
    v *= 0.6 + 0.4 * Math.exp(-tb * 3);
    v += 0.25 * Math.sin(2 * Math.PI * (chord[0] / 2) * t) * Math.exp(-tb * 2);
    const note = melody[beatIdx % melody.length];
    const half = beat / 2;
    const tn = tb % half;
    v += 0.12 * Math.sin(2 * Math.PI * note * t) * Math.exp(-tn * 6) * (1 + 0.3 * Math.sin(2 * Math.PI * note * 2 * t));
    if (beatIdx % 2 === 0) v += 0.5 * Math.sin(2 * Math.PI * (40 + 80 * Math.exp(-tb * 30)) * tb) * Math.exp(-tb * 12);
    else v += 0.25 * noise() * Math.exp(-tb * 25);
    v += 0.05 * noise() * Math.exp(-tn * 60);
    out[i] = v;
  }
  return out;
}

const speech = speechTrack(process.argv[2]);
const frames = speech[0].length;
const mono = musicTrack(frames);
const gain = (rms(speech[0]) / rms(mono)) * 10 ** (MUSIC_GAIN_DB / 20);
const music = [mono.map((v) => v * gain), mono.map((v) => v * gain)];
const mix = speech.map((ch, c) => ch.map((v, i) => v + music[c][i]));

writeWav(join(OUT, 'music.wav'), music);
writeWav(join(OUT, 'mix.wav'), mix);

// Fragmented MP4s like the ones video sites append to MediaSource.
ffmpeg('-i', join(OUT, 'mix.wav'), '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000', join(OUT, 'mix-audio.mp4'));
ffmpeg(
  '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${(frames / SR).toFixed(2)}`,
  '-i', join(OUT, 'mix.wav'),
  '-c:v', 'libx264', '-preset', 'veryfast', '-g', '60', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-shortest',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000',
  join(OUT, 'mix-muxed.mp4'),
);
ffmpeg('-i', join(OUT, 'mix-muxed.mp4'), '-an', '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', join(OUT, 'mix-video.mp4'));

console.log(`fixtures written to ${OUT} (${(frames / SR).toFixed(1)} s)`);
