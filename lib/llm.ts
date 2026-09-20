import { tmpdir } from "node:os";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * One-shot structured extraction: ask a model a question, get back a value
 * that has been validated against a Zod schema, or a reason why not.
 *
 * The model is constrained server-side by a JSON schema (`outputFormat`) and
 * the result arrives as a `structured_output` attachment, so no model text is
 * ever hand-parsed. Every failure — no key, transport error, schema mismatch,
 * timeout — comes back as `{ ok: false }` for the caller to handle.
 */

/** Judging a few thousand words is a short call; anything longer is stuck. */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Aliases track the current model generation, so they do not go stale. */
const DEFAULT_MODEL = "sonnet";

export type StructuredResult<T> =
  | { ok: true; data: T; model: string | null; costUsd: number | null }
  | { ok: false; error: string };

export interface ExtractStructuredOptions<T> {
  schema: z.ZodType<T>;
  /** Who the model is and how it should behave. */
  system: string;
  /** The material to reason about. */
  prompt: string;
  model?: string;
  timeoutMs?: number;
}

/** The API rejects the `$schema` annotation Zod adds by default. */
function toJsonSchema(schema: z.ZodType<unknown>): Record<string, unknown> {
  const json: Record<string, unknown> = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  });
  delete json.$schema;
  return json;
}

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

function describeResult(result: ResultMessage): string {
  if (result.subtype === "success") return "The model returned no structured output.";
  const detail = result.errors.length > 0 ? `: ${result.errors.join("; ")}` : "";
  switch (result.subtype) {
    case "error_max_structured_output_retries":
      return `The model could not produce output matching the schema${detail}`;
    case "error_max_turns":
      return `The model hit the turn limit${detail}`;
    case "error_max_budget_usd":
      return `The model hit the cost budget${detail}`;
    default:
      return `The model stopped with ${result.subtype}${detail}`;
  }
}

export async function extractStructured<T>(
  options: ExtractStructuredOptions<T>,
): Promise<StructuredResult<T>> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY is not set on the server." };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const stream = query({
      prompt: options.prompt,
      options: {
        abortController,
        // A judge reads what it is given; it must not reach the disk or the web.
        cwd: tmpdir(),
        systemPrompt: options.system,
        model: options.model ?? DEFAULT_MODEL,
        tools: [],
        allowedTools: [],
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"],
        permissionMode: "default",
        permissionPrompts: "none",
        settingSources: [],
        persistSession: false,
        maxTurns: 3,
        outputFormat: { type: "json_schema", schema: toJsonSchema(options.schema) },
      },
    });

    let result: ResultMessage | null = null;
    let model: string | null = null;
    for await (const message of stream) {
      // `modelUsage` also counts internal helper calls, so the init message is
      // the only reliable source of the model that actually did the judging.
      if (message.type === "system" && message.subtype === "init") model = message.model;
      if (message.type === "result") result = message;
    }

    if (!result) {
      return { ok: false, error: "The model stream ended without a result." };
    }
    if (result.subtype !== "success" || result.structured_output === undefined) {
      return { ok: false, error: describeResult(result) };
    }

    const parsed = options.schema.safeParse(result.structured_output);
    if (!parsed.success) {
      return {
        ok: false,
        error: `The model's output did not match the schema: ${z.prettifyError(parsed.error)}`,
      };
    }

    return { ok: true, data: parsed.data, model, costUsd: result.total_cost_usd };
  } catch (error) {
    if (abortController.signal.aborted) {
      return { ok: false, error: "The model did not answer in time." };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
