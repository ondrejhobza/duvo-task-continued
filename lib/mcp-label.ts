/**
 * Display name for an MCP server a run called. Tool names carry only the
 * server's key (`mcp__notion__…`), so the key is matched against the names
 * captured when the run started: a server renamed since then still reads as it
 * did at the time. Unmatched keys — a server removed since the run, or one this
 * run never had — are shown verbatim rather than title-cased, which would turn
 * a "GitHub" into a "Github".
 *
 * Its own module, not `lib/steps.ts`, because both callers are client
 * components and that module reaches the Agent SDK through the ask-user tool,
 * which cannot be bundled for the browser.
 */
export function mcpServerLabel(key: string, attached: readonly string[]): string {
  const flat = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return attached.find((name) => flat(key).startsWith(flat(name))) ?? key;
}
