# <img src="icons/icon48.png" alt="" width="32" /> PolyTranslate

A privacy-first Chrome extension that adds offline, inline translation to PolyAI Agent Studio. All translation happens locally on your machine using [Bergamot](https://github.com/browsermt/bergamot-translator) — the same neural translation engine that powers Firefox Translate. No text ever leaves your device.

## Features

### Conversation Transcript Translation
Translate completed conversation transcripts inline. Click the **PolyTranslate** button in the sidebar, select source/target languages, and hit **Translate**. Only messages that actually changed get a language badge. Toggle translation off to restore the originals.

### Live Chat Translation
Toggle **Live** mode from the sidebar to auto-translate incoming agent and caller messages in real time during a chat session. Works alongside the conversation review panel.

### Input Auto-Translator
A translate button sits above the send arrow in the chat textarea. Click it to select source and target languages and translate your typed input before sending.

**Keyboard shortcut:** `Cmd+Shift+Y` (Mac) / `Ctrl+Shift+Y` (Windows/Linux)

### Adaptive Extension Icon
The toolbar icon shows the full-color PolyTranslate logo on `*.poly.ai` pages and switches to a greyed-out version on all other sites.

## Privacy

PolyTranslate is designed so that **no translation data ever leaves your machine**:

- Translation runs entirely in-browser via a WebAssembly (WASM) build of [Bergamot Translator](https://github.com/browsermt/bergamot-translator)
- Language models are downloaded once during setup and stored locally in the `models/` directory
- After setup, the extension works fully offline — no network requests during translation
- The only network activity is the one-time model download when you run `polyt init` or `polyt add`

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/pswanson/PolyTranslate.git
cd PolyTranslate
```

### 2. Download language models

Run the setup script to choose which languages you need. Each language pair is ~20-50 MB.

```bash
./setup.sh init
```

You'll see an interactive picker — enter the numbers of the languages you want, separated by spaces:

```
  Available languages:

     1) Arabic        2) Chinese       3) Danish        4) Dutch
     5) French        6) German        7) Greek         8) Hebrew
     9) Hindi        10) Italian      11) Japanese     12) Korean
    13) Norwegian    14) Polish       15) Portuguese   16) Romanian
    17) Russian      18) Serbian      19) Spanish      20) Swedish
    21) Thai         22) Ukrainian    23) Vietnamese

  Enter numbers separated by spaces, all for everything, or q to cancel:
  > 5 6 19
```

This would install French, German, and Spanish. Type `all` to install every language (~1.5 GB), or `q` to cancel.

### 3. Install the global CLI (recommended)

This lets you run `polyt` from anywhere instead of needing to be in the extension folder:

```bash
sudo ln -sf "$(pwd)/setup.sh" /usr/local/bin/polyt
```

**Without this step, you'll need to `cd` into the PolyTranslate folder and use `./setup.sh` instead of `polyt` for all commands below.**

### 4. Load the extension

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `PolyTranslate` folder
4. Navigate to any Agent Studio page on `studio.us.poly.ai`

## Managing Languages

Use the `polyt` CLI (or `./setup.sh`) to manage installed translation models:

| Command | Description |
|---------|-------------|
| `polyt init` | First-time setup — choose and download language models |
| `polyt add` | Download additional languages (also repairs incomplete installs) |
| `polyt update` | Re-download latest model versions for all installed languages |
| `polyt remove` | Remove installed language models to free disk space |
| `polyt status` | Show which models are installed and their sizes |

After adding or removing languages, reload the extension in `chrome://extensions` and refresh any open Agent Studio tabs.

### Supported Languages

Arabic, Chinese, Danish, Dutch, English, French, German, Greek, Hebrew, Hindi, Italian, Japanese, Korean, Norwegian, Polish, Portuguese, Romanian, Russian, Serbian, Spanish, Swedish, Thai, Ukrainian, Vietnamese

### Download Sizes

| Tier | Languages | Size |
|------|-----------|------|
| Essential | es, fr, de, pt, it ↔ en | ~350 MB |
| All 24 languages | Full set ↔ en | ~1.5 GB |

## How It Works

### Translation Engine

PolyTranslate uses [Bergamot Translator](https://github.com/browsermt/bergamot-translator), a C++ neural machine translation engine compiled to WebAssembly. The WASM binary runs inside an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) — an invisible extension page that handles all translation work without affecting page performance.

Translation models are provided by the [Mozilla Firefox Translations](https://github.com/mozilla/translations) project.

### English Pivot for Non-English Pairs

All models translate to or from English. For non-English pairs (e.g., Spanish → French), the extension automatically **pivots through English**: it translates Spanish → English, then English → French in a single operation using Bergamot's `translateViaPivoting` function.

This means:
- You need both language pairs installed (e.g., both Spanish and French)
- Quality is slightly lower than a direct model since it's two hops
- For transactional content like customer service transcripts, the pivot quality is solid
- Nuanced or idiomatic text may lose some subtlety through the pivot

### Architecture

```
Content Script (poly.ai page)
  ↓ chrome.runtime.sendMessage
Background Service Worker
  ↓ chrome.runtime.sendMessage
Offscreen Document
  → Bergamot WASM engine (local models, no network)
  ← translated text
```

## Updating

After pulling new changes:

1. Run `polyt update` if models have been refreshed upstream
2. Go to `chrome://extensions` and click the reload icon on the PolyTranslate card
3. **Refresh any open Agent Studio tabs** — required to avoid "Extension context invalidated" errors

## File Structure

```
PolyTranslate/
  manifest.json                  # Extension manifest (MV3)
  background.js                  # Service worker — icon switching + message routing
  config.js                      # Default language settings and language list
  translate.js                   # Thin messaging wrapper for translation requests
  content.js                     # Main content script (UI + all three features)
  offscreen.html                 # Offscreen document shell
  offscreen.js                   # Bergamot WASM engine + model loading
  model-registry.js              # Language pair → model file URL mapping
  styles.css                     # Injected styles for all UI components
  setup.sh                       # CLI for downloading/managing language models
  installed-languages.json       # Auto-generated list of installed languages
  bergamot-translator-worker.js  # Bergamot Emscripten glue code
  bergamot-translator-worker.wasm # Bergamot WASM binary (~5 MB)
  models/                        # Downloaded language models (gitignored)
    es_en/                       # Spanish → English model files
    en_es/                       # English → Spanish model files
    ...
  icons/
    icon16.png / icon48.png / icon128.png       # Color icons
    icon16_bw.png / icon48_bw.png / icon128_bw.png  # Greyscale icons
```

## Troubleshooting

If the PolyTranslate icons turn **red**, the translation engine has encountered an error — usually because the extension's background process was suspended by Chrome. **Refresh the Agent Studio page** to restore it.

## Limitations

- **English pivot:** Non-English language pairs translate via English, which can reduce quality for idiomatic or nuanced text
- **No auto-detect:** Unlike the previous Google Translate version, Bergamot requires you to explicitly select both source and target languages
- **Model size:** Each language pair requires ~20-50 MB of disk space for model files
- **First load:** The WASM engine takes a few seconds to initialize on the first translation after loading the extension

## Authors

**Patrick Swanson** — PolyAI

**Faith Ruetas** — PolyAI
