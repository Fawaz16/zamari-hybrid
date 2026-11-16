import type { Engine, RouteStep, ZamariReply } from '../ai/hybridRouter';

const STYLES: Record<Engine, string> = {
  nano: 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  cloud: 'bg-sky-100 text-sky-900 ring-sky-300 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-800',
};

export const ENGINE_TEXT: Record<Engine, string> = {
  nano: '⚡ Gemini Nano (On-Device)',
  cloud: '☁️ Cloud Gemini',
};

export function RouteBadge({ engine }: { engine: Engine }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STYLES[engine]}`}
    >
      {ENGINE_TEXT[engine]}
    </span>
  );
}

const STEP_ICON: Record<RouteStep['engine'], string> = { nano: '⚡', cloud: '☁️', local: '🔒' };

/** Badge + an expandable "how this was answered" trace. */
export function RouteDetails({ reply }: { reply: ZamariReply }) {
  const masked = reply.privacy
    ? Object.entries(reply.privacy.masked)
        .map(([k, n]) => `${n} ${k.toLowerCase()}`)
        .join(', ')
    : null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <RouteBadge engine={reply.engine} />
      {reply.privacy && (
        <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-900 ring-1 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800">
          🔒 {reply.privacy.total} private detail{reply.privacy.total === 1 ? '' : 's'} masked
        </span>
      )}
      <details className="group text-xs text-slate-600 dark:text-slate-400">
        <summary className="cursor-pointer rounded px-1 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-teal-600">
          How this was answered
        </summary>
        <ol className="mt-1 space-y-0.5 pl-1">
          {reply.steps.map((s, i) => (
            <li key={i}>
              <span aria-hidden="true">{STEP_ICON[s.engine]}</span> {s.label}
              <span className="sr-only"> ({s.engine === 'local' ? 'on this device, rule-based' : ENGINE_TEXT[s.engine]})</span>
              {s.detail && <span className="text-slate-500"> — {s.detail}</span>}
            </li>
          ))}
          <li className="text-slate-500">Model: {reply.model}</li>
          {masked && <li className="text-slate-500">Masked before leaving device: {masked}</li>}
        </ol>
      </details>
    </div>
  );
}
