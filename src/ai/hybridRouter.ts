/**
 * Zamari hybrid router — decides, per request, whether Gemini Nano (on-device)
 * or Cloud Gemini does the work, and records every step for the UI.
 *
 *  Help Mode
 *   1. Local pattern scrub (emails, phones, cards, IDs, addresses) — always, instant.
 *   2. Classify the request locally (no model call): quick | draft | complex.
 *   3a. quick/draft  → PREFER_ON_DEVICE (fast; SDK falls back to cloud if Nano isn't ready).
 *   3b. complex/brief → Nano finds names & other free-form PII → ONLY_IN_CLOUD on the stronger model.
 *   4. Clarity Mode: Nano rewrites cloud answers; on-device answers get the rules in-prompt.
 *   5. Placeholders are swapped back to real values locally.
 *
 *  Play Mode
 *   ONLY_ON_DEVICE — zero-latency, private, works offline. Never touches the cloud.
 */
import { AIError, InferenceMode, InferenceSource, type GenerativeModel } from 'firebase/ai';
import { CLOUD_MODEL_COMPLEX, CLOUD_MODEL_FAST, getHybridModel, getNanoStatus } from './firebase';
import { PrivacyVault, type PiiKind } from './privacy';
import {
  clarityRewritePrompt,
  helpComplexPrompt,
  helpDraftPrompt,
  helpQuickPrompt,
  PII_SCHEMA,
  piiDetectPrompt,
  playPrompt,
  transcript,
  type ChatTurn,
  type PlayGame,
} from './prompts';

export type { ChatTurn, PlayGame };
export type Engine = 'nano' | 'cloud';
export type HelpIntent = 'quick' | 'draft' | 'complex';

export interface RouteStep {
  label: string;
  engine: Engine | 'local';
  detail?: string;
}

