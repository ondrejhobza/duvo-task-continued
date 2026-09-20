import { extractStructured } from "@/lib/llm";
import {
  agentModelName,
  DEFAULT_AGENT_MODEL_ID,
  modelRoutingSchema,
  modelSupportsReasoning,
  type AgentModelId,
} from "@/lib/schema";

/**
 * Auto mode: one cheap model call decides which model runs the task.
 *
 * The routing call is on the critical path — the run cannot start until it
 * knows what to start — so it is kept to the cheapest model, a prompt of a few
 * dozen tokens and a short timeout. Every failure path returns the Sonnet
 * default rather than propagating: a run must never fail because picking a
 * model failed.
 */

/** The cheapest model in the catalogue. A dear router would defeat the point. */
const ROUTER_MODEL: AgentModelId = "claude-haiku-4-5";

/** Short on purpose: past this, falling back beats making the user wait. */
const ROUTER_TIMEOUT_MS = 15_000;

const ROUTER_SYSTEM = [
  "You route one automation task to the cheapest model that can do it well.",
  "The agent running the task can search the web, read pages, and write files.",
  "Choose exactly one model:",
  "- claude-haiku-4-5: a single lookup, a short reply, a trivial transformation. No extended thinking.",
  "- claude-sonnet-4-6: ordinary research or file writing over a handful of sources.",
  "- claude-sonnet-5: multi-step work across several sources, or a careful long document.",
  "- claude-opus-5: only genuinely hard, long, multi-step reasoning. Rarely the right answer.",
  "Set reasoning true only when the task needs real deliberation rather than retrieval,",
  "formatting or summarising; extended thinking is slower and costs more.",
  "rationale: one clause, at most 15 words, naming what decided it.",
].join("\n");

export interface RoutingOutcome {
  model: AgentModelId;
  reasoning: boolean;
  /** One line for the run's step list. */
  rationale: string;
  /** What the routing call itself cost, so it can be told apart from the run. */
  costUsd: number | null;
  /** False when the fallback answered, so the step can say so plainly. */
  routed: boolean;
}

function fallback(reason: string): RoutingOutcome {
  return {
    model: DEFAULT_AGENT_MODEL_ID,
    reasoning: false,
    rationale: `${reason}; falling back to ${agentModelName(DEFAULT_AGENT_MODEL_ID)}`,
    costUsd: null,
    routed: false,
  };
}

export async function routeModel(prompt: string): Promise<RoutingOutcome> {
  const result = await extractStructured({
    schema: modelRoutingSchema,
    system: ROUTER_SYSTEM,
    prompt: `Task:\n${prompt}`,
    model: ROUTER_MODEL,
    timeoutMs: ROUTER_TIMEOUT_MS,
  });

  // Covers a missing key, a timeout, a transport error, and a model that
  // answered with something the schema rejected.
  if (!result.ok) return fallback(`Auto could not choose a model (${result.error})`);

  const { model, rationale } = result.data;
  return {
    model,
    // The router can ask for thinking on a model that has none; the model it
    // picked is the binding half of the answer, so the flag gives way.
    reasoning: result.data.reasoning && modelSupportsReasoning(model),
    rationale,
    costUsd: result.costUsd,
    routed: true,
  };
}
