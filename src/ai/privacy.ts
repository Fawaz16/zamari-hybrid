/**
 * Local PII masking with reversible placeholders.
 *
 * A `PrivacyVault` swaps sensitive values for tokens like [PHONE_1] before text
 * leaves the device, and swaps them back (`reveal`) when the reply comes home.
 * The same value always maps to the same token, so the cloud model can still
 * reason about "[NAME_1]" consistently across a conversation.
 *
 * Detection has two layers:
 *   1. `maskPatterns` — deterministic rules (emails, phones, cards, IDs, addresses). Instant, always on.
 *   2. `maskSpans`   — free-form spans (names, etc.) found by Gemini Nano in hybridRouter.ts.
 */

export type PiiKind = 'NAME' | 'EMAIL' | 'PHONE' | 'CARD' | 'ID' | 'ADDRESS' | 'DOB' | 'OTHER';

interface Rule {
  kind: PiiKind;
  pattern: RegExp;
  accept?: (match: string) => boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

function passesLuhn(num: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (double && (d *= 2) > 9) d -= 9;
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const STREET_TYPES =
  'Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Way|Boulevard|Blvd|Court|Ct|Place|Pl|Terrace|Crescent|Gardens|Grove|Square|Sq';

// Order matters: more specific rules run first so their matches are not re-matched.
const RULES: Rule[] = [
  { kind: 'EMAIL', pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    kind: 'CARD',
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => passesLuhn(digitsOf(m)),
  },
  { kind: 'ID', pattern: /\b\d{3}-\d{2}-\d{4}\b/g }, // US SSN
  { kind: 'ID', pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi }, // UK NI number
  {
    kind: 'PHONE',
    pattern: /(?:\+\d|\(\d|\b\d)[\d\s().-]{7,}\d\b/g,
    accept: (m) => {
      const n = digitsOf(m).length;
      return n >= 9 && n <= 15;
    },
  },
  {
    kind: 'ADDRESS',
    pattern: new RegExp(`\\b\\d{1,5}[A-Za-z]?\\s+(?:[A-Z][\\w'-]*\\s+){1,3}(?:${STREET_TYPES})\\b\\.?`, 'g'),
  },
  { kind: 'ADDRESS', pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g }, // UK postcode
  {
    kind: 'DOB',
    pattern: /\b(?:born|dob|date of birth)[:\s]+\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/gi,
  },
];

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class PrivacyVault {
  private byValue = new Map<string, string>();
  private byToken = new Map<string, string>();
  private counters = new Map<PiiKind, number>();

  /** Number of distinct values masked so far. */
  get size(): number {
    return this.byToken.size;
  }

  /** Summary like { NAME: 2, PHONE: 1 } for the UI. */
  summary(): Partial<Record<PiiKind, number>> {
    return Object.fromEntries(this.counters);
  }

  private tokenFor(value: string, kind: PiiKind): string {
    const key = value.trim().toLowerCase();
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const token = `[${kind}_${n}]`;
    this.byValue.set(key, token);
    this.byToken.set(token, value.trim());
    return token;
  }

  /** Layer 1: deterministic pattern masking. */
  maskPatterns(text: string): string {
    let out = text;
    for (const rule of RULES) {
      out = out.replace(rule.pattern, (match) =>
        rule.accept && !rule.accept(match) ? match : this.tokenFor(match, rule.kind),
      );
    }
    return out;
  }

  /** Layer 2: mask exact spans (e.g. names found by Gemini Nano). Ignores spans not present in the text. */
  maskSpans(text: string, spans: { text: string; kind: PiiKind }[]): string {
    let out = text;
    // Longest first so "Jane Doe" is masked before "Jane".
    const sorted = [...spans].sort((a, b) => b.text.length - a.text.length);
    for (const { text: span, kind } of sorted) {
      const value = span.trim();
      if (value.length < 2 || /^\[[A-Z]+_\d+\]$/.test(value)) continue;
      const re = new RegExp(`(?<![\\w[])${escapeRegExp(value)}(?![\\w\\]])`, 'gi');
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      out = out.replace(re, () => this.tokenFor(value, kind));
    }
    return out;
  }

  /** Restores original values. Runs locally on the reply after it returns. */
  reveal(text: string): string {
    return text.replace(/\[([A-Z]+)_(\d+)\]/g, (token) => this.byToken.get(token) ?? token);
  }
}
