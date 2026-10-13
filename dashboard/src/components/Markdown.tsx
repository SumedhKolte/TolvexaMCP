import { Fragment, type ReactNode } from "react";

/**
 * A deliberately tiny Markdown renderer for chat answers: paragraphs, headings, bullet
 * and numbered lists, **bold**, *italic* and `code`. It builds React elements only (no
 * HTML strings), so model output can never inject markup or scripts.
 */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++} className="rounded bg-zinc-100 px-1 py-0.5 text-[0.85em]">{t.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key++} className="mt-2 font-semibold">{inline(heading[2] ?? "")}</p>);
      i++;
      continue;
    }
    const bullet = /^\s*[-*•]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? numbered : bullet).test(lines[i] as string)) {
        items.push((lines[i] as string).replace(ordered ? numbered : bullet, ""));
        i++;
      }
      const List = ordered ? "ol" : "ul";
      blocks.push(
        <List key={key++} className={`${ordered ? "list-decimal" : "list-disc"} space-y-0.5 pl-5`}>
          {items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() && !bullet.test(lines[i] as string) && !numbered.test(lines[i] as string) && !/^#{1,4}\s/.test(lines[i] as string)) {
      para.push(lines[i] as string);
      i++;
    }
    blocks.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return <div className="space-y-2 text-sm leading-relaxed">{blocks}</div>;
}
