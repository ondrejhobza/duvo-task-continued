import path from "node:path";
import { z } from "zod";
import { ASK_USER_TOOL_NAME } from "@/lib/ask-user";
import type { RunEvent } from "@/lib/repo";
import {
  agentModelIdSchema,
  agentModelName,
  type RunPhase,
  type RunStatus,
  type RunStep,
} from "@/lib/schema";

/**
 * Turns the raw Claude Agent SDK event log of a run into short, titled steps
 * plus a single "phase" that names the stage the automation is in right now.
 *
 * Titles are templated from tool inputs (deterministic, free, instant). For
 * thinking and text the agent's own first sentence is used, so the title
 * always summarises what it is thinking without an extra model call.
 */

const TITLE_MAX = 90;
const RESULT_MAX = 4000;

// ---------- Loose shapes of the SDK payloads we read ----------

const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: z.string() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
});

const initPayload = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  model: z.string(),
  tools: z.array(z.string()).default([]),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
});

const assistantPayload = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
});

const userPayload = z.object({
  type: z.literal("user"),
  message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const resultPayload = z.discriminatedUnion("subtype", [
  z.object({
    type: z.literal("result"),
    subtype: z.literal("success"),
    result: z.string(),
    is_error: z.boolean(),
    num_turns: z.number(),
    total_cost_usd: z.number(),
  }),
  z.object({
    type: z.literal("result"),
    subtype: z.enum([
      "error_max_turns",
      "error_during_execution",
      "error_max_budget_usd",
      "error_max_structured_output_retries",
    ]),
    errors: z.array(z.string()).default([]),
    num_turns: z.number(),
    total_cost_usd: z.number(),
  }),
]);

const runnerErrorPayload = z.object({ message: z.string() });

const mcpNoticePayload = z.object({ message: z.string() });

const modelRoutingPayload = z.object({
  model: agentModelIdSchema,
  reasoning: z.boolean(),
  rationale: z.string(),
  routed: z.boolean(),
  /** Absent on events written before the routing call's cost was recorded. */
  costUsd: z.number().nullable().default(null),
});

const clarificationAskedPayload = z.object({
  reason: z.string().default(""),
  questions: z.array(z.string()).default([]),
});

const clarificationAnsweredPayload = z.object({
  skipped: z.boolean().default(false),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});

// ---------- Title helpers ----------

export function firstSentence(text: string, max = TITLE_MAX): string {
  const clean = text
    .replace(/[`*_#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "…";
  const match = /^(.+?[.!?])(\s|$)/.exec(clean);
  const sentence = match ? match[1] : clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function str(input: unknown, key: string): string | null {
  if (input && typeof input === "object" && key in input) {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname === "/" ? "" : u.pathname;
    const s = `${u.hostname}${p}`;
    return s.length > 60 ? `${s.slice(0, 59)}…` : s;
  } catch {
    return url;
  }
}

function humanizeToolName(name: string): string {
  return name
    .replace(/^API-/, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

export interface ToolDescription {
  title: string;
  mcpServer: string | null;
}

/** Plain-language titles for the Notion MCP read tools; falls back to the humanised name. */
function describeNotionTool(tool: string, input: unknown): string {
  const q = str(input, "query");
  const pageId = str(input, "page_id") ?? str(input, "block_id");
  const shortId = pageId ? pageId.replace(/-/g, "").slice(0, 8) : null;
  switch (tool) {
    case "API-post-search":
      return q ? `Searching Notion for "${q}"` : "Listing Notion pages";
    case "API-retrieve-a-page":
      return shortId ? `Opening Notion page ${shortId}…` : "Opening a Notion page";
    case "API-retrieve-page-markdown":
      return shortId ? `Reading Notion page ${shortId}… as Markdown` : "Reading a Notion page";
    case "API-get-block-children":
    case "API-retrieve-a-block":
      return shortId ? `Reading content of Notion page ${shortId}…` : "Reading Notion page content";
    case "API-retrieve-a-database":
    case "API-retrieve-a-data-source":
      return "Inspecting a Notion database";
    case "API-query-data-source":
      return "Querying a Notion database";
    case "API-get-self":
    case "API-get-users":
    case "API-get-user":
      return "Checking Notion workspace users";
    // Hosted Notion server (mcp.notion.com) names its tools differently.
    case "notion-search":
    case "notion-ai-search":
      return q ? `Searching Notion for "${q}"` : "Searching Notion";
    case "notion-fetch":
      return "Reading a Notion page";
    case "notion-create-pages":
      return "Creating a Notion page";
    case "notion-update-page":
      return "Updating a Notion page";
    case "notion-create-comment":
      return "Commenting in Notion";
    default:
      return `Using Notion to ${humanizeToolName(tool)}`;
  }
}

export function describeTool(name: string, input: unknown): ToolDescription {
  // The platform's own in-process tool, not a server the user connected: it
  // reads as the agent turning to the user, not as an MCP call.
  if (name === ASK_USER_TOOL_NAME) {
    return { title: "Stopped to ask you for something it needs", mcpServer: null };
  }

  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (mcp) {
    const [, server, tool] = mcp;
    const title = server.startsWith("notion")
      ? describeNotionTool(tool, input)
      : `Using ${server} MCP to ${humanizeToolName(tool)}`;
    return { title, mcpServer: server };
  }

  const file = str(input, "file_path");
  const base = file ? path.basename(file) : null;

  switch (name) {
    case "WebSearch": {
      const q = str(input, "query");
      return { title: q ? `Searching the web for "${q}"` : "Searching the web", mcpServer: null };
    }
    case "WebFetch": {
      const url = str(input, "url");
      return { title: url ? `Reading ${shortUrl(url)}` : "Reading a web page", mcpServer: null };
    }
    case "Read":
      return { title: base ? `Reading file ${base}` : "Reading a file", mcpServer: null };
    case "Write":
      return { title: base ? `Writing ${base}` : "Writing a file", mcpServer: null };
    case "Edit":
      return { title: base ? `Editing ${base}` : "Editing a file", mcpServer: null };
    case "Glob": {
      const pattern = str(input, "pattern");
      return { title: pattern ? `Looking for files matching ${pattern}` : "Listing files", mcpServer: null };
    }
    case "Grep": {
      const pattern = str(input, "pattern");
      return { title: pattern ? `Searching files for "${pattern}"` : "Searching files", mcpServer: null };
    }
    default:
      return { title: `Using ${name}`, mcpServer: null };
  }
}

function toolResultText(content: string | unknown[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      const text = str(part, "text");
      return text ?? JSON.stringify(part);
    })
    .join("\n");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "";
}

// ---------- Derivation ----------

export interface DerivedRun {
  steps: RunStep[];
  phase: RunPhase;
  filesWritten: string[];
  /**
   * Keys of the MCP servers the run actually called, in first-use order.
   * Read off the tool steps rather than the run's list of attached servers:
   * relevance gating attaches a server the task *might* need, and a badge for
   * something that was never touched reads as "the agent consulted this".
   */
  mcpServersUsed: string[];
}

export function deriveRunSteps(
  events: RunEvent[],
  runStatus: RunStatus,
  startedAt: string | null,
  /** A stop the loop has not landed yet; the phase says so instead of guessing. */
  cancelRequested = false,
): DerivedRun {
  const steps: RunStep[] = [];
  const toolStepByUseId = new Map<string, RunStep>();
  const filesWritten = new Set<string>();
  const t0 = startedAt ? new Date(startedAt).getTime() : events[0] ? new Date(events[0].createdAt).getTime() : 0;

  const push = (event: RunEvent, step: Omit<RunStep, "seq" | "atMs">): RunStep => {
    const full: RunStep = {
      ...step,
      seq: event.seq,
      atMs: Math.max(0, new Date(event.createdAt).getTime() - t0),
    };
    steps.push(full);
    return full;
  };

  for (const event of events) {
    const init = initPayload.safeParse(event.payload);
    if (init.success) {
      const servers = init.data.mcp_servers.map((s) => `${s.name} (${s.status})`);
      push(event, {
        kind: "init",
        title: `Starting agent on ${init.data.model}`,
        detail: [
          `Tools: ${init.data.tools.join(", ") || "none"}`,
          `MCP servers: ${servers.join(", ") || "none"}`,
        ].join("\n"),
        toolName: null,
        mcpServer: null,
        toolResult: null,
        toolIsError: false,
      });
      continue;
    }

    const assistant = assistantPayload.safeParse(event.payload);
    if (assistant.success) {
      for (const raw of assistant.data.message.content) {
        const thinking = thinkingBlock.safeParse(raw);
        if (thinking.success) {
          const text = thinking.data.thinking.trim();
          push(event, {
            kind: "thinking",
            title: text ? firstSentence(text) : "Reasoning (the model kept this private)",
            detail: text || null,
            toolName: null,
            mcpServer: null,
            toolResult: null,
            toolIsError: false,
          });
          continue;
        }
        const text = textBlock.safeParse(raw);
        if (text.success) {
          push(event, {
            kind: "text",
            title: firstSentence(text.data.text),
            detail: text.data.text,
            toolName: null,
            mcpServer: null,
            toolResult: null,
            toolIsError: false,
          });
          continue;
        }
        const toolUse = toolUseBlock.safeParse(raw);
        if (toolUse.success) {
          const { name, id, input } = toolUse.data;
          const { title, mcpServer } = describeTool(name, input);
          const step = push(event, {
            kind: "tool",
            title,
            detail: pretty(input),
            toolName: name,
            mcpServer,
            toolResult: null,
            toolIsError: false,
          });
          toolStepByUseId.set(id, step);
          if (name === "Write") {
            const file = str(input, "file_path");
            if (file) filesWritten.add(path.basename(file));
          }
        }
      }
      continue;
    }

    const user = userPayload.safeParse(event.payload);
    if (user.success && Array.isArray(user.data.message.content)) {
      for (const raw of user.data.message.content) {
        const toolResult = toolResultBlock.safeParse(raw);
        if (!toolResult.success) continue;
        const step = toolStepByUseId.get(toolResult.data.tool_use_id);
        if (!step) continue;
        step.toolResult = truncate(toolResultText(toolResult.data.content), RESULT_MAX);
        step.toolIsError = toolResult.data.is_error ?? false;
      }
      continue;
    }

    const result = resultPayload.safeParse(event.payload);
    if (result.success) {
      const r = result.data;
      const cost = `$${r.total_cost_usd.toFixed(4)}`;
      if (r.subtype === "success" && !r.is_error) {
        push(event, {
          kind: "result",
          title: `Finished in ${r.num_turns} turn${r.num_turns === 1 ? "" : "s"} for ${cost}`,
          detail: r.result,
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      } else {
        const reason = r.subtype === "success" ? r.result : r.errors.join("; ") || r.subtype;
        push(event, {
          kind: "error",
          title: `Failed: ${firstSentence(reason)}`,
          detail: reason,
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      }
      continue;
    }

    if (event.type === "clarification_asked") {
      const asked = clarificationAskedPayload.safeParse(event.payload);
      if (asked.success) {
        const count = asked.data.questions.length;
        push(event, {
          kind: "notice",
          title: `Paused to ask you ${count} question${count === 1 ? "" : "s"}`,
          detail: [asked.data.reason, ...asked.data.questions.map((q) => `- ${q}`)]
            .filter(Boolean)
            .join("\n"),
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      }
      continue;
    }

    if (event.type === "clarification_answered") {
      const answered = clarificationAnsweredPayload.safeParse(event.payload);
      if (answered.success) {
        const given = answered.data.answers.filter((a) => a.answer.length > 0);
        push(event, {
          kind: "notice",
          title:
            given.length === 0
              ? "Continuing without answers, on the agent's own assumptions"
              : `Continuing with ${given.length} answer${given.length === 1 ? "" : "s"} from you`,
          detail:
            answered.data.answers
              .map((a) => `- ${a.question}\n  ${a.answer || "(skipped)"}`)
              .join("\n") || null,
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      }
      continue;
    }

    if (event.type === "model_routing") {
      const routing = modelRoutingPayload.safeParse(event.payload);
      if (routing.success) {
        const { model, reasoning, rationale, routed, costUsd } = routing.data;
        const name = agentModelName(model);
        push(event, {
          kind: "routing",
          title: routed
            ? `Auto chose ${name}${reasoning ? " with extended thinking" : ""}`
            : `Auto fell back to ${name}`,
          detail:
            costUsd === null
              ? rationale
              : `${rationale}\n\nChoosing cost $${costUsd.toFixed(4)}, on top of the run's own cost.`,
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      }
      continue;
    }

    if (event.type === "run_cancelled") {
      const notice = mcpNoticePayload.safeParse(event.payload);
      push(event, {
        kind: "notice",
        title: "You stopped this run",
        detail: notice.success ? notice.data.message : null,
        toolName: null,
        mcpServer: null,
        toolResult: null,
        toolIsError: false,
      });
      continue;
    }

    if (event.type === "clarification_notice" || event.type === "mcp_notice") {
      const notice = mcpNoticePayload.safeParse(event.payload);
      if (notice.success) {
        push(event, {
          kind: "notice",
          title: firstSentence(notice.data.message),
          detail: notice.data.message,
          toolName: null,
          mcpServer: null,
          toolResult: null,
          toolIsError: false,
        });
      }
      continue;
    }

    if (event.type === "runner_error") {
      const err = runnerErrorPayload.safeParse(event.payload);
      const message = err.success ? err.data.message : "Unknown error";
      push(event, {
        kind: "error",
        title: `Failed: ${firstSentence(message)}`,
        detail: message,
        toolName: null,
        mcpServer: null,
        toolResult: null,
        toolIsError: false,
      });
    }
  }

  // A call that errored still counts: the agent did reach the server, and a
  // failed call is exactly the thing worth seeing.
  const mcpServersUsed = [
    ...new Set(steps.flatMap((step) => (step.mcpServer ? [step.mcpServer] : []))),
  ];

  return {
    steps,
    phase: derivePhase(steps, runStatus, cancelRequested),
    filesWritten: [...filesWritten],
    mcpServersUsed,
  };
}

function derivePhase(
  steps: RunStep[],
  runStatus: RunStatus,
  cancelRequested: boolean,
): RunPhase {
  if (runStatus === "succeeded") return "done";
  if (runStatus === "failed") return "failed";
  if (runStatus === "cancelled") return "cancelled";
  // A stop is on file and the loop has not reached its next boundary yet.
  // Whatever the agent was doing, what it is doing now is stopping.
  if (cancelRequested) return "stopping";
  // The run is parked on a question; nothing the step list says overrides that.
  if (runStatus === "awaiting_input") return "awaiting_input";
  const last = steps.at(-1);
  if (!last) return runStatus === "queued" ? "queued" : "starting";

  switch (last.kind) {
    case "init":
    case "routing":
      return "starting";
    case "thinking":
      return "thinking";
    case "text":
      return "summarising";
    case "notice":
      return runStatus === "queued" ? "queued" : "starting";
    case "result":
      return "done";
    case "error":
      return "failed";
    case "tool":
      if (last.toolResult !== null) return "thinking";
      if (last.mcpServer) return "using_mcp";
      switch (last.toolName) {
        case "WebSearch":
          return "searching";
        case "Write":
        case "Edit":
          return "writing";
        default:
          return "reading";
      }
  }
}