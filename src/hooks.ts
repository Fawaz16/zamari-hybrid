import { useCallback, useEffect, useState } from 'react';
import { getNanoStatus, prepareNano, type NanoStatus } from './ai/firebase';
import { imagesLeftToday } from './ai/imageQuota';

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function useNano() {
  const [status, setStatus] = useState<NanoStatus | 'checking'>('checking');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => setStatus(await getNanoStatus()), []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Chrome may download in the background; poll until it settles.
  useEffect(() => {
    if (status !== 'downloading') return;
    const id = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(id);
  }, [status, refresh]);

  /** Must be called from a click handler (user activation required by Chrome). */
  const enable = useCallback(async () => {
    setError(null);
    setStatus('downloading');
    setProgress(0);
    try {
      await prepareNano((p) => setProgress(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not enable Gemini Nano.');
    } finally {
      setProgress(null);
      await refresh();
    }
  }, [refresh]);

  return { status, progress, error, enable };
}

/** Live count of today's remaining picture creations. */
export function useImagesLeft(): number {
  const [left, setLeft] = useState(imagesLeftToday);
  useEffect(() => {
    const update = () => setLeft(imagesLeftToday());
    window.addEventListener('zamari:quota', update);
    window.addEventListener('focus', update);
    return () => {
      window.removeEventListener('zamari:quota', update);
      window.removeEventListener('focus', update);
    };
  }, []);
  return left;
}

export function usePersistentState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable — keep in memory */
    }
  }, [key, value]);
  return [value, setValue] as const;
}
