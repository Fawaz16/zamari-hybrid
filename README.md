# Zamari Hybrid

An everyday, accessible AI companion built on **Firebase AI Logic hybrid inference**. It uses Gemini Nano on the device when it can and Cloud Gemini when a task needs it.

Every answer shows a badge: **⚡ Gemini Nano (On-Device)** or **☁️ Cloud Gemini**. The badge comes from the SDK's `inferenceSource`, so it reports where the answer actually ran, including when the SDK falls back to the cloud.

## Features

| Feature | Where it runs |
| --- | --- |
| **Help Mode**: quick Q&A, message drafting | `PREFER_ON_DEVICE` (falls back to `gemini-3.5-flash-lite`) |
| **Complex requests / Zafari Lab project brief** | `ONLY_IN_CLOUD` (`gemini-3.6-flash`), after the privacy scrub |
| **Privacy Scrubber** | Local rules (email, phone, card, ID, address) **plus** Gemini Nano for names and other free-form details. Placeholders like `[NAME_1]` are swapped back locally when the reply arrives. |
| **Clarity Mode** | Nano rewrites cloud answers into short, plain bullets. For on-device answers, the rules go into the prompt. |
| **Play Mode**: Story, Riddles, 20 Questions | `ONLY_ON_DEVICE`: private, low latency, works offline |

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your Firebase web app config
npm run dev
```

1. **Firebase console → AI Logic**: enable the Gemini Developer API.
2. **App Check**: register the web app with reCAPTCHA Enterprise and put the site key in `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY`.
3. **Debug token (local dev)**: run `npm run dev` and copy the token the console prints (`Firebase App Check debug token: …`). Register it under *App Check → Apps → Manage debug tokens*. You can then set it as `VITE_APPCHECK_DEBUG_TOKEN` so it is reused. For hosted test builds, set a registered token in that variable. Never ship one in a public build.
4. **Gemini Nano**: use desktop Chrome with built-in AI (Prompt API) available. Click **Enable Gemini Nano** in the status bar. The download has to start from a click.

## Code map

- `src/ai/firebase.ts`: App + App Check (debug token) + `getAI`, the hybrid model factory, and Nano status and download.
- `src/ai/hybridRouter.ts`: routing for Help, Clarity, Privacy and Play, with a step trace for the UI.
- `src/ai/privacy.ts`: reversible PII masking (`PrivacyVault`).
- `src/ai/prompts.ts`: self-contained prompts. Nano ignores `systemInstruction` and has no memory between calls.
- `src/App.tsx`: accessible UI with a mode switcher, Clarity toggle and routing badges.

## Try it

- **Hackathon edition** (this branch, `main`: Firebase AI Logic + Gemini only): https://zamari-hackathon.vercel.app
- **Zafari Lab edition** (branch [`zafari`](../../tree/zafari): Claude + sign-in and plans): https://zamari.zafarilab.com
- **Demo video:** _link coming soon_

Gemini Nano runs only in desktop Chrome with built-in AI turned on. In other browsers, Zamari falls back to the cloud automatically, and the badge on each answer shows where it ran.

## AI tools disclosure

**AI inside the product**
- **Gemini Nano** (on-device, through Chrome's Prompt API via Firebase AI Logic hybrid inference): Play Mode, the Privacy Scrubber, Clarity rewrites and quick answers.
- **Cloud Gemini** (`gemini-3.5-flash-lite`, `gemini-3.6-flash` through Firebase AI Logic): complex requests and fallback when Nano isn't available.
- **Zafari Lab edition only:** **Claude Haiku 5.5** and **Claude Sonnet 5.5** (Anthropic API) for cloud chat and reasoning. **Gemini Flash** and **Gemini Flash Image** handle long PDFs, voice-note transcription and image creation.

**AI used to build it**
- **Claude Code** (Anthropic) helped write code, debug, review and write documentation. Commits it helped with carry a `Co-Authored-By: Claude` line. The product idea, design decisions, testing and direction are the team's own.

## Team

- Fawaz Rufai ([@Fawaz16](https://github.com/Fawaz16))

## License

[MIT](LICENSE)
