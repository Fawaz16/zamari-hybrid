import type { Engine, RouteStep, ZamariReply } from '../ai/hybridRouter';

/**
 * Routing trace — hidden from regular users. Rendered only when the app is
 * opened with `?debug` (for demos/judging of the hybrid inference pipeline).
 */
export const ENGINE_TEXT: Record<Engine, string> = {
  nano: '⚡ Gemini Nano (On-Device)',
  cloud: '☁️ Cloud Gemini',
};

const STEP_ICON: Record<RouteStep['engine'], string> = { nano: '⚡', cloud: '☁️', local: '🔒' };

export function RouteDetails({ reply }: { reply: ZamariReply }) {
  return (
    <details className="mt-2 rounded-xl border border-dashed border-line px-3 py-2 text-xs text-muted">
      <summary className="cursor-pointer font-semibold">
        Debug · {ENGINE_TEXT[reply.engine]}
        {reply.privacy && ` · ${reply.privacy.total} masked`}
      </summary>
      <ol className="mt-1 space-y-0.5">
        {reply.steps.map((s, i) => (
          <li key={i}>
            {STEP_ICON[s.engine]} {s.label}
            {s.detail && ` — ${s.detail}`}
          </li>
        ))}
        <li>Model: {reply.model}</li>
      </ol>
    </details>
  );
}
