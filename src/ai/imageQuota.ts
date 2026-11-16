/**
 * Daily image-creation allowance, stored per browser.
 *
 * This is a friendly, client-side limit that keeps casual usage (and cost) in
 * check. It is NOT a security boundary — a determined user can clear storage.
 * For hard enforcement, pair it with a Firebase budget alert / API quota cap in
 * Google Cloud, or move image generation behind a server function keyed to a
 * signed-in user.
 */
import { IMAGE_DAILY_LIMIT } from './firebase';

const KEY = 'zamari.imageQuota';

interface QuotaState {
  day: string;
  used: number;
}

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

function read(): QuotaState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as QuotaState | null;
    if (s && s.day === today()) return s;
  } catch {
    /* storage unavailable */
  }
  return { day: today(), used: 0 };
}

export const imageLimit = IMAGE_DAILY_LIMIT;

export function imagesLeftToday(): number {
  return Math.max(0, IMAGE_DAILY_LIMIT - read().used);
}

/** Records one successful creation. Only call after an image actually arrives. */
export function recordImageCreated(): void {
  const s = read();
  try {
    localStorage.setItem(KEY, JSON.stringify({ day: s.day, used: s.used + 1 }));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event('zamari:quota'));
}
