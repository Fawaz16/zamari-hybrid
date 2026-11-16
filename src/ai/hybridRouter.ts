/**
 * Zamari hybrid router — decides, per request, whether Gemini Nano (on-device)
 * or Cloud Gemini does the work, and records every step (shown only in debug view).
 *
 *  Help Mode
 *   1. Local pattern scrub (emails, phones, cards, IDs, addresses) — always, instant.
 *   2. Classify the request locally (no model call): quick | draft | complex.
 *   3a. quick/draft   → PREFER_ON_DEVICE (fast; SDK falls back to cloud if Nano isn't ready).
 *   3b. complex/brief/live → Nano finds names & other free-form PII → ONLY_IN_CLOUD on the stronger model.
 *       Cloud answers have Google Search grounding, so time-sensitive questions
 *       ("latest", news, weather, prices, scores…) are classified 'live' and sent there.
 *   3c. attachments   → pictures/PDFs/voice notes need multimodal Cloud Gemini; documents are scrubbed first.
 *   4. Clarity Mode: Nano rewrites cloud answers; on-device answers get the rules in-prompt.
 *   5. Placeholders are swapped back to real values locally.
 *
 *  Play Mode
 *   PREFER_ON_DEVICE — Nano when available (zero latency, private, offline-capable);
 *   falls back to Cloud Gemini on devices without Nano (e.g. phones).
 */
import {
  AIError,
  InferenceMode,
  InferenceSource,
  type EnhancedGenerateContentResponse,
  type GenerativeModel,
  type Part,
} from 'firebase/ai';
import type { Attachment } from './attachments';
import { CLOUD_MODEL_COMPLEX, CLOUD_MODEL_FAST, CLOUD_MODEL_IMAGE, getHybridModel, getNanoStatus } from './firebase';
import { imageLimit, imagesLeftToday, recordImageCreated } from './imageQuota';
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
export type HelpIntent = 'quick' | 'draft' | 'complex' | 'live';

/** Live web results the answer was based on (Google Search grounding). */
export interface Grounding {
  sources: { title: string; uri: string }[];
  /** Google's Search Suggestions widget (HTML/CSS). Must be shown with grounded answers. */
  searchSuggestionsHtml?: string;
}

export interface RouteStep {
  label: string;
  engine: Engine | 'local';
  detail?: string;
}

