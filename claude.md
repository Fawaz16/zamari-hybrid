# Project: Zamari Hybrid (#BuildHybridAI 2026 Hackathon)

## Overview
Zamari is an everyday, universal AI companion built for every kind of person—combining practical help, accessibility, and Play Mode—designed as a standalone open-source web app that will later integrate into Zafari Lab (zafarilab.com).

## Core Architecture & Hackathon Rules
1. **Firebase AI Logic (Web):** All AI calls MUST go through the official `firebase/ai` SDK using hybrid inference (`InferenceMode.PREFER_ON_DEVICE` for fast/local tasks and `InferenceMode.ONLY_IN_CLOUD` or automatic fallback for complex tasks).
2. **Firebase App Check:** Must be initialised on startup using `firebase/app-check` with debug token support (`self.FIREBASE_APPCHECK_DEBUG_TOKEN`) for local development and hosted testing.
3. **Open Source:** Keep all code clean, modular, and free of proprietary Zafari Lab secrets.

## Key Features
- **Help Mode:** Everyday Q&A, message drafting, and a Zafari Lab project brief escalator (routes complex requests to Cloud Gemini).
- **Clarity Mode (Accessibility):** A toggle that instructs on-device Gemini Nano to rewrite responses into plain English, short dyslexic-friendly bullet points, and zero jargon.
- **Privacy Scrubber:** Runs locally on Gemini Nano to mask PII (names, phone numbers, addresses) before any complex query is sent to Cloud Gemini.
- **Play Mode:** Runs 100% on-device via Gemini Nano for zero-latency interactive stories, riddles, and 20 Questions (also works seamlessly offline).
- **Transparent Routing UI:** Every AI message displays a badge indicating whether it ran on `⚡ Gemini Nano (On-Device)` or `☁️ Cloud Gemini`.
