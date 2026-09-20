# Automations platform

A small agentic automation platform. You give an agent instructions in plain text, it works unattended through the Claude Agent SDK, you watch it unfold step by step, download whatever it produced, optionally let it read and, if you allow it, change your Notion workspace over MCP, and evaluate whether the run did what was asked.

## What it does

1. **Run instructions**: type a task, press Run. The agent can search and read the web and write files into a private per-run workspace. Runs are persisted, so a refresh never loses anything.
2. **Get the output**: the agent writes a file only when the task calls for one; otherwise the answer is its reply. Any file it does write is recorded as an artifact and offered as a download in the format the prompt asked for (CSV, JSON, Markdown, XLSX, ...).
3. **Observe the run**: a panel beside the form shows short, titled steps as they happen (what it is thinking, which tool it uses on what, the result behind a dropdown), plus a stage line naming where the automation is right now. Past runs can be reopened from the list; failed runs show why.
4. **Connect your data via MCP**: Notion's hosted server is offered out of the box; sign in with OAuth, switch it on, and steps that use it carry a distinct "Notion MCP" badge. Servers are read-only until you explicitly allow writes per server.
5. **Evaluate the run**: when a run finishes, the platform asks a separate question — did it do what you asked? A deterministic gate reads what the run produced (its reply and any files), then an LLM judge extracts the requirements implied by your task and checks the output against each one. The verdict is pass / partial / fail / inconclusive, kept apart from the run's own succeeded/failed status, with a human override that requires a reason.



## Stack

Next.js 16 (App Router, React 19, TypeScript strict), Tailwind 4 + shadcn/ui, Zod 4, Kysely over PGlite, Claude Agent SDK, Notion via its hosted MCP server over OAuth.

## Run locally

```bash
npm install
npm run dev -- -p 3001
```

Create `.env.local` with:

```
ANTHROPIC_API_KEY=sk-ant-...   # used by the Agent SDK subprocess
```

`npm run check` runs `tsc --noEmit` and ESLint.

## MCP servers, OAuth and writes

Notion's hosted server (`https://mcp.notion.com/mcp`) is seeded on first start, switched off and
not signed in. Open **MCP** in the composer's control row and press **Sign in** on its row: the
app discovers the server's OAuth
metadata (RFC 9728 + RFC 8414), registers itself dynamically (RFC 7591), and sends you to Notion's
consent screen with PKCE and a `resource` indicator (RFC 8707). Nothing has to be configured in
Notion beforehand — no integration, no client ID.

The redirect URI is derived from the origin you are browsing, so locally it is:

```
http://localhost:3000/api/mcp-servers/<server-id>/oauth/callback
```

Deployed, it is the same path on your own origin; the client re-registers itself when the origin
changes. Access and refresh tokens live in local PGlite, never in the browser: the API only ever
reports `connected`, `needs_auth` or `error`. Tokens refresh automatically a few minutes before
they expire, and a server that cannot authenticate is skipped with a notice in the run instead of
failing the run.

Every server starts **read-only**: its mutating tools are both left out of the allow-list and
denied by name. The gear icon on a server opens its settings, where "Allow writes" asks for an
explicit confirmation before the agent may create, change or delete anything.

OAuth is the only way in: "Add a server by URL" in the MCP directory takes a remote server's URL
and signs in through the same flow. There is no static-token or local-subprocess path.

## Key decisions and trade-offs

- **Polling, not streaming.** The browser polls once a second; about a second of latency in exchange for refresh-safety and no stream plumbing. The event log in the database is the single source of truth.
- **Steps are derived, not stored.** The raw SDK event log is turned into titled steps on every read. Titles are templated from tool inputs (instant, free, predictable); thinking steps use the agent's own first sentence.
- **No progress bar is possible.** The agent decides its next step as it goes, so the view shows elapsed steps and the current stage, never remaining work. Cost and turn totals only arrive with the final result.
- **Thinking is partial.** The model emits thinking blocks only sometimes and the API may summarise them; some steps only have the tool call as evidence of intent.
- **Sandboxed by configuration.** Each run gets its own folder as `cwd`, no Bash, unlisted tools are denied, and personal Claude Code settings and connectors are not loaded, so the MCP toggle is the only way a server reaches the agent.
- **Background execution uses** `after()` inside the Next.js server process: fine for `next dev` and a long-lived Node server, not for serverless.
- **MCP credentials live in local PGlite in plain text**: acceptable for a local tool, not for a shared deployment. OAuth tokens are stored the same way, but they expire and can be revoked from Notion, which a pasted integration token cannot.
- **Writes are opt-in per server, not per call.** The agent runs unattended, so a per-call approval would just block; instead the mutating tools are absent from the agent's context until a human flips the switch.
- **The LLM judge is an estimate, not a fact-checker**: it grades relevance and completeness, cannot verify claims against the web, and costs a model call per evaluation. Hence the deterministic gate first and a human verdict that always wins.

