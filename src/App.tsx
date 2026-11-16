import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { Attachment } from './ai/attachments';
import { isFirebaseConfigured } from './ai/firebase';
import {
  describeError,
  routeHelp,
  routePlay,
  type ChatTurn,
  type Grounding,
  type PlayGame,
  type ZamariReply,
} from './ai/hybridRouter';
import { PLAY_GAMES, pickSecret } from './ai/prompts';
import { Composer, type ComposerHandle } from './components/Composer';
import {
  ArrowUpRightIcon,
  BookIcon,
  CameraIcon,
  ChatIcon,
  CheckIcon,
  ClarityIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  ImageIcon,
  MicIcon,
  PenIcon,
  PlusIcon,
  PuzzleIcon,
  QuestionIcon,
  SettingsIcon,
  SparkIcon,
  SpeakerIcon,
} from './components/Icons';
import { Markdown } from './components/Markdown';
import { Orb } from './components/Orb';
import { RouteDetails } from './components/RouteBadge';
import { useImagesLeft, useNano, useOnline, usePersistentState } from './hooks';
import { imageLimit } from './ai/imageQuota';

type AppMode = 'help' | 'play';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  attachments?: Attachment[];
  reply?: ZamariReply;
  pending?: boolean;
}

/** Routing internals are hidden from users; append ?debug to the URL to see them (handy for demos). */
const DEBUG = new URLSearchParams(window.location.search).has('debug');

const newId = () => crypto.randomUUID();

const HELP_IDEAS = [
  { icon: PenIcon, text: 'Write a sweet birthday message for my best friend' },
  { icon: BookIcon, text: 'Explain how credit scores work, simply' },
  { icon: SparkIcon, text: 'Plan a cosy, low-budget weekend for me' },
];

const GAME_ICONS: Record<PlayGame, typeof BookIcon> = {
  story: BookIcon,
  riddles: PuzzleIcon,
  'twenty-questions': QuestionIcon,
};

const GAME_BLURB: Record<PlayGame, string> = {
  story: 'You choose what happens next',
  riddles: 'Brain teasers with hints',
  'twenty-questions': 'I think of something — you guess',
};

