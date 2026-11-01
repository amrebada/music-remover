# Music Remover

A Chrome extension that removes background music from videos and keeps the voices (speech and singing). All processing runs on your device; no audio leaves the browser.

It has two modes:

- **Automatic (lookahead)** on YouTube, Facebook, Instagram and LinkedIn. The extension copies each audio segment the site's player downloads, cleans it before the playhead reaches it, and plays the cleaned audio in sync with the video while the original is silenced. There is no added delay.
- **Live**, on any tab. Click **Start live mode** in the popup (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd>). The tab's audio is captured, cleaned in 46–70 ms blocks and played back. This delays the sound by about 140–190 ms, depending on the "Live mode delay" setting (about 155 ms by default); the video picture is not delayed.

## Try it

```bash
pnpm install
```

```bash
pnpm build
```

Then open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `.output/chrome-mv3`. For development with reload, use `pnpm dev`.

The first time a model is needed it is downloaded from Hugging Face and cached: 36 MB for **Fast**, 181 MB for **High quality**.

## Models

| Setting | Model | Size | Runs on | Used by |
|---|---|---|---|---|
| Fast (default) | Open-Unmix UMX-HQ, vocals target | 36 MB | CPU (WASM) | lookahead, and always for live mode |
| High quality | HTDemucs v4, vocals stem | 181 MB | GPU (WebGPU) | lookahead |

Both are MIT-licensed and pinned to exact revisions with a SHA-256 check (`src/engine/models.ts`). On the test mix, Open-Unmix raises the voice SI-SDR from 8 dB to about 15 dB, and HTDemucs to about 22 dB.

## How it works

```
page (MAIN world)       mse-tap: wraps MediaSource/SourceBuffer, copies audio segments
page (isolated world)   player: fMP4 demux (mp4box) → WebCodecs decode → timeline →
                        planner picks the next block → engine → VoiceStore → SyncPlayer
                        (routes <video> through Web Audio, mutes it, schedules cleaned audio)
offscreen document      engine: ONNX Runtime Web in a worker, model cache;
                        live sessions: tab capture → AudioWorklet → own engine worker → AudioWorklet
background worker       per-tab state, badge, tab capture, offscreen lifecycle
```

- `src/engine/`: model registry, separators (`umx.ts`, `demucs.ts`), cache and inference worker.
- `src/lookahead/`: the MediaSource tap and everything that cleans ahead of the playhead.
- `src/live/`: tab-capture sessions and the audio worklet (`public/worklets/live-io.js`).
- `entrypoints/`: background, offscreen document, popup, content scripts and a benchmark page (`bench.html`).

## Tests

```bash
pnpm fixtures
```

```bash
pnpm test
```

```bash
pnpm test:e2e
```

- `pnpm fixtures` builds the test audio (macOS `say` speech plus synthetic band music) and needs ffmpeg.
- `pnpm test` runs the unit tests. Put the models in `fixtures/models/` (`umx-vocals.onnx`, `htdemucs.onnx`) to also run the separator tests.
- `pnpm test:e2e` loads the built extension in Playwright's Chromium:
  - It plays the fixture through MediaSource on a page served as `www.youtube.com`, and captures a real tab for live mode.
  - It then checks what was actually heard: lip-sync within 45 ms in lookahead mode, a delay under 200 ms without dropouts in live mode, and how much music is left.
  - Current results: music weight drops from 1.00 to 0.20 with Fast and to 0.02 with High quality. Sync error is about 2 ms.
  - The live-mode test unmutes the browser, so the test clip may be audible.
- `REAL_SITES=1 pnpm test:e2e` also checks a real YouTube video.

Debug recording is off unless `localStorage['music-remover-debug'] = '1'` (see `src/shared/debug.ts`).

## Languages

The extension is in English and Arabic; Arabic is laid out right to left. By default it follows Chrome's display language, and **Language** at the bottom of the popup's settings switches the popup and the messages over videos at once. The texts are in `public/_locales/<language>/messages.json`. Chrome also uses them for the extension's name in its own menus and for the store listing, which always follow Chrome's language.

## Logo and store images

`branding/` holds the logo (`logo.svg`, and `logo-small.svg` for 16 and 32 px) and the Chrome Web Store images in English and Arabic, laid out in `store.html`. To redraw the extension icons in `public/icon/` and the store images in `branding/store/en/` and `branding/store/ar/`:

```bash
pnpm build && pnpm brand
```

The screenshots show the real popup in each language, which is why the extension is built first. ffmpeg saves the store images as 24-bit PNGs without transparency, as the store asks.

In each language folder:

| File | Store field |
|---|---|
| `store-icon-128.png` | Store icon |
| `screenshot-1-voices.png` … `screenshot-4-private.png` (1280×800) | Screenshots |
| `promo-small-440x280.png` | Small promo tile |
| `promo-marquee-1400x560.png` | Marquee promo tile |

## Publishing

```bash
pnpm zip
```

This writes `.output/music-remover-<version>-chrome.zip`, the file to upload to the Chrome Web Store (it leaves out the developer benchmark page). To run the browser tests against exactly what is in it, unzip it and set `EXTENSION_DIR` to that folder. [branding/store/listing.md](branding/store/listing.md) has the texts the store's form asks for, and [PRIVACY.md](PRIVACY.md) is the privacy policy.

## Known limits

- Lookahead understands fragmented MP4 (AAC or Opus). On YouTube the extension reports WebM audio as unsupported so the player serves AAC. Players that use other containers, MSE inside workers, or DRM fall back to live mode.
- At playback speeds other than 1× the cleaned voice changes pitch in lookahead mode.
- Speed depends on the machine. High quality needs WebGPU; without a GPU it falls back to the CPU and may not keep up.
- So far only YouTube has been checked against the real site. Facebook, Instagram and LinkedIn need testing with a signed-in browser.
- The name "Music Remover" may already be taken in the Chrome Web Store; check before publishing.
