import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "cn";

/**
 * The agent's reply, rendered. Only the reply: step titles, tool summaries and
 * error text are shown verbatim elsewhere, because an error that happens to
 * contain an underscore is not asking to be italicised.
 *
 * Raw HTML is not rendered — `rehype-raw` is deliberately absent. The reply can
 * contain whatever the agent fetched off the web, so it is treated as untrusted
 * and any HTML in it comes out as text. Links open in a new tab with
 * `rel="noopener noreferrer"` for the same reason.
 */

/**
 * Restrained on purpose: headings sit under the page's own headings in weight
 * and size, so a reply that opens with `# Title` does not out-shout the card it
 * is inside.
 */
const components: Components = {
  h1: ({ children }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 className="mt-4 mb-2 text-sm font-semibold first:mt-0">{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mt-3 mb-1.5 text-sm font-medium first:mt-0">{children}</h6>
  ),
  h5: ({ children }) => (
    <p className="mt-3 mb-1.5 text-sm font-medium first:mt-0">{children}</p>
  ),
  h6: ({ children }) => (
    <p className="mt-3 mb-1.5 text-sm font-medium text-muted-foreground first:mt-0">{children}</p>
  ),
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  ul: ({ children }) => (
    <ul className="my-2 flex list-disc flex-col gap-1 pl-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 tabular-nums first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed marker:text-muted-foreground">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium break-words underline underline-offset-4 hover:text-foreground"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground italic first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t" />,
  // Inline code only: a fenced block arrives as `pre > code`, and `pre` below
  // owns the frame so the two do not nest borders.
  code: ({ children, className }) => (
    <code
      className={cn(
        "rounded border bg-muted/60 px-1 py-0.5 font-mono text-xs break-words",
        className,
      )}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    // The nested-panel convention, and the reason long code cannot widen the
    // card: it scrolls sideways in here instead.
    <pre className="my-3 overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed first:mt-0 last:mb-0 [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:whitespace-pre">
      {children}
    </pre>
  ),
  // A GFM table with ragged or numerous columns scrolls rather than stretching
  // the panel; the wrapper is what scrolls, so the header stays aligned.
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border first:mt-0 last:mb-0">
      <table className="w-full text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/40">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-b last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="px-3 py-2 font-medium whitespace-nowrap text-muted-foreground">{children}</th>
  ),
  td: ({ children }) => <td className="px-3 py-2 align-top tabular-nums">{children}</td>,
};

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    // `break-words` catches the long unbroken string — a URL, a hash — that
    // markdown itself gives no opportunity to wrap. `min-w-0` is what makes the
    // horizontal scrolling above actually bite: without it a wide code line or
    // table sets this block's minimum width and widens the panel instead.
    <div className={cn("min-w-0 text-sm break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
