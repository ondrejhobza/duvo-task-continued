import { z } from "zod";
import { extractStructured } from "@/lib/llm";
import type { McpServerConfigRow } from "@/lib/repo";

/**
 * Decides which connected MCP servers a run should actually get.
 *
 * Attaching a server is not free: its tool definitions sit in the model's
 * context for every turn (the hosted Notion server alone advertises about
 * thirty), and a model holding those tools reaches for them on tasks that
 * never needed them. "Reply with the single word OK" should carry none.
 *
 * A keyword match on the server's name would fail the interesting half of the
 * cases — "summarise what I wrote about pricing last week" means Notion without
 * saying so — hence a small, cheap model call. It is deliberately biased
 * towards attaching: a missing tool makes the agent fabricate or apologise,
 * while a spare one only costs latency.
 */

/** Small model, short leash: this decision must never dominate a run. */
const GATE_MODEL = "haiku";
const GATE_TIMEOUT_MS = 20_000;

/** How many advertised tools to show the gate as evidence of what a server does. */
const TOOL_HINT_LIMIT = 10;

const decisionSchema = z.object({
  /** Keys of the servers worth attaching; empty means none. */
  servers: z.array(z.string()),
  /** One short clause explaining the call, for the run's step list. */
  reason: z.string().max(200),
});

export interface McpSelection {
  attach: McpServerConfigRow[];
  /** One line for the step list, so "why didn't it use Notion?" is answerable. */
  reason: string;
}

const SYSTEM = [
  "You decide which connected tool servers an automation agent should be given for one task.",
  "Attaching a server injects all of its tools into the agent's context, which costs money and makes it more likely to use them when it should not. Attaching nothing is the right answer for self-contained tasks.",
  "Attach a server when the task plausibly needs it, including when the need is implied rather than stated: 'what did I write about pricing' or 'check my docs' imply a workspace server even though they name none.",
  "Do not attach anything for tasks the agent can finish on its own: answering a question from general knowledge, writing prose, doing arithmetic, or following a direct instruction like 'reply with OK'.",
  "Web search and local file writing are always available to the agent and are never a reason to attach a server.",
  "When you are genuinely unsure, attach. A missing tool makes the agent fail the task; a spare tool only costs a little time.",
  "Answer with the servers' keys exactly as given, and one short clause saying why.",
].join(" ");

/** Word-boundary and case-insensitive, so "Notion" matches but "notional" does not. */
function mentions(prompt: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(prompt);
}

/** The user naming a server is an explicit instruction, not a hint to weigh. */
export function namedInPrompt(prompt: string, server: { name: string; key: string }): boolean {
  return mentions(prompt, server.name) || mentions(prompt, server.key);
}

function list(servers: { name: string }[]): string {
  const names = servers.map((s) => s.name);
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function describe(server: McpServerConfigRow): string {
  const tools = [...server.allowedTools, ...server.writeTools].slice(0, TOOL_HINT_LIMIT);
  const hint = tools.length > 0 ? ` — tools include: ${tools.join(", ")}` : "";
  return `- ${server.key}: ${server.name}${hint}`;
}

export async function selectMcpServers(
  prompt: string,
  enabled: McpServerConfigRow[],
): Promise<McpSelection> {
  if (enabled.length === 0) {
    return { attach: [], reason: "No MCP servers were switched on for this run." };
  }

  // Naming a server overrides the gate entirely, so a user can always force one.
  const named = enabled.filter((server) => namedInPrompt(prompt, server));
  if (named.length === enabled.length) {
    return { attach: enabled, reason: `Attached ${list(enabled)}: named in the task.` };
  }

  const decision = await extractStructured({
    schema: decisionSchema,
    system: SYSTEM,
    prompt: [
      "Connected servers:",
      enabled.map(describe).join("\n"),
      "",
      "The task:",
      prompt,
    ].join("\n"),
    model: GATE_MODEL,
    timeoutMs: GATE_TIMEOUT_MS,
  });

  if (!decision.ok) {
    // Falling back to "attach everything" keeps a run that needs a tool working.
    return {
      attach: enabled,
      reason: `Attached ${list(enabled)}: could not judge what the task needs (${decision.error}).`,
    };
  }

  const wanted = new Set(decision.data.servers.map((key) => key.trim().toLowerCase()));
  const attach = enabled.filter(
    (server) => wanted.has(server.key.toLowerCase()) || named.includes(server),
  );

  if (attach.length === 0) {
    return {
      attach,
      reason: `No MCP servers attached: ${decision.data.reason}`,
    };
  }
  return { attach, reason: `Attached ${list(attach)}: ${decision.data.reason}` };
}
