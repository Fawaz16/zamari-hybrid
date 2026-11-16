/**
 * Attachments: pictures, documents and voice notes (no video).
 *
 * - Images, PDFs and voice notes are sent to Gemini as inline data.
 * - Text-like documents (.txt, .md, .csv, .json, .docx) are read locally into
 *   text, so the privacy scrubber can mask them before anything leaves the device.
 */

export type AttachmentKind = 'image' | 'pdf' | 'document' | 'audio';

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  /** Base64 payload for image / pdf / audio. */
  data?: string;
  /** Extracted text for documents. */
  text?: string;
  /** Object URL for image thumbnails and audio playback. */
  previewUrl?: string;
  /** Voice note length in seconds. */
  duration?: number;
}

export const MAX_ATTACHMENTS = 5;
const MAX_FILE_BYTES = 7 * 1024 * 1024; // inline request limit is ~20 MB after base64
const MAX_TOTAL_BYTES = 14 * 1024 * 1024;
const MAX_DOC_CHARS = 40_000;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|rtf|html?)$/i;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Value for <input accept>. Deliberately excludes video. */
export const ACCEPT =
  'image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf,.pdf,' +
  '.txt,.md,.csv,.tsv,.json,.log,.docx,text/plain,text/markdown,text/csv,application/json,' +
  DOCX_MIME;

export class AttachmentError extends Error {}

const newId = () => crypto.randomUUID();

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function clip(text: string): string {
  return text.length > MAX_DOC_CHARS ? `${text.slice(0, MAX_DOC_CHARS)}\n…[document truncated]` : text;
}

export async function readAttachment(file: File): Promise<Attachment> {
  const type = file.type.toLowerCase();
  if (type.startsWith('video/')) throw new AttachmentError('Videos aren’t supported — try a picture or document instead.');
  if (file.size > MAX_FILE_BYTES) throw new AttachmentError(`“${file.name}” is over 7 MB.`);

  const base = { id: newId(), name: file.name, size: file.size };

  if (IMAGE_TYPES.includes(type)) {
    return { ...base, kind: 'image', mimeType: type, data: await blobToBase64(file), previewUrl: URL.createObjectURL(file) };
  }
  if (type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    return { ...base, kind: 'pdf', mimeType: 'application/pdf', data: await blobToBase64(file) };
  }
  if (type === DOCX_MIME || /\.docx$/i.test(file.name)) {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { ...base, kind: 'document', mimeType: 'text/plain', text: clip(value) };
  }
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT.test(file.name)) {
    return { ...base, kind: 'document', mimeType: 'text/plain', text: clip(await file.text()) };
  }
  throw new AttachmentError(`“${file.name}” isn’t a supported type. Use a picture, PDF, Word or text file.`);
}

export function checkLimits(existing: Attachment[], incoming: Attachment[]): void {
  if (existing.length + incoming.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`);
  }
  const total = [...existing, ...incoming].reduce((n, a) => n + a.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new AttachmentError('Those files are too big together (14 MB max).');
}

export function releaseAttachment(a: Attachment): void {
  if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
}

// ---------------------------------------------------------------------------
// Voice notes — recorded as 16 kHz mono WAV, which Gemini accepts on every
// browser (MediaRecorder's webm/mp4 output varies by platform).
// ---------------------------------------------------------------------------

const TARGET_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 120;

export interface VoiceRecorder {
  stop(): Promise<Attachment>;
  cancel(): void;
  /** 0–1 input level for the live meter. */
  level(): number;
}

export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new AttachmentError('Voice recording isn’t supported in this browser.');
  }
  // Create + resume the AudioContext synchronously inside the tap handler:
  // iOS Safari leaves it suspended (recording silence) if this happens after an await.
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const resumed = ctx.resume();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    await resumed;
  } catch (e) {
    void ctx.close();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally supported (incl. iOS Safari) and fine for short notes.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let lastLevel = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    let peak = 0;
    for (let i = 0; i < input.length; i += 64) peak = Math.max(peak, Math.abs(input[i]));
    lastLevel = peak;
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  const cleanup = () => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return {
    level: () => lastLevel,
    cancel: cleanup,
    async stop() {
      const rate = ctx.sampleRate;
      cleanup();
      const samples = downsample(concat(chunks), rate, TARGET_RATE);
      if (samples.length < TARGET_RATE * 0.5) throw new AttachmentError('That recording was too short.');
      const blob = encodeWav(samples, TARGET_RATE);
      const duration = Math.round(samples.length / TARGET_RATE);
      return {
        id: newId(),
        name: `Voice note (${formatDuration(duration)})`,
        kind: 'audio',
        mimeType: 'audio/wav',
        size: blob.size,
        data: await blobToBase64(blob),
        previewUrl: URL.createObjectURL(blob),
        duration,
      };
    },
  };
}

export const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