export interface ZamariReply {
  text: string;
  /** Where the main answer was generated — drives the badge. */
  engine: Engine;
  model: string;
  steps: RouteStep[];
  /** Present when anything was masked before leaving the device. */
  privacy?: { masked: Partial<Record<PiiKind, number>>; total: number };
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly kind: 'nano-required' | 'offline' | 'ai',
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

const NANO_LABEL = 'Gemini Nano';

// ---------------------------------------------------------------------------
// Low-level execution
// ---------------------------------------------------------------------------

interface RunResult {
  text: string;
  engine: Engine;
}

/**
 * Runs one prompt. Streams partial text through `onText` when provided.
 * The engine comes from the SDK's `inferenceSource`, so badges reflect what
 * actually happened (including PREFER_ON_DEVICE falling back to the cloud).
 */
async function run(
  model: GenerativeModel,
  mode: InferenceMode,
  prompt: string,
  onText?: (text: string) => void,
): Promise<RunResult> {
  const fallbackEngine: Engine = mode === InferenceMode.ONLY_ON_DEVICE ? 'nano' : 'cloud';
  const engineOf = (src?: InferenceSource): Engine =>
    src ? (src === InferenceSource.ON_DEVICE ? 'nano' : 'cloud') : fallbackEngine;

  if (!onText) {
    const { response } = await model.generateContent(prompt);
    return { text: response.text(), engine: engineOf(response.inferenceSource) };
  }

  const { stream, response } = await model.generateContentStream(prompt);
  let text = '';
  for await (const chunk of stream) {
    text += chunk.text();
    onText(text);
  }
  const final = await response;
  return { text, engine: engineOf(final.inferenceSource) };
}

const modelLabel = (engine: Engine, cloudModel: string) => (engine === 'nano' ? NANO_LABEL : cloudModel);

async function nanoReady(): Promise<boolean> {
  return (await getNanoStatus()) === 'available';
}

// ---------------------------------------------------------------------------
// Classification (local heuristics — no model call, zero latency)
// ---------------------------------------------------------------------------

const COMPLEX_HINTS =
  /\b(project brief|zafari|business plan|proposal|strategy|roadmap|architecture|research|in[- ]depth|detailed|analy[sz]e|analysis|compare|pros and cons|step[- ]by[- ]step plan|itinerary|curriculum|budget|build (?:me )?(?:an?|the|my) (?:app|website|platform|product|startup))\b/i;
const DRAFT_HINTS =
  /\b(draft|write|reply|respond|rephrase|reword|email|message|text (?:to|for)|letter|note to|cover letter|caption|apologi[sz]e)\b/i;

export function classifyHelpRequest(input: string): HelpIntent {
  if (input.length > 700 || /```/.test(input) || COMPLEX_HINTS.test(input)) return 'complex';
  if (DRAFT_HINTS.test(input)) return 'draft';
  return 'quick';
}

// ---------------------------------------------------------------------------
// Privacy scrubbing
// ---------------------------------------------------------------------------

/** Nano pass: detects free-form PII (names etc.) that patterns can't catch. Runs ONLY on-device. */
async function detectPiiOnDevice(text: string): Promise<{ text: string; kind: PiiKind }[]> {
  const model = getHybridModel(InferenceMode.ONLY_ON_DEVICE, { onDeviceJsonSchema: PII_SCHEMA });
  const { text: raw } = await run(model, InferenceMode.ONLY_ON_DEVICE, piiDetectPrompt(text));
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(json) as { items?: { text?: unknown; kind?: unknown }[] };
  return (parsed.items ?? [])
    .filter((i): i is { text: string; kind: PiiKind } => typeof i.text === 'string' && typeof i.kind === 'string')
    .slice(0, 50);
}

function maskHistory(vault: PrivacyVault, history: ChatTurn[]): ChatTurn[] {
  return history.map((t) => ({ ...t, text: vault.maskPatterns(t.text) }));
}

function privacyInfo(vault: PrivacyVault): ZamariReply['privacy'] {
  return vault.size ? { masked: vault.summary(), total: vault.size } : undefined;
}

// ---------------------------------------------------------------------------
// Help Mode
// ---------------------------------------------------------------------------

export interface HelpRequest {
  input: string;
  history: ChatTurn[];
  clarity: boolean;
  /** Force the Zafari Lab project-brief escalation. */
  brief?: boolean;
  online: boolean;
  onText?: (text: string) => void;
}

export async function routeHelp(req: HelpRequest): Promise<ZamariReply> {
  const steps: RouteStep[] = [];
  const vault = new PrivacyVault();
  const intent: HelpIntent = req.brief ? 'complex' : classifyHelpRequest(req.input);
  const hasNano = await nanoReady();

  // 1. Pattern scrub — everything below works on masked text; the UI only ever sees revealed text.
  let input = vault.maskPatterns(req.input);
  let history = maskHistory(vault, req.history);
  if (vault.size) steps.push({ label: 'Privacy scrub', engine: 'local', detail: `${vault.size} detail(s) masked by rules` });

  const reveal = (t: string) => vault.reveal(t);
  const stream = req.onText ? (t: string) => req.onText!(reveal(t)) : undefined;

  // 2. Offline: everything must stay on-device.
  if (!req.online) {
    if (!hasNano) {
      throw new RouteError("You're offline and Gemini Nano isn't set up on this device yet.", 'offline');
    }
    steps.push({ label: 'Offline — kept on-device', engine: 'local' });
    const masked = vault.size > 0;
    const prompt =
      intent === 'complex'
        ? helpComplexPrompt({ input, history, clarity: req.clarity, brief: !!req.brief })
        : intent === 'draft'
          ? helpDraftPrompt({ input, history, clarity: req.clarity, masked })
          : helpQuickPrompt({ input, history, clarity: req.clarity, masked });
    const model = getHybridModel(InferenceMode.ONLY_ON_DEVICE);
    const res = await run(model, InferenceMode.ONLY_ON_DEVICE, prompt, stream);
    steps.push({ label: intent === 'draft' ? 'Draft message' : 'Answer', engine: res.engine });
    return { text: reveal(res.text), engine: res.engine, model: NANO_LABEL, steps, privacy: privacyInfo(vault) };
  }

  // 3a. Quick / draft → prefer on-device.
  if (intent !== 'complex') {
    const prompt =
      intent === 'draft'
        ? helpDraftPrompt({ input, history, clarity: req.clarity, masked: vault.size > 0 })
        : helpQuickPrompt({ input, history, clarity: req.clarity, masked: vault.size > 0 });
    const model = getHybridModel(InferenceMode.PREFER_ON_DEVICE, { cloudModel: CLOUD_MODEL_FAST });
    const res = await run(model, InferenceMode.PREFER_ON_DEVICE, prompt, stream);
    steps.push({
      label: intent === 'draft' ? 'Draft message' : 'Answer',
      engine: res.engine,
      detail: res.engine === 'cloud' ? 'Nano not ready — fell back to cloud' : undefined,
    });
    return {
      text: reveal(res.text),
      engine: res.engine,
      model: modelLabel(res.engine, CLOUD_MODEL_FAST),
      steps,
      privacy: privacyInfo(vault),
    };
  }

  // 3b. Complex → deep scrub on Nano, then escalate to Cloud Gemini.
  if (hasNano) {
    try {
      const context = `${transcript(history, 4)}\nUser: ${input}`.slice(-3000);
      const before = vault.size;
      const spans = await detectPiiOnDevice(context);
      input = vault.maskSpans(input, spans);
      history = history.map((t) => ({ ...t, text: vault.maskSpans(t.text, spans) }));
      steps.push({ label: 'Privacy scrub', engine: 'nano', detail: `${vault.size - before} more detail(s) masked` });
    } catch (e) {
      console.warn('[Zamari] Nano PII scan failed; continuing with rule-based masking only.', e);
      steps.push({ label: 'Privacy scrub', engine: 'local', detail: 'Nano scan failed — rules only' });
    }
  } else {
    steps.push({ label: 'Privacy scrub', engine: 'local', detail: 'Nano unavailable — names not scanned' });
  }

  // When Nano can do the Clarity rewrite, ask the cloud for a normal answer; otherwise fold the rules into the cloud prompt.
  const nanoClarity = req.clarity && hasNano;
  const cloudPrompt = helpComplexPrompt({ input, history, clarity: req.clarity && !nanoClarity, brief: !!req.brief });
  const cloudModel = getHybridModel(InferenceMode.ONLY_IN_CLOUD, { cloudModel: CLOUD_MODEL_COMPLEX });
  const answer = await run(cloudModel, InferenceMode.ONLY_IN_CLOUD, cloudPrompt, nanoClarity ? undefined : stream);
  steps.push({ label: req.brief ? 'Zafari Lab project brief' : 'Escalated answer', engine: answer.engine });

  let finalText = answer.text;
  if (nanoClarity) {
    try {
      const rewriter = getHybridModel(InferenceMode.ONLY_ON_DEVICE);
      const rewritten = await run(rewriter, InferenceMode.ONLY_ON_DEVICE, clarityRewritePrompt(answer.text), stream);
      finalText = rewritten.text;
      steps.push({ label: 'Clarity rewrite', engine: 'nano' });
    } catch (e) {
      console.warn('[Zamari] Clarity rewrite failed; showing original answer.', e);
      stream?.(answer.text);
    }
  }

  return {
    text: reveal(finalText),
    engine: answer.engine,
    model: CLOUD_MODEL_COMPLEX,
    steps,
    privacy: privacyInfo(vault),
  };
}

// ---------------------------------------------------------------------------
// Play Mode — 100% on-device
// ---------------------------------------------------------------------------

export interface PlayRequest {
  game: PlayGame;
  input: string;
  history: ChatTurn[];
  clarity: boolean;
  /** 20 Questions: chosen locally so it stays consistent across stateless Nano sessions. */
  secret?: string;
  questionNumber?: number;
  onText?: (text: string) => void;
}

export async function routePlay(req: PlayRequest): Promise<ZamariReply> {
  if (!(await nanoReady())) {
    throw new RouteError(
      'Play Mode runs only on-device. Enable Gemini Nano (Chrome desktop) to play — nothing is sent to the cloud.',
      'nano-required',
    );
  }
  const model = getHybridModel(InferenceMode.ONLY_ON_DEVICE, { temperature: 0.9 });
  const res = await run(model, InferenceMode.ONLY_ON_DEVICE, playPrompt(req), req.onText);
  return { text: res.text, engine: 'nano', model: NANO_LABEL, steps: [{ label: 'Play', engine: 'nano' }] };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function describeError(e: unknown): string {
  if (e instanceof RouteError) return e.message;
  if (e instanceof AIError) {
    const msg = e.message.toLowerCase();
    if (msg.includes('app check') || msg.includes('appcheck')) {
      return 'App Check rejected the request. In dev, register the debug token printed in the console.';
    }
    if (msg.includes('quota') || msg.includes('429')) return 'Cloud Gemini is busy right now. Please try again shortly.';
    if (msg.includes('api_not_enabled') || msg.includes('not enabled')) {
      return 'Firebase AI Logic is not enabled for this project yet (Firebase console → AI Logic).';
    }
    return `AI error: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}
