# Chrome Web Store submission

Texts to paste into the [developer dashboard](https://chrome.google.com/webstore/devconsole). The store fills each language's **title** and **summary** from the package (`public/_locales`), so they are not repeated here.

## Package

```bash
pnpm zip
```

Upload `.output/music-remover-<version>-chrome.zip`. The store accepts each version once, so raise `version` in `package.json` before every later upload.

## Store listing

- **Category:** Tools
- **Language:** English, with Arabic added as a second language
- **Images:** from `branding/store/en/` and `branding/store/ar/` (see the README's "Logo and store images" table)

### Description (English)

Music Remover removes the background music from videos and keeps the voices, speech and singing alike.

• Automatic on YouTube, Facebook, Instagram and LinkedIn: the sound is cleaned a few seconds before it plays, so voices stay in sync with lips.
• Live mode for any other site: click Start live mode in the extension menu or press Alt+Shift+M. The sound plays about 0.15 seconds behind the picture.
• Runs on your computer: the AI model runs inside Chrome. Your audio is never uploaded, and there is no account.
• Choose how much of the music to remove, and a fast model (36 MB, runs on the processor) or a high quality one (181 MB, uses the graphics card).
• In English and Arabic; pick the language in the extension's settings.

The model is downloaded once from Hugging Face the first time you use it, then kept in Chrome.

Built on open models: Open-Unmix (Inria) and HTDemucs (Meta), both under the MIT license.

### الوصف (العربية)

يحذف «مزيل الموسيقى» الموسيقى الخلفية من الفيديوهات ويُبقي الأصوات، كلامًا كانت أو غناءً.

• تلقائي على يوتيوب وفيسبوك وإنستغرام ولينكدإن: يُنقّى الصوت قبل تشغيله ببضع ثوانٍ، فتبقى الأصوات متزامنة مع حركة الشفاه.
• الوضع المباشر لأي موقع آخر: انقر «تشغيل الوضع المباشر» في قائمة الإضافة أو اضغط Alt+Shift+M. يتأخر الصوت عن الصورة بنحو 0.15 ثانية.
• يعمل على جهازك: يعمل نموذج الذكاء الاصطناعي داخل كروم. لا يُرفع صوتك إلى أي مكان، ولا حاجة إلى إنشاء حساب.
• اختر مقدار الموسيقى المحذوفة، ونموذجًا سريعًا (36 ميغابايت، يعمل على المعالج) أو عالي الجودة (181 ميغابايت، يعمل على بطاقة الرسومات).
• بالعربية والإنجليزية، ويمكنك اختيار اللغة من إعدادات الإضافة.

يُنزَّل النموذج مرة واحدة من Hugging Face عند أول استخدام، ثم يُحفظ في كروم.

مبني على نماذج مفتوحة: Open-Unmix من Inria وHTDemucs من Meta، وكلاهما بترخيص MIT.

## Privacy practices

### Single purpose

Removes background music from the audio of videos and web pages while keeping the voices.

### Permission justifications

| Permission | Justification |
|---|---|
| `tabCapture` | Live mode captures the audio of the tab the user turns it on for, removes the music on the device and plays the result instead. It starts only when the user clicks Start live mode or presses the shortcut. |
| `activeTab` | Gives live mode access to the current tab when the user starts it from the toolbar menu or the keyboard shortcut. |
| `offscreen` | The music-removal model and live mode's audio processing run in an offscreen document, because the background service worker cannot use Web Audio, media capture or long-running model workers. |
| `storage` | Saves the user's settings: on or off, how much music to remove, model quality, live mode delay and language. |
| Host permission: `huggingface.co`, `*.hf.co` | Downloads the open-source model weights (ONNX data files) from Hugging Face once; they are then cached in the browser. Nothing about the user is sent. |
| Content scripts on YouTube, Facebook, Instagram and LinkedIn | On these sites the extension reads the audio the site's own video player downloads, so it can remove the music before playback and keep the voice in sync with the video. The audio is processed on the device and never sent anywhere. |

### Remote code

**No, I am not using remote code.** All JavaScript and WebAssembly are in the package. The only download is the model weights, which are data run by the packaged ONNX Runtime.

### Data usage

- Tick **Website content**: the extension processes the audio of the pages it works on. It stays on the device and is never collected or transmitted.
- Leave every other type unticked.
- Tick all three certifications (no selling or transfer of user data, no use unrelated to the single purpose, no use for credit decisions).
- **Privacy policy URL:** the published `PRIVACY.md` (for example its GitHub page once the repository is public).