export interface ZamariReply {
  text: string;
  /** Where the main answer was generated. */
  engine: Engine;
  model: string;
  steps: RouteStep[];
  /** Present when anything was masked before leaving the device. */
  privacy?: { masked: Partial<Record<PiiKind, number>>; total: number };
  /** Generated images (base64). */
  images?: { mimeType: string; data: string }[];
  /** Present when the answer used live Google Search results. */
  grounding?: Grounding;
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
type Prompt = string | (string | Part)[];

// ---------------------------------------------------------------------------
// Low-level execution
// ---------------------------------------------------------------------------

interface RunResult {
  text: string;
  engine: Engine;
  grounding?: Grounding;
}

function groundingOf(response: EnhancedGenerateContentResponse): Grounding | undefined {
  const meta = response.candidates?.[0]?.groundingMetadata;
  if (!meta) return undefined;
  const seen = new Set<string>();
  const sources = (meta.groundingChunks ?? [])
    .map((c) => c.web)
    .filter((w): w is { uri: string; title?: string } => !!w?.uri)
    .filter((w) => !seen.has(w.uri) && !!seen.add(w.uri))
    .slice(0, 6)
    .map((w) => ({ uri: w.uri, title: w.title || new URL(w.uri).hostname }));
  const searchSuggestionsHtml = meta.searchEntryPoint?.renderedContent;
  return sources.length || searchSuggestionsHtml ? { sources, searchSuggestionsHtml } : undefined;
}

/**
 * Runs one prompt. Streams partial text through `onText` when provided.
 * The engine comes from the SDK's `inferenceSource`, so routing info reflects
 * what actually happened (including PREFER_ON_DEVICE falling back to the cloud).
 */
async function run(
  model: GenerativeModel,
  mode: InferenceMode,
  prompt: Prompt,
  onText?: (text: string) => void,
): Promise<RunResult> {
  const fallbackEngine: Engine = mode === InferenceMode.ONLY_ON_DEVICE ? 'nano' : 'cloud';
  const engineOf = (src?: InferenceSource): Engine =>
    src ? (src === InferenceSource.ON_DEVICE ? 'nano' : 'cloud') : fallbackEngine;

  if (!onText) {
    const { response } = await model.generateContent(prompt);
    return { text: response.text(), engine: engineOf(response.inferenceSource), grounding: groundingOf(response) };
  }

  const { stream, response } = await model.generateContentStream(prompt);
  let text = '';
  for await (const chunk of stream) {
    text += chunk.text();
    onText(text);
  }
  const final = await response;
  return { text, engine: engineOf(final.inferenceSource), grounding: groundingOf(final) };
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

/** Questions whose answer changes over time — these need live web search in the cloud. */
const LIVE_HINTS =
  /\b(news|headlines?|latest|newest|recent(?:ly)?|currently|current(?:ly)? (?:price|president|prime minister|ceo|champion|leader|status|rate)|right now|tonight|yesterday|this (?:week|weekend|month|season)|weather|forecast|temperature (?:in|outside)|price of|how much (?:is|are|does)|stock|share price|exchange rate|bitcoin|crypto|score|fixtures?|who won|winner|(?:election|match|game|race|exam|lottery) results?|standings|election|released?|release date|coming out|trending|open now|traffic|flights?|update[sd]?)\b|\b20[2-9]\d\b/i;
/** Date/time questions are answered locally from the device clock — no search needed. */
const CLOCK_ONLY = /^\s*(?:what(?:'s| is)?|which)\s+(?:the\s+)?(?:date|day|time|year|month)\b[^?]*\??\s*$/i;

/** True when the user needs current, real-world information. */
export function needsLiveInfo(input: string): boolean {
  return !CLOCK_ONLY.test(input) && LIVE_HINTS.test(input);
}

const IMAGE_HINTS =
  /^\s*(?:please\s+)?(?:draw|paint|sketch|illustrate|imagine)\b|\b(?:create|generate|make|draw|design|render|paint|give me|show me)\b.{0,40}\b(?:image|picture|pic|photo|drawing|illustration|logo|poster|artwork|art|painting|wallpaper|sticker|icon|avatar|cartoon|meme)\b/i;

/** True when the user is asking Zamari to create a picture. */
export function isImageRequest(input: string): boolean {
  return IMAGE_HINTS.test(input);
}

export function classifyHelpRequest(input: string): HelpIntent {
  if (input.length > 700 || /```/.test(input) || COMPLEX_HINTS.test(input)) return 'complex';
  if (DRAFT_HINTS.test(input)) return 'draft';
  if (needsLiveInfo(input)) return 'live';
  return 'quick';
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<Attachment['kind'], string> = {
  image: 'picture',
  pdf: 'PDF',
  document: 'document',
  audio: 'voice note',
};

/** Appends an attachment manifest + (masked) document text to the user's message. */
function withAttachmentText(input: string, attachments: Attachment[], vault: PrivacyVault): string {
  if (!attachments.length) return input;
  const manifest = attachments.map((a) => `${KIND_LABEL[a.kind]} "${a.name}"`).join(', ');
  const docs = attachments
    .filter((a) => a.kind === 'document' && a.text)
    .map((a) => `\n--- Document "${a.name}" ---\n${vault.maskPatterns(a.text!)}\n--- End of document ---`)
    .join('\n');
  return `${input || '(no message — respond to the attachments)'}\n[Attached: ${manifest}]${docs}`;
}

function inlineParts(attachments: Attachment[]): Part[] {
  return attachments
    .filter((a) => a.data)
    .map((a) => ({ type: 'inlineData' as const, inlineData: { mimeType: a.mimeType, data: a.data! } }));
}

const needsCloud = (attachments: Attachment[]) => attachments.some((a) => a.kind !== 'document');

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
  attachments?: Attachment[];
  /** Force the Zafari Lab project-brief escalation. */
  brief?: boolean;
  online: boolean;
  onText?: (text: string) => void;
}

export async function routeHelp(req: HelpRequest): Promise<ZamariReply> {
  if (!req.brief && isImageRequest(req.input)) return routeImage(req);
  const steps: RouteStep[] = [];
  const vault = new PrivacyVault();
  const attachments = req.attachments ?? [];
  const hasAttachments = attachments.length > 0;
  const intent: HelpIntent =
    req.brief || hasAttachments ? 'complex' : classifyHelpRequest(req.input);
  const hasNano = await nanoReady();

  // 1. Pattern scrub — everything below works on masked text; the UI only ever sees revealed text.
  let input = vault.maskPatterns(req.input);
  let history = maskHistory(vault, req.history);
  if (vault.size) steps.push({ label: 'Privacy scrub', engine: 'local', detail: `${vault.size} detail(s) masked by rules` });

  const reveal = (t: string) => vault.reveal(t);
  const stream = req.onText ? (t: string) => req.onText!(reveal(t)) : undefined;

  // 2. Offline: everything must stay on-device.
  if (!req.online) {
    if (needsCloud(attachments)) {
      throw new RouteError('Pictures and voice notes need an internet connection. Try again when you’re back online.', 'offline');
    }
    if (!hasNano) {
      throw new RouteError("You're offline right now. Reconnect and I'll be right here! 📡", 'offline');
    }
    steps.push({ label: 'Offline — kept on-device', engine: 'local' });
    const masked = vault.size > 0;
    const fullInput = withAttachmentText(input, attachments, vault);
    // 'live' questions can't be searched offline; Nano answers and the prompt makes it flag possible staleness.
    const prompt =
      intent === 'complex'
        ? helpComplexPrompt({ input: fullInput, history, clarity: req.clarity, brief: !!req.brief, attachments: hasAttachments })
        : intent === 'draft'
          ? helpDraftPrompt({ input, history, clarity: req.clarity, masked })
          : helpQuickPrompt({ input, history, clarity: req.clarity, masked });
    const model = getHybridModel(InferenceMode.ONLY_ON_DEVICE);
    const res = await run(model, InferenceMode.ONLY_ON_DEVICE, prompt, stream);
    steps.push({ label: intent === 'draft' ? 'Draft message' : 'Answer', engine: res.engine });
    return { text: reveal(res.text), engine: res.engine, model: NANO_LABEL, steps, privacy: privacyInfo(vault) };
  }

  // 3a. Quick / draft → prefer on-device. (If Nano isn't ready, the cloud fallback can still search.)
  if (intent === 'quick' || intent === 'draft') {
    const prompt =
      intent === 'draft'
        ? helpDraftPrompt({ input, history, clarity: req.clarity, masked: vault.size > 0 })
        : helpQuickPrompt({ input, history, clarity: req.clarity, masked: vault.size > 0 });
    const model = getHybridModel(InferenceMode.PREFER_ON_DEVICE, { cloudModel: CLOUD_MODEL_FAST, webSearch: true });
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
      grounding: res.grounding,
    };
  }

  // 3b/3c/3d. Complex, attachments or live info → deep scrub on Nano, then escalate to Cloud Gemini.
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
  const cloudText = helpComplexPrompt({
    input: withAttachmentText(input, attachments, vault),
    history,
    clarity: req.clarity && !nanoClarity,
    brief: !!req.brief,
    attachments: hasAttachments,
    live: intent === 'live',
  });
  const parts = inlineParts(attachments);
  const cloudPrompt: Prompt = parts.length ? [cloudText, ...parts] : cloudText;
  // Live questions only need a quick search-backed answer, so they use the faster model.
  const cloudModelName = intent === 'live' ? CLOUD_MODEL_FAST : CLOUD_MODEL_COMPLEX;
  const cloudModel = getHybridModel(InferenceMode.ONLY_IN_CLOUD, { cloudModel: cloudModelName, webSearch: true });
  const answer = await run(cloudModel, InferenceMode.ONLY_IN_CLOUD, cloudPrompt, nanoClarity ? undefined : stream);
  steps.push({
    label: req.brief
      ? 'Zafari Lab project brief'
      : hasAttachments
        ? 'Answer with attachments'
        : intent === 'live'
          ? 'Live answer'
          : 'Escalated answer',
    engine: answer.engine,
    detail: answer.grounding ? `Searched the web · ${answer.grounding.sources.length} source(s)` : undefined,
  });

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
    model: cloudModelName,
    steps,
    privacy: privacyInfo(vault),
    grounding: answer.grounding,
  };
}

// ---------------------------------------------------------------------------
// Image creation — cloud only, with a daily allowance
// ---------------------------------------------------------------------------

export async function routeImage(req: HelpRequest): Promise<ZamariReply> {
  if (!req.online) throw new RouteError('Creating pictures needs an internet connection 📡', 'offline');
  if (imagesLeftToday() <= 0) {
    throw new RouteError(
      `You’ve used all ${imageLimit} picture creations for today ✨ Your allowance resets tomorrow — but I’m still happy to chat!`,
      'ai',
    );
  }

  const vault = new PrivacyVault();
  const prompt = vault.maskPatterns(req.input);
  const refs = inlineParts((req.attachments ?? []).filter((a) => a.kind === 'image'));
  const instruction =
    'You are Zamari, a playful creative companion. Create one image for this request. ' +
    'Keep it tasteful and family-friendly. Do not add any watermark or signature. ' +
    (refs.length ? 'Use the attached picture(s) as the starting point or reference. ' : '') +
    'Then add one short, fun sentence about what you made.\n\nRequest: ' +
    prompt;

  const model = getHybridModel(InferenceMode.ONLY_IN_CLOUD, { cloudModel: CLOUD_MODEL_IMAGE, imageOutput: true });
  const { response } = await model.generateContent(refs.length ? [instruction, ...refs] : instruction);
  const images = (response.inlineDataParts() ?? [])
    .filter((p) => p.inlineData.mimeType.startsWith('image/'))
    .map((p) => ({ mimeType: p.inlineData.mimeType, data: p.inlineData.data }));

  if (!images.length) {
    throw new RouteError('I couldn’t make that picture — try describing it a little differently? 🎨', 'ai');
  }
  recordImageCreated();
  let caption = '';
  try {
    caption = response.text();
  } catch {
    /* image-only response */
  }
  const left = imagesLeftToday();
  return {
    text: `${vault.reveal(caption.trim()) || 'Here you go! 🎨'}\n\n*${left} picture${left === 1 ? '' : 's'} left today*`,
    engine: 'cloud',
    model: CLOUD_MODEL_IMAGE,
    steps: [{ label: 'Image creation', engine: 'cloud', detail: `${left}/${imageLimit} left today` }],
    images,
    privacy: privacyInfo(vault),
  };
}

// ---------------------------------------------------------------------------
// Play Mode — on-device first
// ---------------------------------------------------------------------------

export interface PlayRequest {
  game: PlayGame;
  input: string;
  history: ChatTurn[];
  clarity: boolean;
  online: boolean;
  attachments?: Attachment[];
  /** 20 Questions: chosen locally so it stays consistent across stateless sessions. */
  secret?: string;
  questionNumber?: number;
  onText?: (text: string) => void;
}

export async function routePlay(req: PlayRequest): Promise<ZamariReply> {
  const attachments = req.attachments ?? [];
  const vault = new PrivacyVault();
  const input = withAttachmentText(req.input, attachments, vault);
  const text = playPrompt({ ...req, input, attachments: attachments.length > 0 });
  const parts = inlineParts(attachments);

  let mode: InferenceMode = InferenceMode.PREFER_ON_DEVICE;
  if (parts.length) {
    if (!req.online) throw new RouteError('Pictures and voice notes need an internet connection.', 'offline');
    mode = InferenceMode.ONLY_IN_CLOUD;
  } else if (!req.online) {
    if (!(await nanoReady())) throw new RouteError("You're offline right now. Reconnect and let's play! 🎮", 'offline');
    mode = InferenceMode.ONLY_ON_DEVICE;
  }

  const model = getHybridModel(mode, { cloudModel: CLOUD_MODEL_FAST, temperature: 0.9 });
  const res = await run(model, mode, parts.length ? [text, ...parts] : text, req.onText);
  return {
    text: res.text,
    engine: res.engine,
    model: modelLabel(res.engine, CLOUD_MODEL_FAST),
    steps: [{ label: 'Play', engine: res.engine }],
  };
}

// ---------------------------------------------------------------------------
// Errors (friendly, and never mention the underlying provider)
// ---------------------------------------------------------------------------

export function describeError(e: unknown): string {
  if (e instanceof RouteError) return e.message;
  if (e instanceof AIError) {
    console.error('[Zamari] AI error', e.code, e.message);
    const msg = e.message.toLowerCase();
    if (msg.includes('app check') || msg.includes('appcheck') || msg.includes('401')) {
      return 'I couldn’t verify this app just now. Please refresh and try again.';
    }
    if (msg.includes('quota') || msg.includes('429')) return 'I’m a little overloaded right now 😅 Give me a moment and try again.';
    if (msg.includes('not found') || msg.includes('404')) return 'That feature isn’t available right now. Please try something else!';
    if (msg.includes('safety') || msg.includes('blocked')) return 'I can’t help with that one — want to try something else?';
    return 'Oops, something glitched on my side. Mind trying that again?';
  }
  if (e instanceof Error) {
    console.error(e);
    return e.message.includes('Firebase') ? 'Zamari isn’t set up correctly yet.' : 'Oops, something went wrong. Please try again.';
  }
  return 'Something went wrong.';
}
