import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { isFirebaseConfigured } from './ai/firebase';
import {
  describeError,
  routeHelp,
  routePlay,
  type ChatTurn,
  type PlayGame,
  type ZamariReply,
} from './ai/hybridRouter';
import { PLAY_GAMES, pickSecret } from './ai/prompts';
import { Markdown } from './components/Markdown';
import { RouteDetails } from './components/RouteBadge';
import { useNano, useOnline, usePersistentState } from './hooks';

type AppMode = 'help' | 'play';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  reply?: ZamariReply;
  pending?: boolean;
}

const HELP_SUGGESTIONS = [
  'What can I cook with eggs, spinach and rice?',
  'Draft a friendly text saying I’ll be 10 minutes late',
  'Explain what a credit score is',
];

const newId = () => crypto.randomUUID();

export default function App() {
  const [mode, setMode] = usePersistentState<AppMode>('zamari.mode', 'help');
  const [clarity, setClarity] = usePersistentState('zamari.clarity', false);
  const [game, setGame] = useState<PlayGame>('story');
  const [secret, setSecret] = useState(pickSecret);
  const [threads, setThreads] = useState<Record<AppMode, Message[]>>({ help: [], play: [] });
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const nano = useNano();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = threads[mode];

  useEffect(() => {
    document.documentElement.classList.toggle('clarity', clarity);
  }, [clarity]);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    endRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' });
  }, [messages]);

  const patch = (m: AppMode, id: string, update: Partial<Message>) =>
    setThreads((t) => ({ ...t, [m]: t[m].map((msg) => (msg.id === id ? { ...msg, ...update } : msg)) }));

  async function send(text: string, opts: { brief?: boolean } = {}) {
    const input = text.trim();
    if (!input || busy) return;
    const m = mode;
    const history: ChatTurn[] = threads[m]
      .filter((x) => x.role !== 'error' && !x.pending)
      .map((x) => ({ role: x.role as ChatTurn['role'], text: x.text }));
    const replyId = newId();

    setThreads((t) => ({
      ...t,
      [m]: [...t[m], { id: newId(), role: 'user', text: input }, { id: replyId, role: 'assistant', text: '', pending: true }],
    }));
    setDraft('');
    setBusy(true);

    const onText = (t: string) => patch(m, replyId, { text: t });
    try {
      const reply =
        m === 'help'
          ? await routeHelp({ input, history, clarity, brief: opts.brief, online, onText })
          : await routePlay({
              game,
              input,
              history,
              clarity,
              secret,
              questionNumber: history.filter((h) => h.role === 'user').length + 1,
              onText,
            });
      patch(m, replyId, { text: reply.text, reply, pending: false });
    } catch (e) {
      console.error(e);
      patch(m, replyId, { role: 'error', text: describeError(e), pending: false });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  function chooseGame(g: PlayGame) {
    setGame(g);
    setSecret(pickSecret());
    setThreads((t) => ({ ...t, play: [] }));
  }

  function clearThread() {
    setThreads((t) => ({ ...t, [mode]: [] }));
    if (mode === 'play') setSecret(pickSecret());
  }

  return (
    <div className="flex min-h-dvh flex-col bg-stone-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#composer"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-teal-700 focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to message box
      </a>

      <Header
        mode={mode}
        setMode={setMode}
        clarity={clarity}
        setClarity={setClarity}
        disabled={busy}
      />

      <StatusBar online={online} nano={nano} />

      {!isFirebaseConfigured && (
        <div role="alert" className="mx-auto mt-3 w-full max-w-3xl px-4">
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            <strong>Setup needed:</strong> copy <code>.env.example</code> to <code>.env.local</code> and add your Firebase
            web app config, then restart <code>npm run dev</code>.
          </div>
        </div>
      )}

      {mode === 'play' && (
        <nav aria-label="Choose a game" className="mx-auto mt-3 flex w-full max-w-3xl flex-wrap gap-2 px-4">
          {(Object.keys(PLAY_GAMES) as PlayGame[]).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={game === g}
              disabled={busy}
              onClick={() => chooseGame(g)}
              className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50 aria-pressed:border-teal-700 aria-pressed:bg-teal-700 aria-pressed:text-white dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <span aria-hidden="true">{PLAY_GAMES[g].emoji}</span> {PLAY_GAMES[g].label}
            </button>
          ))}
        </nav>
      )}

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-4">
        <section aria-label={`${mode === 'help' ? 'Help' : 'Play'} conversation`} aria-live="polite" aria-busy={busy} className="flex-1 space-y-4">
          {messages.length === 0 ? (
            <EmptyState mode={mode} game={game} onPick={(s) => void send(s)} disabled={busy} />
          ) : (
            messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)
          )}
          <div ref={endRef} />
        </section>
      </main>

      <footer className="sticky bottom-0 border-t border-slate-200 bg-stone-50/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
        <form id="composer" onSubmit={onSubmit} className="mx-auto w-full max-w-3xl px-4 py-3">
          <label htmlFor="message" className="sr-only">
            Message Zamari
          </label>
          <div className="flex items-end gap-2">
            <textarea
              id="message"
              ref={inputRef}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={mode === 'help' ? 'Ask anything, or ask me to draft a message…' : 'Your move…'}
              className="min-h-12 flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-2 text-base shadow-sm placeholder:text-slate-500 focus:border-teal-600 focus:outline-2 focus:outline-teal-600/40 dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="submit"
              disabled={busy || !draft.trim()}
              className="h-12 rounded-xl bg-teal-700 px-5 font-semibold text-white shadow-sm hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? 'Thinking…' : 'Send'}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
            <span>
              Enter to send · Shift+Enter for a new line
              {mode === 'play' && ' · Play Mode never leaves your device'}
            </span>
            <div className="flex gap-2">
              {mode === 'help' && (
                <button
                  type="button"
                  disabled={busy || !draft.trim() || !online}
                  onClick={() => void send(draft, { brief: true })}
                  title="Turns your idea into a structured project brief using Cloud Gemini (private details are masked first)"
                  className="rounded-lg border border-sky-300 px-2.5 py-1 font-semibold text-sky-900 hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-teal-600 disabled:opacity-50 dark:border-sky-800 dark:text-sky-200 dark:hover:bg-sky-950"
                >
                  ☁️ Make Zafari Lab brief
                </button>
              )}
              {messages.length > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={clearThread}
                  className="rounded-lg px-2.5 py-1 font-semibold hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-teal-600 disabled:opacity-50 dark:hover:bg-slate-800"
                >
                  {mode === 'play' ? 'New game' : 'Clear chat'}
                </button>
              )}
            </div>
          </div>
        </form>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header(props: {
  mode: AppMode;
  setMode: (m: AppMode) => void;
  clarity: boolean;
  setClarity: (v: boolean) => void;
  disabled: boolean;
}) {
  const clarityId = useId();
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <div>
            <h1 className="text-lg font-bold leading-tight">Zamari</h1>
            <p className="text-xs text-slate-600 dark:text-slate-400">Your everyday companion</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div role="radiogroup" aria-label="Mode" className="flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
            {(['help', 'play'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={props.mode === m}
                disabled={props.disabled}
                onClick={() => props.setMode(m)}
                className="rounded-lg px-4 py-1.5 text-sm font-semibold text-slate-700 focus-visible:outline-2 focus-visible:outline-teal-600 disabled:opacity-60 aria-checked:bg-white aria-checked:text-teal-800 aria-checked:shadow-sm dark:text-slate-300 dark:aria-checked:bg-slate-950 dark:aria-checked:text-teal-300"
              >
                {m === 'help' ? '💬 Help' : '🎲 Play'}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              id={clarityId}
              type="button"
              role="switch"
              aria-checked={props.clarity}
              onClick={() => props.setClarity(!props.clarity)}
              className="relative h-7 w-12 rounded-full bg-slate-300 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 aria-checked:bg-teal-700 dark:bg-slate-700"
            >
              <span className="sr-only">Clarity Mode</span>
              <span
                aria-hidden="true"
                className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${props.clarity ? 'translate-x-5' : ''}`}
              />
            </button>
            <label htmlFor={clarityId} className="cursor-pointer text-sm font-semibold">
              Clarity Mode
            </label>
          </div>
        </div>
      </div>
    </header>
  );
}

function StatusBar({ online, nano }: { online: boolean; nano: ReturnType<typeof useNano> }) {
  const text: Record<string, string> = {
    checking: 'Checking for Gemini Nano…',
    available: '⚡ Gemini Nano is ready on this device',
    downloadable: 'Gemini Nano can be downloaded for faster, private answers',
    downloading: 'Downloading Gemini Nano…',
    unavailable: 'Gemini Nano isn’t available in this browser — using Cloud Gemini',
  };
  return (
    <div className="border-b border-slate-200 bg-white/60 text-xs dark:border-slate-800 dark:bg-slate-900/60">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2" role="status">
        <span className="font-medium">{online ? '🟢 Online' : '🔴 Offline — on-device only'}</span>
        <span className="text-slate-700 dark:text-slate-300">
          {text[nano.status]}
          {nano.progress !== null && ` (${Math.round(nano.progress * 100)}%)`}
        </span>
        {(nano.status === 'downloadable' || (nano.status === 'downloading' && nano.progress === null)) && (
          <button
            type="button"
            onClick={() => void nano.enable()}
            className="rounded-md bg-amber-500 px-2 py-0.5 font-semibold text-amber-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600"
          >
            Enable Gemini Nano
          </button>
        )}
        {nano.progress !== null && (
          <progress className="h-2 w-28 accent-amber-500" max={1} value={nano.progress} aria-label="Gemini Nano download progress" />
        )}
        {nano.error && <span className="text-red-700 dark:text-red-400">{nano.error}</span>}
      </div>
    </div>
  );
}

function EmptyState(props: { mode: AppMode; game: PlayGame; onPick: (s: string) => void; disabled: boolean }) {
  const suggestions = props.mode === 'help' ? HELP_SUGGESTIONS : [PLAY_GAMES[props.game].starter];
  return (
    <div className="py-10 text-center">
      <h2 className="text-2xl font-bold">{props.mode === 'help' ? 'How can I help today?' : "Let's play!"}</h2>
      <p className="mx-auto mt-2 max-w-md text-slate-600 dark:text-slate-400">
        {props.mode === 'help'
          ? 'Quick questions run on your device when possible. Bigger tasks go to Cloud Gemini — with your private details masked first.'
          : `${PLAY_GAMES[props.game].label} runs 100% on your device with Gemini Nano. It even works offline.`}
      </p>
      <ul className="mt-6 flex flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => props.onPick(s)}
              className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-left text-sm hover:border-teal-600 hover:bg-teal-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-teal-700 px-4 py-2.5 whitespace-pre-wrap text-white">
          <span className="sr-only">You said: </span>
          {msg.text}
        </div>
      </div>
    );
  }
  if (msg.role === 'error') {
    return (
      <div role="alert" className="rounded-2xl border border-red-300 bg-red-50 px-4 py-2.5 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100">
        {msg.text}
      </div>
    );
  }
  return (
    <article className="max-w-[92%] rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className="sr-only">Zamari said: </span>
      {msg.text ? <Markdown text={msg.text} /> : <span className="animate-pulse text-slate-500">Thinking…</span>}
      {msg.reply && <RouteDetails reply={msg.reply} />}
    </article>
  );
}
