import { Fragment, type ReactNode } from 'react';

/**
 * Minimal, safe markdown renderer for model output (no HTML injection):
 * headings, bullet/numbered lists, **bold**, *italic*, `code`, paragraphs.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`'))
      out.push(
        <code key={i++} className="rounded bg-black/5 px-1 py-0.5 text-[0.9em] dark:bg-white/10">
          {tok.slice(1, -1)}
        </code>,
      );
    else out.push(<em key={i++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'p'; text: string };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (h) {
      flush();
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] });
    } else if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const item = (ul ?? ol)![1];
      const prev = blocks[blocks.length - 1];
      if (prev && prev.kind === kind) prev.items.push(item);
      else blocks.push({ kind, items: [item] });
    } else para.push(line.trim());
  }
  flush();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parse(text).map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className="mt-3 font-semibold first:mt-0" role="heading" aria-level={Math.min(b.level + 2, 6)}>
                {inline(b.text)}
              </p>
            );
          case 'ul':
            return (
              <ul key={i} className="my-2 list-disc space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="my-2 list-decimal space-y-1 pl-5">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </ol>
            );
          default:
            return (
              <p key={i} className="my-2 first:mt-0 last:mb-0">
                {inline(b.text).map((n, j) => (
                  <Fragment key={j}>{n}</Fragment>
                ))}
              </p>
            );
        }
      })}
    </>
  );
}
