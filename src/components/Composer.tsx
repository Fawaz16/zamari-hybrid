import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react';
import {
  ACCEPT,
  AttachmentError,
  checkLimits,
  formatDuration,
  MAX_RECORDING_SECONDS,
  readAttachment,
  releaseAttachment,
  startVoiceRecording,
  type Attachment,
  type VoiceRecorder,
} from '../ai/attachments';
import { ArrowUpIcon, CloseIcon, FileIcon, MicIcon, PaperclipIcon, SparkIcon, StopIcon } from './Icons';
import { Orb } from './Orb';

export interface ComposerHandle {
  focus(): void;
  openFilePicker(accept?: string): void;
  addFiles(files: File[]): void;
}

export function Composer(props: {
  busy: boolean;
  placeholder: string;
  draft: string;
  setDraft: (v: string) => void;
  attachments: Attachment[];
  setAttachments: (fn: (a: Attachment[]) => Attachment[]) => void;
  onSend: (opts?: { brief?: boolean }) => void;
  showBrief: boolean;
  handleRef?: (h: ComposerHandle) => void;
}) {
  const { busy, draft, setDraft, attachments, setAttachments } = props;
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState<{ rec: VoiceRecorder; started: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);

  async function addFiles(files: File[]) {
    setError(null);
    try {
      const read = await Promise.all(files.map(readAttachment));
      setAttachments((current) => {
        try {
          checkLimits(current, read);
        } catch (e) {
          read.forEach(releaseAttachment);
          setError((e as Error).message);
          return current;
        }
        return [...current, ...read];
      });
    } catch (e) {
      setError(e instanceof AttachmentError ? e.message : 'Couldn’t read that file.');
    }
  }

  useEffect(() => {
    props.handleRef?.({
      focus: () => textRef.current?.focus(),
      openFilePicker: (accept) => {
        if (!fileRef.current) return;
        fileRef.current.accept = accept ?? ACCEPT;
        fileRef.current.click();
      },
      addFiles: (f) => void addFiles(f),
    });
  });

  // Auto-grow textarea.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  // Recording timer + level meter.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const tick = () => {
      const secs = (Date.now() - recording.started) / 1000;
      setElapsed(secs);
      setLevel(recording.rec.level() * 2.5);
      if (secs >= MAX_RECORDING_SECONDS) void stopRecording();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  async function startRecording() {
    setError(null);
    try {
      const rec = await startVoiceRecording();
      setRecording({ rec, started: Date.now() });
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser settings to record.'
          : (e as Error).message || 'Couldn’t start recording.',
      );
    }
  }

  async function stopRecording() {
    if (!recording) return;
    const { rec } = recording;
    setRecording(null);
    try {
      const note = await rec.stop();
      setAttachments((current) => {
        try {
          checkLimits(current, [note]);
          return [...current, note];
        } catch (e) {
          setError((e as Error).message);
          return current;
        }
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function cancelRecording() {
    recording?.rec.cancel();
    setRecording(null);
  }

  function remove(id: string) {
    setAttachments((current) => {
      const gone = current.find((a) => a.id === id);
      if (gone) releaseAttachment(gone);
      return current.filter((a) => a.id !== id);
    });
  }

  const canSend = !busy && (draft.trim().length > 0 || attachments.length > 0);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (canSend) props.onSend();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  }

  return (
    <>
      {recording && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Recording voice note"
          className="fixed inset-0 z-40 flex flex-col items-center justify-center gap-8 bg-ink/85 px-6 backdrop-blur-xl fade-up"
        >
          <p className="text-sm text-muted">I’m listening… 🎧</p>
          <Orb size={200} active level={level} />
          <p className="font-mono text-3xl font-light tabular-nums" aria-live="off">
            {formatDuration(elapsed)}
          </p>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={cancelRecording}
              className="glass flex h-14 w-14 items-center justify-center rounded-full hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet"
            >
              <CloseIcon />
              <span className="sr-only">Cancel recording</span>
            </button>
            <button
              type="button"
              autoFocus
              onClick={() => void stopRecording()}
              className="bg-gradient-brand glow-brand flex h-20 w-20 items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-pink"
            >
              <StopIcon size={26} />
              <span className="sr-only">Stop and attach voice note</span>
            </button>
            <span className="w-14" aria-hidden="true" />
          </div>
          <p className="text-xs text-muted">Tap stop when you’re done · up to {MAX_RECORDING_SECONDS / 60} minutes</p>
        </div>
      )}

      <form
        onSubmit={submit}
        className="mx-auto w-full max-w-2xl px-4 pt-2 pb-[max(env(safe-area-inset-bottom),12px)]"
        aria-label="Send a message"
      >
        {error && (
          <p role="alert" className="mb-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            {error}
          </p>
        )}

        {props.showBrief && draft.trim().length > 15 && attachments.length === 0 && (
          <div className="mb-2 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => props.onSend({ brief: true })}
              className="glass inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50"
            >
              <SparkIcon size={14} className="text-accent-pink" /> Turn into a project brief
            </button>
          </div>
        )}

        <div className="glass rounded-[28px] p-2 shadow-2xl shadow-black/40">
          {attachments.length > 0 && (
            <ul className="flex gap-2 overflow-x-auto px-1 pt-1 pb-2" aria-label="Attachments">
              {attachments.map((a) => (
                <li key={a.id} className="relative flex-none">
                  {a.kind === 'image' ? (
                    <img src={a.previewUrl} alt={a.name} className="h-16 w-16 rounded-2xl border border-line object-cover" />
                  ) : (
                    <div className="flex h-16 max-w-[200px] items-center gap-2 rounded-2xl border border-line bg-surface px-3">
                      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-gradient-brand text-white">
                        {a.kind === 'audio' ? <MicIcon size={16} /> : <FileIcon size={16} />}
                      </span>
                      <span className="truncate text-xs font-medium">{a.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(a.id)}
                    className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-line bg-ink text-fg hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet"
                  >
                    <CloseIcon size={12} />
                    <span className="sr-only">Remove {a.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!fileRef.current) return;
                fileRef.current.accept = ACCEPT;
                fileRef.current.click();
              }}
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-muted hover:bg-surface-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-40"
            >
              <PaperclipIcon />
              <span className="sr-only">Attach a picture or document</span>
            </button>

            <label htmlFor="message" className="sr-only">
              Message Zamari
            </label>
            <textarea
              id="message"
              ref={textRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={props.placeholder}
              enterKeyHint="send"
              className="max-h-44 min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 text-base text-fg placeholder:text-muted/80 focus:outline-none"
            />

            {canSend ? (
              <button
                type="submit"
                className="bg-gradient-brand glow-brand flex h-11 w-11 flex-none items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-pink"
              >
                <ArrowUpIcon />
                <span className="sr-only">Send</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startRecording()}
                className="bg-gradient-brand glow-brand flex h-11 w-11 flex-none items-center justify-center rounded-full text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-pink disabled:opacity-50"
              >
                {busy ? <span className="dot-pulse scale-75"><span /><span /><span /></span> : <MicIcon />}
                <span className="sr-only">{busy ? 'Zamari is replying' : 'Record a voice note'}</span>
              </button>
            )}
          </div>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void addFiles(files);
          }}
        />
      </form>
    </>
  );
}
