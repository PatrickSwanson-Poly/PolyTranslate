# PolyTranslate

A Chrome extension that adds inline translation to PolyAI Agent Studio, helping designers, engineers, executives, clients, and anyone else using Studio review and interact with multilingual agents without switching to external translation tools.

## Features

### Conversation Transcript Translation
Translate completed conversation transcripts inline. Click the **PolyTranslate** button in the sidebar, select source/target languages, and hit **Translate**. Only messages that actually changed get a language badge. Toggle translation off to restore the originals.

### Live Chat Translation
Toggle **Live** mode from the sidebar to auto-translate incoming agent and caller messages in real time during a chat session. Works alongside the conversation review panel.

### Input Auto-Translator
A green translate button sits above the send arrow in the chat textarea. Click it to select a target language and translate your typed input before sending. Useful for typing in English and sending in Spanish (or any other language).

**Keyboard shortcut:** `Cmd+Shift+Y` (Mac) / `Ctrl+Shift+Y` (Windows/Linux)

### Language Support
26 languages available with auto-detect as the default source. Language selections persist across sessions via Chrome storage.

Arabic, Chinese, Danish, Dutch, English, French, German, Greek, Hebrew, Hindi, Italian, Japanese, Korean, Norwegian, Polish, Portuguese, Romanian, Russian, Serbian, Spanish, Swedish, Thai, Turkish, Ukrainian, Vietnamese

### Adaptive Extension Icon
The toolbar icon shows the full-color PolyTranslate logo on `*.poly.ai` pages and switches to a greyed-out version on all other sites.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `PolyTranslate` folder
5. Navigate to any Agent Studio page on `studio.us.poly.ai`

## How It Works

- **Translation API:** Uses Google Translate's free endpoint (`translate.googleapis.com/translate_a/single`) -- no API key required
- **Sidebar integration:** PolyTranslate adds a menu item to the Agent Studio sidebar (above Studio Assistant) with a popover for language selection and translate controls
- **Non-destructive:** All translations are reversible. Original text is preserved in memory and restored when translation is toggled off
- **Click isolation:** All injected UI stops event propagation to prevent interfering with Agent Studio's panel open/close behavior

## Updating

After pulling new changes:

1. Go to `chrome://extensions`
2. Click the reload icon on the PolyTranslate card
3. **Refresh any open Agent Studio tabs** -- this is required, otherwise you'll see "Extension context invalidated" errors in the console

## File Structure

```
PolyTranslate/
  manifest.json       # Extension manifest (Manifest V3)
  background.js       # Service worker for adaptive icon switching
  config.js           # Default language settings and language list
  translate.js        # Google Translate API utility functions
  content.js          # Main content script (all three features)
  styles.css          # Injected styles for all UI components
  icons/
    icon16.png        # Color icon (16x16)
    icon48.png        # Color icon (48x48)
    icon128.png       # Color icon (128x128)
    icon16_bw.png     # Greyscale icon (16x16)
    icon48_bw.png     # Greyscale icon (48x48)
    icon128_bw.png    # Greyscale icon (128x128)
```

## Limitations

- **Regional variants:** Google Translate doesn't support regional language variants (e.g. `es-MX` vs `es-ES`). Spanish output tends toward neutral Latin American Spanish.
- **Free API:** The free Google Translate endpoint has no SLA and may rate-limit under heavy use. Each message is translated as a separate request.

## Author

**Patrick Swanson** - PolyAI
