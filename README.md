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