export default function App() {
  const [mode, setMode] = usePersistentState<AppMode>('zamari.mode', 'help');
  const [clarity, setClarity] = usePersistentState('zamari.clarity', false);
  const [game, setGame] = useState<PlayGame>('story');
  const [secret, setSecret] = useState(pickSecret);
  const [threads, setThreads] = useState<Record<AppMode, Message[]>>({ help: [], play: [] });
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const online = useOnline();
  const nano = useNano();
  const imagesLeft = useImagesLeft();
  const composer = useRef<ComposerHandle | null>(null);
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

  async function send(text: string, opts: { brief?: boolean; attachments?: Attachment[]; gameOverride?: PlayGame } = {}) {
    const files = opts.attachments ?? [];
    const input = text.trim();
    if ((!input && !files.length) || busy) return;
    const m = mode;
    const g = opts.gameOverride ?? game;
    const history: ChatTurn[] = threads[m]
      .filter((x) => x.role !== 'error' && !x.pending)
      .map((x) => ({
        role: x.role as ChatTurn['role'],
        text: x.attachments?.length ? `${x.text} [attached: ${x.attachments.map((a) => a.name).join(', ')}]` : x.text,
      }));
    const replyId = newId();
    const display = input || (files.every((f) => f.kind === 'audio') ? '🎤 Voice note' : '📎 Attachment');

    setThreads((t) => ({
      ...t,
      [m]: [
        ...t[m],
        { id: newId(), role: 'user', text: display, attachments: files },
        { id: replyId, role: 'assistant', text: '', pending: true },
      ],
    }));
    setBusy(true);

    const onText = (t: string) => patch(m, replyId, { text: t });
    try {
      const reply =
        m === 'help'
          ? await routeHelp({ input, history, clarity, brief: opts.brief, online, attachments: files, onText })
          : await routePlay({
              game: g,
              input,
              history,
              clarity,
              online,
              attachments: files,
              secret,
              questionNumber: history.filter((h) => h.role === 'user').length + 1,
              onText,
            });
      patch(m, replyId, { text: reply.text, reply, pending: false });
    } catch (e) {
      patch(m, replyId, { role: 'error', text: describeError(e), pending: false });
    } finally {
      setBusy(false);
      composer.current?.focus();
    }
  }

  function sendFromComposer(opts: { brief?: boolean } = {}) {
    const files = attachments;
    const text = draft;
    setDraft('');
    setAttachments(() => []);
    void send(text, { ...opts, attachments: files });
  }

  function startGame(g: PlayGame) {
    setGame(g);
    setSecret(pickSecret());
    setThreads((t) => ({ ...t, play: [] }));
    void send(PLAY_GAMES[g].starter, { gameOverride: g });
  }

  function newChat() {
    setThreads((t) => ({ ...t, [mode]: [] }));
    if (mode === 'play') setSecret(pickSecret());
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) composer.current?.addFiles(files);
  }

  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <a
        href="#message"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-full focus:bg-gradient-brand focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to message box
      </a>

      {/* ---------- Top bar ---------- */}
      <header className="relative z-10 mx-auto flex w-full max-w-2xl items-center justify-between gap-2 px-4 pt-[max(env(safe-area-inset-top),14px)] pb-2">
        <div className="flex items-center gap-2.5">
          <Orb size={30} />
          <h1 className="text-lg font-semibold tracking-tight">Zamari</h1>
          {!online && (
            <span className="rounded-full border border-amber-300/30 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">
              Offline
            </span>
          )}
        </div>

        <div role="radiogroup" aria-label="Mode" className="glass flex rounded-full p-1">
          {(['help', 'play'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={busy}
              onClick={() => setMode(m)}
              className="rounded-full px-3.5 py-1.5 text-sm font-semibold text-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-60 aria-checked:bg-gradient-brand aria-checked:text-white aria-checked:shadow-lg aria-checked:shadow-purple-900/40"
            >
              {m === 'help' ? 'Help' : 'Play'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-pressed={clarity}
            onClick={() => setClarity(!clarity)}
            title="Clarity Mode: simpler words and easier-to-read text"
            className="glass flex h-10 w-10 items-center justify-center rounded-full text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-violet aria-pressed:border-transparent aria-pressed:bg-gradient-brand aria-pressed:text-white"
          >
            <ClarityIcon />
            <span className="sr-only">Clarity Mode</span>
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="glass flex h-10 w-10 items-center justify-center rounded-full text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-violet"
          >
            <SettingsIcon />
            <span className="sr-only">Settings</span>
          </button>
        </div>
      </header>

      {!isFirebaseConfigured && (
        <div role="alert" className="mx-auto w-full max-w-2xl px-4">
          <p className="rounded-2xl border border-amber-300/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            Zamari isn’t connected yet — add the Firebase settings to the environment and reload.
          </p>
        </div>
      )}

      {/* ---------- Conversation / home ---------- */}
      <main className="relative flex-1 overflow-y-auto">
        <section
          aria-label={`${mode === 'help' ? 'Help' : 'Play'} conversation`}
          aria-live="polite"
          aria-busy={busy}
          className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-4 pt-2 pb-6"
        >
          {messages.length === 0 ? (
            mode === 'help' ? (
              <HelpHome
                onIdea={(t) => void send(t)}
                onAsk={() => composer.current?.focus()}
                onDraft={() => {
                  setDraft('Help me write a message to ');
                  composer.current?.focus();
                }}
                onSnap={() => composer.current?.openFilePicker('image/*,application/pdf,.pdf,.docx,.txt,.md,.csv')}
                onCreateImage={() => {
                  setDraft('Create a picture of ');
                  composer.current?.focus();
                }}
                imagesLeft={imagesLeft}
                disabled={busy}
              />
            ) : (
              <PlayHome onPick={startGame} disabled={busy} />
            )
          ) : (
            <>
              <div className="mb-4 flex items-center justify-between">
                <p className="text-xs font-medium tracking-wide text-muted uppercase">
                  {mode === 'help' ? 'Conversation' : `${PLAY_GAMES[game].emoji} ${PLAY_GAMES[game].label}`}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={newChat}
                  className="glass inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50"
                >
                  <PlusIcon size={14} /> {mode === 'play' ? 'New game' : 'New chat'}
                </button>
              </div>
              <div className="space-y-5">
                {messages.map((msg) => (
                  <MessageItem key={msg.id} msg={msg} />
                ))}
              </div>
            </>
          )}
          <div ref={endRef} />
        </section>
      </main>

      <Composer
        busy={busy}
        placeholder={mode === 'help' ? 'Type a message or press the mic' : 'Your move…'}
        draft={draft}
        setDraft={setDraft}
        attachments={attachments}
        setAttachments={setAttachments}
        onSend={sendFromComposer}
        showBrief={mode === 'help'}
        handleRef={(h) => (composer.current = h)}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-3 z-30 flex items-center justify-center rounded-[32px] border-2 border-dashed border-accent-violet/70 bg-ink/70 backdrop-blur-sm">
          <p className="text-lg font-semibold">Drop pictures or documents here</p>
        </div>
      )}

      {settingsOpen && (
        <SettingsSheet
          onClose={() => setSettingsOpen(false)}
          clarity={clarity}
          setClarity={setClarity}
          nano={nano}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home screens
// ---------------------------------------------------------------------------

function HelpHome(props: {
  onIdea: (t: string) => void;
  onAsk: () => void;
  onDraft: () => void;
  onSnap: () => void;
  onCreateImage: () => void;
  imagesLeft: number;
  disabled: boolean;
}) {
  return (
    <div className="fade-up flex flex-1 flex-col pt-4">
      <p className="text-sm text-muted">Hey there 👋</p>
      <h2 className="mt-1 text-[2rem] leading-[1.15] font-light tracking-tight sm:text-4xl">
        What can I help you <span className="text-gradient font-medium">with today?</span>
      </h2>

      <div className="mt-6 grid grid-cols-2 gap-3">
        <div className="ring-gradient row-span-2 flex flex-col rounded-3xl bg-surface p-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-strong">
            <ChatIcon />
          </span>
          <p className="mt-4 text-[15px] leading-snug font-semibold">
            Start a<br />conversation
          </p>
          <p className="mt-1 text-xs text-muted">Ask me anything, big or small</p>
          <button
            type="button"
            onClick={props.onAsk}
            className="bg-gradient-brand glow-brand mt-auto rounded-full py-2.5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-pink"
          >
            Ask now
          </button>
        </div>
        <HomeCard icon={<PenIcon />} title="Draft a message" onClick={props.onDraft} disabled={props.disabled} />
        <HomeCard icon={<CameraIcon />} title="Snap or upload & ask" onClick={props.onSnap} disabled={props.disabled} />
        {imageLimit > 0 && (
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onCreateImage}
            className="glass col-span-2 flex items-center gap-3 rounded-3xl p-4 text-left hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50"
          >
            <span className="bg-gradient-brand flex h-10 w-10 flex-none items-center justify-center rounded-full text-white">
              <ImageIcon />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-semibold">Create a picture</span>
              <span className="block text-xs text-muted">Describe anything and I’ll draw it</span>
            </span>
            <span className="rounded-full bg-surface-strong px-2.5 py-1 text-[11px] font-semibold text-muted">
              {props.imagesLeft}/{imageLimit} left today
            </span>
          </button>
        )}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Try asking</h3>
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <MicIcon size={13} /> or send a voice note
        </span>
      </div>
      <ul className="mt-3 space-y-2.5">
        {HELP_IDEAS.map(({ icon: Icon, text }) => (
          <li key={text}>
            <button
              type="button"
              disabled={props.disabled}
              onClick={() => props.onIdea(text)}
              className="glass group flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50"
            >
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-surface-strong text-muted group-hover:text-fg">
                <Icon size={18} />
              </span>
              <span className="flex-1 text-sm leading-snug">{text}</span>
              <ArrowUpRightIcon size={18} className="text-muted transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HomeCard(props: { icon: React.ReactNode; title: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className="glass flex flex-col items-start gap-3 rounded-3xl p-4 text-left hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-strong">{props.icon}</span>
      <span className="text-sm leading-snug font-semibold">{props.title}</span>
    </button>
  );
}

function PlayHome({ onPick, disabled }: { onPick: (g: PlayGame) => void; disabled: boolean }) {
  return (
    <div className="fade-up flex flex-1 flex-col items-center pt-6 text-center">
      <Orb size={150} />
      <p className="mt-8 text-sm text-muted">Ready when you are 🎮</p>
      <h2 className="mt-1 text-[2rem] leading-tight font-light tracking-tight">
        Pick a game and <span className="text-gradient font-medium">let’s have fun</span>
      </h2>
      <ul className="mt-8 grid w-full gap-3 sm:grid-cols-3">
        {(Object.keys(PLAY_GAMES) as PlayGame[]).map((g) => {
          const Icon = GAME_ICONS[g];
          return (
            <li key={g}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(g)}
                className="glass group flex w-full items-center gap-3 rounded-3xl p-4 text-left hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet disabled:opacity-50 sm:flex-col sm:items-start"
              >
                <span className="bg-gradient-brand flex h-11 w-11 flex-none items-center justify-center rounded-2xl text-white">
                  <Icon />
                </span>
                <span className="flex-1">
                  <span className="block font-semibold">{PLAY_GAMES[g].label}</span>
                  <span className="block text-xs text-muted">{GAME_BLURB[g]}</span>
                </span>
                <ArrowUpRightIcon size={18} className="text-muted group-hover:text-fg sm:hidden" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function AttachmentPreview({ a }: { a: Attachment }) {
  if (a.kind === 'image' && a.previewUrl) {
    return <img src={a.previewUrl} alt={a.name} className="max-h-48 max-w-full rounded-2xl object-cover" />;
  }
  if (a.kind === 'audio' && a.previewUrl) {
    return <audio controls src={a.previewUrl} className="h-10 w-60 max-w-full" aria-label={a.name} />;
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-xl bg-white/15 px-3 py-2 text-xs font-medium">
      <FileIcon size={16} /> {a.name}
    </span>
  );
}

function MessageItem({ msg }: { msg: Message }) {
  if (msg.role === 'user') {
    const onlyVoice = msg.attachments?.length && ['🎤 Voice note', '📎 Attachment'].includes(msg.text);
    return (
      <div className="fade-up flex justify-end">
        <div className="bg-gradient-brand max-w-[85%] space-y-2 rounded-[22px] rounded-br-md px-4 py-2.5 text-white shadow-lg shadow-purple-950/40">
          <span className="sr-only">You said: </span>
          {msg.attachments?.map((a) => <AttachmentPreview key={a.id} a={a} />)}
          {!onlyVoice && <p className="whitespace-pre-wrap">{msg.text}</p>}
        </div>
      </div>
    );
  }

  if (msg.role === 'error') {
    return (
      <div role="alert" className="fade-up flex gap-3">
        <Orb size={28} className="mt-1 opacity-60" />
        <p className="rounded-[22px] rounded-tl-md border border-rose-400/25 bg-rose-500/10 px-4 py-2.5 text-rose-100">{msg.text}</p>
      </div>
    );
  }

  return (
    <article className="fade-up flex gap-3">
      <Orb size={28} active={msg.pending} className="mt-1" />
      <div className="min-w-0 flex-1">
        <span className="sr-only">Zamari said: </span>
        {msg.reply?.images?.map((img, i) => (
          <GeneratedImage key={i} mimeType={img.mimeType} data={img.data} />
        ))}
        {msg.text ? (
          <div className="prose-zamari text-[15px] leading-relaxed text-fg/95">
            <Markdown text={msg.text} />
          </div>
        ) : (
          <p className="flex items-center gap-2 pt-1.5 text-sm text-muted">
            <span className="dot-pulse" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Thinking…
          </p>
        )}
        {!msg.pending && msg.reply?.grounding && <LiveSources grounding={msg.reply.grounding} />}
        {!msg.pending && msg.text && <MessageActions text={msg.text} />}
        {DEBUG && msg.reply && <RouteDetails reply={msg.reply} />}
      </div>
    </article>
  );
}

/**
 * Sources for answers grounded with Google Search. Google's terms require showing the
 * Search Suggestions widget exactly as returned; it's isolated in a sandboxed iframe so
 * its HTML/CSS can't touch the app, and its links open in a new tab.
 */
function LiveSources({ grounding }: { grounding: Grounding }) {
  return (
    <div className="mt-3 space-y-2">
      {grounding.sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">🌐 Live sources:</span>
          {grounding.sources.map((s) => (
            <a
              key={s.uri}
              href={s.uri}
              target="_blank"
              rel="noopener noreferrer"
              className="max-w-[14rem] truncate rounded-full bg-surface-strong px-2.5 py-1 hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-accent-violet"
            >
              {s.title}
            </a>
          ))}
        </div>
      )}
      {grounding.searchSuggestionsHtml && (
        <iframe
          title="Related Google searches"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={`<base target="_blank"><style>body{margin:0;background:transparent}</style>${grounding.searchSuggestionsHtml}`}
          className="h-16 w-full rounded-xl border-0"
        />
      )}
    </div>
  );
}

function GeneratedImage({ mimeType, data }: { mimeType: string; data: string }) {
  const src = `data:${mimeType};base64,${data}`;
  const ext = mimeType.split('/')[1] ?? 'png';
  return (
    <figure className="mb-3">
      <img
        src={src}
        alt="Picture created by Zamari"
        className="ring-gradient w-full max-w-md rounded-3xl border border-line object-cover shadow-2xl shadow-purple-950/40"
      />
      <a
        href={src}
        download={`zamari-${Date.now()}.${ext}`}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-surface-strong px-3 py-1.5 text-xs font-semibold hover:bg-white/15 focus-visible:outline-2 focus-visible:outline-accent-violet"
      >
        <DownloadIcon size={14} /> Save picture
      </a>
    </figure>
  );
}

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const canSpeak = 'speechSynthesis' in window;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  function speak() {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*#`_>]/g, ''));
    u.rate = 1;
    u.onend = u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(u);
  }

  const btn =
    'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted hover:bg-surface-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-accent-violet';
  return (
    <div className="mt-1.5 -ml-2 flex gap-1">
      <button type="button" onClick={() => void copy()} className={btn}>
        {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />} {copied ? 'Copied' : 'Copy'}
      </button>
      {canSpeak && (
        <button type="button" onClick={speak} aria-pressed={speaking} className={btn}>
          <SpeakerIcon size={14} /> {speaking ? 'Stop' : 'Listen'}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsSheet(props: {
  onClose: () => void;
  clarity: boolean;
  setClarity: (v: boolean) => void;
  nano: ReturnType<typeof useNano>;
}) {
  const { nano } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center" onClick={props.onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
        className="fade-up w-full max-w-md rounded-t-[32px] border border-line bg-[#0f0d18] p-6 pb-[max(env(safe-area-inset-bottom),24px)] sm:rounded-[32px]"
      >
        <div className="flex items-center justify-between">
          <h2 id="settings-title" className="text-lg font-semibold">
            Settings
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={props.onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-accent-violet"
          >
            <CloseIcon />
            <span className="sr-only">Close settings</span>
          </button>
        </div>

        <div className="mt-5 flex items-start justify-between gap-4 rounded-2xl bg-surface p-4">
          <div>
            <p id="clarity-label" className="font-semibold">
              Clarity Mode
            </p>
            <p className="mt-0.5 text-sm text-muted">Short bullet points, plain words and an easier-to-read font.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={props.clarity}
            aria-labelledby="clarity-label"
            onClick={() => props.setClarity(!props.clarity)}
            className="relative mt-1 h-7 w-12 flex-none rounded-full bg-white/15 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-violet aria-checked:bg-gradient-brand"
          >
            <span
              aria-hidden="true"
              className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white shadow transition-transform ${props.clarity ? 'translate-x-5' : ''}`}
            />
          </button>
        </div>

        {(nano.status === 'downloadable' || nano.status === 'downloading' || nano.status === 'available') && (
          <div className="mt-3 rounded-2xl bg-surface p-4">
            <p className="font-semibold">Faster & private on this device</p>
            <p className="mt-0.5 text-sm text-muted">
              {nano.status === 'available'
                ? 'Turned on ✨ Many replies now happen right here on your device, even offline.'
                : 'Download a small AI brain to this device for quicker replies that work offline.'}
            </p>
            {nano.status !== 'available' && (
              <button
                type="button"
                disabled={nano.progress !== null}
                onClick={() => void nano.enable()}
                className="bg-gradient-brand glow-brand mt-3 w-full rounded-full py-2.5 text-sm font-semibold text-white disabled:opacity-70"
              >
                {nano.progress !== null ? `Downloading… ${Math.round(nano.progress * 100)}%` : 'Turn on'}
              </button>
            )}
            {nano.error && <p className="mt-2 text-sm text-rose-300">{nano.error}</p>}
          </div>
        )}

        <p className="mt-5 text-center text-xs text-muted">
          Private details like phone numbers and emails are masked before anything leaves your device.
        </p>
      </div>
    </div>
  );
}
