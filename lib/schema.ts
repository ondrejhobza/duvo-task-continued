import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  /** Paused: the agent asked the user to clarify the task and is waiting for answers. */
  "awaiting_input",
  "succeeded",
  "failed",
  /** The user stopped the run. Terminal, and deliberately not a failure. */
  "cancelled",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

// ---------- Models the agent can run on ----------

/**
 * API model identifiers, deliberately kept apart from the display names below:
 * renaming a model in the UI must never change what is sent to the SDK.
 *
 * Every id here comes from the model catalogue baked into the vendored CLI
 * (`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`), which is
 * also the list the `Model` union in `@anthropic-ai/sdk` publishes.
 */
export const agentModelIdSchema = z.enum([
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);
export type AgentModelId = z.infer<typeof agentModelIdSchema>;

/**
 * Family aliases the picker stored before it offered versioned ids. Still valid
 * SDK input, so runs that recorded one keep rendering and would still replay.
 * New runs cannot be created with one; `agentModelIdSchema` is what the route
 * accepts.
 */
export const legacyAgentModelAliasSchema = z.enum(["opus", "sonnet", "haiku"]);
export type LegacyAgentModelAlias = z.infer<typeof legacyAgentModelAliasSchema>;

/**
 * "Let the system choose". A selection mode, not a model: it never reaches the
 * SDK, which only ever sees a concrete `AgentModelId` the router resolved to.
 */
export const AUTO_MODEL_SELECTION = "auto";

/** What the user may ask for: a named model, or Auto. */
export const modelSelectionSchema = z.union([
  z.literal(AUTO_MODEL_SELECTION),
  agentModelIdSchema,
]);
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

/** What a run row may hold: a selection, or an alias from before the rename. */
export const storedModelSelectionSchema = z.union([
  modelSelectionSchema,
  legacyAgentModelAliasSchema,
]);
export type StoredModelSelection = z.infer<typeof storedModelSelectionSchema>;

export function isAutoSelection(value: unknown): value is typeof AUTO_MODEL_SELECTION {
  return value === AUTO_MODEL_SELECTION;
}

export interface AgentModel {
  id: AgentModelId;
  name: string;
  /** One-word positioning shown next to the name in the picker. */
  tag: string;
  /**
   * Whether the catalogue lists `adaptive_thinking` for this model. Only these
   * are offered the reasoning toggle; the rest run with thinking disabled, so
   * the switch is never a control that quietly does nothing.
   */
  supportsReasoning: boolean;
}

/** Short and ordered by capability; the tag is the one-word positioning. */
export const AGENT_MODELS: readonly AgentModel[] = [
  { id: "claude-opus-5", name: "Claude Opus 5", tag: "Flagship", supportsReasoning: true },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", tag: "Balanced", supportsReasoning: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", tag: "Proven", supportsReasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tag: "Fast", supportsReasoning: false },
];

/**
 * The one definition of "no choice was made"; every other default, and every
 * fallback from a stale or failed selection, defers to it.
 */
export const DEFAULT_AGENT_MODEL_ID: AgentModelId = "claude-sonnet-5";

/** The picker's first row. Auto is opt-in; Sonnet stays the default. */
export const AUTO_MODEL_OPTION = {
  id: AUTO_MODEL_SELECTION,
  name: "Auto",
  tag: "Adaptive",
  hint: "Picks a model to suit the task",
} as const;

/** Which model each retired alias tracked, for migrating a stale stored pick. */
const LEGACY_ALIAS_SUCCESSOR: Record<LegacyAgentModelAlias, AgentModelId> = {
  opus: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/**
 * An alias records only the family a run asked for, so it is named as such
 * rather than dressed up as whichever version it happened to resolve to.
 */
const LEGACY_ALIAS_NAME: Record<LegacyAgentModelAlias, string> = {
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
  haiku: "Claude Haiku",
};

/**
 * Anything at all -> a model that exists, so a stale localStorage value, a
 * model dropped from the list, or a router that answered nonsense all land on
 * the default instead of crashing or blocking the run.
 */
export function resolveAgentModelId(value: unknown): AgentModelId {
  const current = agentModelIdSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = legacyAgentModelAliasSchema.safeParse(value);
  if (legacy.success) return LEGACY_ALIAS_SUCCESSOR[legacy.data];
  return DEFAULT_AGENT_MODEL_ID;
}

/** Anything at all -> a selection the picker can show, Auto included. */
export function resolveModelSelection(value: unknown): ModelSelection {
  if (isAutoSelection(value)) return AUTO_MODEL_SELECTION;
  return resolveAgentModelId(value);
}

/** Null when nothing usable was recorded, so callers can render an em dash. */
export function agentModelLabel(id: StoredModelSelection | null): string | null {
  if (isAutoSelection(id)) return AUTO_MODEL_OPTION.name;
  const current = AGENT_MODELS.find((m) => m.id === id);
  if (current) return current.name;
  const legacy = legacyAgentModelAliasSchema.safeParse(id);
  return legacy.success ? LEGACY_ALIAS_NAME[legacy.data] : null;
}

export function agentModelName(id: StoredModelSelection | null): string {
  return agentModelLabel(id) ?? "Default model";
}

/**
 * "claude-sonnet-4-6-20260514" -> "Claude Sonnet 4.6". Derived rather than
 * listed so a model the picker no longer offers — or a dated id the API
 * reported back — still renders as itself instead of as a raw string. The
 * shape mirrors the catalogue's own display names (Sonnet 4.6, Haiku 4.5).
 */
export function formatModelId(apiId: string): string | null {
  const match = /^claude-([a-z]+)-(\d+(?:-\d+)?)(?:-\d{8})?$/.exec(apiId);
  if (!match) return null;
  const [, family, version] = match;
  return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${version.replace("-", ".")}`;
}

/**
 * How one run's model should read. A discriminated union rather than a string
 * so "we never recorded the version" cannot be confused with a version.
 */
export type RunModelDisplay =
  | { state: "known"; name: string; apiId: string; auto: boolean }
  /** A family alias was stored and the run never reported a model. */
  | { state: "unversioned"; name: string }
  /** An Auto run that has not been started, so nothing has been chosen yet. */
  | { state: "pending" }
  /** Predates the model being recorded at all. */
  | { state: "none" };

/**
 * The single place any surface turns a run into a model label, so the table,
 * the run page and the picker can never disagree.
 */
export function describeRunModel(
  run: Pick<Run, "requestedModel" | "resolvedModel" | "model">,
): RunModelDisplay {
  const auto = isAutoSelection(run.requestedModel);
  // Most precise first: what the SDK reported it actually ran, then what was
  // resolved at start, then a concrete id the picker recorded.
  const apiId =
    run.model ??
    run.resolvedModel ??
    agentModelIdSchema.safeParse(run.requestedModel).data ??
    null;

  if (apiId !== null) {
    return {
      state: "known",
      // The picker's own wording wins where it has an entry, so the two agree.
      name: AGENT_MODELS.find((m) => m.id === apiId)?.name ?? formatModelId(apiId) ?? apiId,
      apiId,
      auto,
    };
  }

  // An alias resolved at call time, so for a run that never reported back, the
  // version that would have run is genuinely not on file. Naming the current
  // one would corrupt exactly the cost comparison this column exists for.
  const legacy = legacyAgentModelAliasSchema.safeParse(run.requestedModel);
  if (legacy.success) return { state: "unversioned", name: LEGACY_ALIAS_NAME[legacy.data] };

  if (auto) return { state: "pending" };
  return { state: "none" };
}

/** Auto is excluded: which model it lands on, and so whether thinking is on, is its call. */
export function modelSupportsReasoning(id: StoredModelSelection | null): boolean {
  return AGENT_MODELS.some((m) => m.id === id && m.supportsReasoning);
}

/** What the router must return. Constrained to real ids so it cannot invent one. */
export const modelRoutingSchema = z.object({
  model: agentModelIdSchema,
  /** Whether the task is worth extended thinking. */
  reasoning: z.boolean(),
  /** One short clause naming why, shown as a step in the run. */
  rationale: z.string().trim().min(1).max(200),
});
export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const createRunSchema = z
  .object({
    prompt: z
      .string()
      .trim()
      .min(1, "Give the agent some instructions.")
      .max(4000, "Keep instructions under 4000 characters."),
    // A request that names no model is a valid request, so the boundary itself
    // settles it rather than leaving a null for the runner to interpret. A tab
    // left open from before the rename still speaks in aliases; those are known
    // values, so they are normalised here rather than rejected. Genuinely
    // unknown ids still fail, which is what a 400 with issues is for.
    model: storedModelSelectionSchema
      .default(DEFAULT_AGENT_MODEL_ID)
      .transform(resolveModelSelection),
    /** Extended thinking. Off unless asked for: it is slower and costs more. */
    reasoning: z.boolean().default(false),
  })
  .refine((v) => !v.reasoning || modelSupportsReasoning(v.model), {
    // Covers Auto too: it decides thinking for itself, so accepting a toggle
    // here would be accepting a setting that the router then overrides.
    message: "This model does not support extended thinking.",
    path: ["reasoning"],
  });
export type CreateRunInput = z.infer<typeof createRunSchema>;

// ---------- Paging through the run history ----------

export const RUNS_PAGE_SIZE = 20;
const RUNS_PAGE_SIZE_MAX = 100;

/**
 * Keyset cursor: the (createdAt, id) of the last row already shown. Paging by
 * position would skip or repeat rows, and runs are started from the same page
 * that is being paged.
 */
export const runCursorSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
export type RunCursor = z.infer<typeof runCursorSchema>;

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(RUNS_PAGE_SIZE_MAX).default(RUNS_PAGE_SIZE),
  cursorCreatedAt: z.iso.datetime().optional(),
  cursorId: z.uuid().optional(),
});
export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>;

// ---------- MCP servers ----------

export const mcpTransportSchema = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

/** Server key as used in the Agent SDK config and tool names (mcp__<key>__tool). */
export const mcpServerKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "Use lowercase letters, digits and dashes");

const secretMapSchema = z.record(z.string().min(1), z.string());

/** How the platform proves who it is to the server. */
export const mcpAuthModeSchema = z.enum(["none", "oauth", "token"]);
export type McpAuthMode = z.infer<typeof mcpAuthModeSchema>;

/** What the browser is allowed to know about a server's credentials. */
export const mcpAuthStatusSchema = z.enum([
  "not_required",
  "needs_auth",
  "connected",
  "error",
]);
export type McpAuthStatus = z.infer<typeof mcpAuthStatusSchema>;

export const createMcpServerSchema = z
  .object({
    key: mcpServerKeySchema,
    name: z.string().trim().min(1).max(80),
    transport: mcpTransportSchema,
    command: z.string().trim().max(500).optional(),
    args: z.array(z.string()).max(50).default([]),
    url: z.url().optional(),
    env: secretMapSchema.default({}),
    headers: secretMapSchema.default({}),
    /** Read-safe tool names (without the mcp__key__ prefix). Empty = expose everything. */
    allowedTools: z.array(z.string().min(1)).default([]),
    /** Mutating tool names, only exposed once the user opts into writes. */
    writeTools: z.array(z.string().min(1)).default([]),
    authMode: mcpAuthModeSchema.default("none"),
    /** OAuth scope to ask for; the server's metadata decides the default when omitted. */
    scope: z.string().trim().max(500).optional(),
    allowWrites: z.boolean().default(false),
  })
  .refine((s) => (s.transport === "stdio" ? Boolean(s.command) : Boolean(s.url)), {
    message: "stdio servers need a command, http servers need a URL",
    path: ["transport"],
  })
  .refine((s) => s.authMode !== "oauth" || s.transport === "http", {
    message: "OAuth only works with remote (http) MCP servers",
    path: ["authMode"],
  });
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;

export const updateMcpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowWrites: z.boolean().optional(),
  })
  .refine((v) => v.enabled !== undefined || v.allowWrites !== undefined, {
    message: "Nothing to update.",
  });
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

/** What the browser sees: secrets and tokens are reduced to names and a status. */
export const mcpServerSchema = z.object({
  id: z.uuid(),
  key: mcpServerKeySchema,
  name: z.string(),
  transport: mcpTransportSchema,
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  envKeys: z.array(z.string()),
  headerKeys: z.array(z.string()),
  allowedTools: z.array(z.string()),
  writeTools: z.array(z.string()),
  allowWrites: z.boolean(),
  authMode: mcpAuthModeSchema,
  authStatus: mcpAuthStatusSchema,
  authError: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type McpServer = z.infer<typeof mcpServerSchema>;

/** Response of POST /api/mcp-servers/[id]/oauth: where to send the user. */
export const oauthStartResponseSchema = z.object({ authorizeUrl: z.url() });

/**
 * Response of DELETE /api/mcp-servers/[id]/oauth. `warning` is set when the
 * local credentials were dropped but the remote grant may have survived.
 */
export const oauthDisconnectResponseSchema = z.object({ warning: z.string().nullable() });

/** Query string the authorization server sends back to the callback route. */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  error_description: z.string().optional(),
});
export type OauthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

// ---------- Notion's hosted MCP server (OAuth, streamable HTTP) ----------

export const NOTION_REMOTE_KEY = "notion";
/** Used when a local Notion server already owns the plain "notion" key. */
export const NOTION_REMOTE_FALLBACK_KEY = "notion-remote";
export const NOTION_REMOTE_NAME = "Notion";
export const NOTION_REMOTE_URL = "https://mcp.notion.com/mcp";

// The hosted server's tools are deliberately not listed here. It advertises
// them over MCP once OAuth provides a token (see lib/mcp-tools.ts), and a copy
// kept in this repo would quietly pin the agent to an older surface.

/** A file name as written by the agent: single path segment, no traversal. */
export const artifactNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^/\\]+$/, "Artifact name must be a single path segment")
  .refine((n) => n !== "." && n !== "..", "Invalid artifact name");

export const artifactSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  name: artifactNameSchema,
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  createdAt: z.iso.datetime(),
});
export type Artifact = z.infer<typeof artifactSchema>;

// ---------- Observability: steps derived from the raw SDK event log ----------

export const runStepKindSchema = z.enum([
  "init",
  /** Auto mode explaining which model it chose for this task, and why. */
  "routing",
  "thinking",
  "text",
  "tool",
  "result",
  /** Something the run survived, e.g. an MCP server that could not be reached. */
  "notice",
  "error",
]);
export type RunStepKind = z.infer<typeof runStepKindSchema>;

export const runStepSchema = z.object({
  /** Sequence number of the event that produced the step; stable across polls. */
  seq: z.number().int(),
  kind: runStepKindSchema,
  /** One short line: what the agent is doing at this point. */
  title: z.string(),
  /** Full detail for the dropdown: thinking text, tool input, etc. */
  detail: z.string().nullable(),
  /** Tool steps only. */
  toolName: z.string().nullable(),
  /** MCP server name when the tool is an MCP tool, e.g. "notion". */
  mcpServer: z.string().nullable(),
  /** Tool steps only: the tool's output once it arrived (truncated). */
  toolResult: z.string().nullable(),
  toolIsError: z.boolean(),
  /** Milliseconds since the run started. */
  atMs: z.number().int().nonnegative(),
});
export type RunStep = z.infer<typeof runStepSchema>;

export const runPhaseSchema = z.enum([
  "queued",
  "awaiting_input",
  "starting",
  "thinking",
  "searching",
  "reading",
  "writing",
  "using_mcp",
  "summarising",
  /** A stop was asked for and the loop has not reached its next boundary yet. */
  "stopping",
  "done",
  "failed",
  "cancelled",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const PHASE_LABEL: Record<RunPhase, string> = {
  queued: "Waiting to start",
  awaiting_input: "Waiting for your answers",
  starting: "Starting the agent",
  thinking: "Thinking about the next step",
  searching: "Searching the web",
  reading: "Reading a source",
  writing: "Writing output files",
  using_mcp: "Talking to an MCP server",
  summarising: "Writing the summary",
  stopping: "Stopping",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped by you",
};

// ---------- Clarification: the run can pause and ask the user questions ----------
//
// A separate axis from `runStatus`: the status says where the run is, this says
// whether the question round has happened yet. Persisted so a reload, or a
// revisit from the runs list, finds the pending questions instead of losing them.

/** Hard cap. Three questions is already an interrogation; more is never worth it. */
export const MAX_CLARIFICATION_QUESTIONS = 3;
export const MAX_CLARIFICATION_OPTIONS = 5;

export const clarificationQuestionTypeSchema = z.enum([
  /** Pick one; the UI auto-advances. */
  "radio",
  /** Pick any number; the UI waits for Continue. */
  "check",
]);
export type ClarificationQuestionType = z.infer<typeof clarificationQuestionTypeSchema>;

/** What the planner model is constrained to emit. Ids are added on our side. */
export const clarificationPlanSchema = z.object({
  needsClarification: z.boolean(),
  /** One sentence: why asking (or not asking) is the right call. Kept for the step log. */
  reason: z.string().max(300),
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(160),
        type: clarificationQuestionTypeSchema,
        options: z.array(z.string().min(1).max(80)).max(MAX_CLARIFICATION_OPTIONS),
      }),
    )
    .max(MAX_CLARIFICATION_QUESTIONS),
});
export type ClarificationPlan = z.infer<typeof clarificationPlanSchema>;

/**
 * What a pending input looks like on the wire. Two shapes, one list: a question
 * with options (asked before the run starts, or by the agent mid-run) and an
 * open request for a value the agent cannot obtain itself — a private URL, a
 * preference with no right answer.
 */
export const choiceInputSchema = z.object({
  /** App-generated UUID; answers reference it, so reordering cannot mis-file an answer. */
  id: z.string().min(1),
  kind: z.literal("choice"),
  question: z.string().min(1),
  type: clarificationQuestionTypeSchema,
  options: z.array(z.string()),
});
export type ChoiceInput = z.infer<typeof choiceInputSchema>;

/** The shape a typed answer has to take, so nonsense is caught at the boundary. */
export const inputValueHintSchema = z.enum(["text", "url", "number"]);
export type InputValueHint = z.infer<typeof inputValueHintSchema>;

export const textInputSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("text"),
  question: z.string().min(1),
  hint: inputValueHintSchema,
  /** Example of the value wanted, shown in the field. */
  placeholder: z.string(),
});
export type TextInput = z.infer<typeof textInputSchema>;

export const pendingInputSchema = z.discriminatedUnion("kind", [
  choiceInputSchema,
  textInputSchema,
]);
export type PendingInput = z.infer<typeof pendingInputSchema>;

/**
 * Validates one typed answer against the shape its request asked for. Shared by
 * the route (400 with issues) and the card (inline message before submitting),
 * so the user never hears two different stories about the same value.
 */
export function inputValueSchema(request: PendingInput) {
  if (request.kind === "choice") return z.string();
  switch (request.hint) {
    case "url":
      return z.url("Enter a full URL, starting with http:// or https://");
    case "number":
      return z
        .string()
        .refine((v) => v.trim() !== "" && Number.isFinite(Number(v)), "Enter a number");
    default:
      return z.string().min(1, "Enter a value, or skip this one");
  }
}

/** The message to show beside a field, or null when the value is acceptable. */
export function inputValueError(request: PendingInput, value: string): string | null {
  const parsed = inputValueSchema(request).safeParse(value);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "This value is not valid";
}

/**
 * Room for a pasted answer — a long URL, a list, a paragraph of context — in a
 * field that now looks like the composer and so invites one. Enforced here and
 * mirrored by the field's own limit, so a paste is never silently clipped.
 */
export const ANSWER_TEXT_MAX = 2000;

export const clarificationAnswerSchema = z.object({
  questionId: z.string().min(1),
  /** Options the user picked; empty when they only typed something or skipped. */
  selected: z.array(z.string().max(200)).max(MAX_CLARIFICATION_OPTIONS).default([]),
  /** The "Something else…" escape hatch, so the offered options are never a trap. */
  text: z.string().trim().max(ANSWER_TEXT_MAX).default(""),
  skipped: z.boolean().default(false),
});
export type ClarificationAnswer = z.infer<typeof clarificationAnswerSchema>;

/** An answer only counts as an answer when it says something. */
export function hasClarificationAnswer(answer: ClarificationAnswer): boolean {
  return !answer.skipped && (answer.selected.length > 0 || answer.text.length > 0);
}

/**
 * Body of POST /api/runs/[id]/clarify. `proceedWithout` is the escape hatch: a
 * run must never be strandable in `awaiting_input`, so "just do it" is always
 * one request away, with or without partial answers.
 */
export const submitClarificationSchema = z.object({
  answers: z.array(clarificationAnswerSchema).max(MAX_CLARIFICATION_QUESTIONS).default([]),
  proceedWithout: z.boolean().default(false),
});
export type SubmitClarificationInput = z.infer<typeof submitClarificationSchema>;

export const clarificationStateSchema = z.enum([
  /** Not looked at yet: the run has not reached the planner. */
  "pending",
  /** The planner decided the prompt was clear enough. The common case. */
  "not_needed",
  /** Questions are on the table and the run is paused. */
  "awaiting",
  /**
   * The agent stopped partway through and asked for something only the user can
   * supply. Distinct from `awaiting` because the work already done must be kept:
   * the runner is still holding the session open, waiting for the answer.
   */
  "awaiting_mid_run",
  /** The user answered at least one question and the run resumed. */
  "answered",
  /** The user declined; the agent proceeds on its own assumptions. */
  "skipped",
  /** The planner call failed. Never blocks: the run just goes ahead. */
  "unavailable",
]);
export type ClarificationState = z.infer<typeof clarificationStateSchema>;

export const runClarificationSchema = z.object({
  state: clarificationStateSchema,
  /** Named `questions` because that is the column; holds both input shapes. */
  questions: z.array(pendingInputSchema),
  answers: z.array(clarificationAnswerSchema),
});
export type RunClarification = z.infer<typeof runClarificationSchema>;

/** Is the run stopped, waiting for the user to type or choose something? */
export function isAwaitingInput(state: ClarificationState): boolean {
  return state === "awaiting" || state === "awaiting_mid_run";
}

/**
 * Identifies one round of questions. A run may stop for the user several times,
 * and each stop replaces the questions on the row, so the answering card is
 * mounted under this key: a new round gets an empty field, a fresh focus and no
 * memory of the answer before it.
 */
export function clarificationRoundKey(clarification: RunClarification): string {
  return clarification.questions.map((question) => question.id).join("|");
}

// ---------- Evaluation ----------
//
// Deliberately a separate axis from `runStatus`. `runStatus` answers "did the
// agent loop terminate without throwing"; the verdict below answers "did the
// run finish what the user asked for". A run can be `succeeded` and `fail`.

/**
 * How far the evaluation got. Separate from the verdict so "we have no answer"
 * never has to be encoded as a bad answer.
 */
export const evaluationStatusSchema = z.enum([
  "pending",
  "running",
  /** A verdict was reached, by the gate or by the judge. */
  "done",
  /** The judge could not be reached or returned nothing usable; retry offered. */
  "unavailable",
  /** The run itself never finished, so "did it do what was asked" has no answer. */
  "not_evaluable",
]);
export type EvaluationStatus = z.infer<typeof evaluationStatusSchema>;

/**
 * Did the artifact accomplish the user's request?
 * `partial` is its own value because most real shortfalls are "4 of the 5
 * things asked for", and collapsing that into `fail` throws away the only
 * detail that tells the user whether to re-run or just patch the output.
 */
export const verdictSchema = z.enum(["pass", "partial", "fail", "inconclusive"]);
export type Verdict = z.infer<typeof verdictSchema>;

/** Only `pass` counts as "finished what the user wanted". */
export function isSuccessfulVerdict(verdict: Verdict | null): boolean {
  return verdict === "pass";
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "Did what was asked",
  partial: "Partly did what was asked",
  fail: "Did not do what was asked",
  inconclusive: "Cannot tell",
};

export const gateCheckSchema = z.object({
  label: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type GateCheck = z.infer<typeof gateCheckSchema>;

/** One discrete thing the user's task asked for, checked against the artifact. */
export const requirementCheckSchema = z.object({
  requirement: z.string(),
  met: z.enum(["yes", "partly", "no"]),
  /** Evidence from the artifact, or a statement of what is missing. */
  evidence: z.string(),
});
export type RequirementCheck = z.infer<typeof requirementCheckSchema>;

/** The shape the judge model is constrained to emit. */
export const judgeResultSchema = z.object({
  verdict: verdictSchema,
  confidence: z.number().int().min(0).max(100),
  /** One or two sentences naming the requirement that decided the verdict. */
  rationale: z.string(),
  requirements: z.array(requirementCheckSchema),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export const evaluationSchema = z.object({
  runId: z.uuid(),
  status: evaluationStatusSchema,
  gatePassed: z.boolean(),
  gateChecks: z.array(gateCheckSchema),
  /** The artifact the verdict is about; null when none was usable. */
  artifactName: z.string().nullable(),
  judgeVerdict: verdictSchema.nullable(),
  judgeConfidence: z.number().int().nullable(),
  judgeRationale: z.string().nullable(),
  judgeRequirements: z.array(requirementCheckSchema),
  judgeError: z.string().nullable(),
  judgeModel: z.string().nullable(),
  costUsd: z.number().nullable(),
  humanVerdict: verdictSchema.nullable(),
  humanNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Evaluation = z.infer<typeof evaluationSchema>;

/**
 * Human beats judge beats gate. Returns null while there is no answer yet, so
 * "still evaluating" and "judged inconclusive" never look the same.
 */
export function effectiveVerdict(evaluation: Evaluation | null): Verdict | null {
  if (!evaluation) return null;
  if (evaluation.humanVerdict) return evaluation.humanVerdict;
  if (evaluation.status !== "done") return null;
  if (!evaluation.gatePassed) return "fail";
  return evaluation.judgeVerdict;
}

export function isEvaluationInFlight(evaluation: Evaluation | null): boolean {
  return evaluation?.status === "pending" || evaluation?.status === "running";
}

/** A person is asked to commit; `inconclusive` is not on offer. */
export const humanVerdictValueSchema = z.enum(["pass", "partial", "fail"]);

export const humanVerdictSchema = z
  .object({
    verdict: humanVerdictValueSchema,
    note: z.string().trim().max(500).default(""),
  })
  .refine((v) => v.verdict === "pass" || v.note.length > 0, {
    message: "Say what the run did not do.",
    path: ["note"],
  });
export type HumanVerdictInput = z.infer<typeof humanVerdictSchema>;

/**
 * What a follow-up run inherited from the run it continues.
 *
 * The distinction is the whole honesty of the feature: `resumed` means the
 * agent is the same conversation carrying on and genuinely remembers its own
 * work, while `seeded` means the session was gone and a fresh agent was handed
 * a written account of it instead. The UI says which, because a user who
 * believes the first while the second is true writes follow-ups that make no
 * sense to the agent reading them.
 */
export const continuationSchema = z.enum([
  /** Not a follow-up. */
  "none",
  /** The earlier session was reopened: full memory of the work. */
  "resumed",
  /** The session was gone; the earlier run was summarised into the prompt. */
  "seeded",
]);
export type Continuation = z.infer<typeof continuationSchema>;

export const runSchema = z.object({
  id: z.uuid(),
  prompt: z.string(),
  artifacts: z.array(artifactSchema),
  /** Display names of the MCP servers that were enabled for this run. */
  mcpServers: z.array(z.string()),
  /** The question round: what was asked, what came back, and how it ended. */
  clarification: runClarificationSchema,
  evaluation: evaluationSchema.nullable(),
  status: runStatusSchema,
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  /** What the user picked before starting; null on runs created before the picker existed. */
  requestedModel: storedModelSelectionSchema.nullable(),
  /**
   * The concrete model the run was started on, which for an Auto run is what
   * the router chose. Null on runs that predate this being recorded.
   */
  resolvedModel: agentModelIdSchema.nullable(),
  /** Whether extended thinking was asked for; false on runs created before the toggle. */
  reasoning: z.boolean(),
  /** What the agent actually reported running on, once it started. */
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  numTurns: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
  /**
   * When the user asked for this run to stop. Set while the loop is still
   * winding down, and kept afterwards, so "stopped" and "stopped itself" stay
   * distinguishable. Null on every run nobody stopped.
   */
  cancelRequestedAt: z.iso.datetime().nullable(),
  /**
   * The run this one continues. Null on a run started from the composer, which
   * is every run that predates follow-ups.
   */
  parentRunId: z.uuid().nullable().default(null),
  /** How much of the earlier run this one actually carries; see `Continuation`. */
  continuation: continuationSchema.default("none"),
  /**
   * Whether this run's own session can still be picked up by a follow-up. Read
   * from disk when the run is loaded, because a session outlives neither a
   * cleared transcript directory nor a `persistSession: false` run.
   */
  resumable: z.boolean().default(false),
});
export type Run = z.infer<typeof runSchema>;

/**
 * Following up is offered on anything that has stopped, failures and stopped
 * runs included: "that did not work, try it this way" is the most common thing
 * a user wants next, and refusing it there would send them back to the top of
 * the page to retype the whole task.
 */
export function canFollowUp(run: Pick<Run, "status">): boolean {
  return isTerminalRunStatus(run.status);
}

/**
 * The single rule both the live panel and the run page ask, so the stop
 * control can never be offered in one place and withheld in the other.
 */
export function canRequestCancellation(
  run: Pick<Run, "status" | "cancelRequestedAt">,
): boolean {
  return !isTerminalRunStatus(run.status) && run.cancelRequestedAt === null;
}

/** A stop was asked for and the run has not landed on `cancelled` yet. */
export function isCancelling(
  run: Pick<Run, "status" | "cancelRequestedAt">,
): boolean {
  return !isTerminalRunStatus(run.status) && run.cancelRequestedAt !== null;
}

/**
 * Body of POST /api/runs/[id]/cancel. Deliberately empty: stopping is not a
 * decline, so there is nothing to say and no reason to give.
 */
export const cancelRunSchema = z.object({});
export type CancelRunInput = z.infer<typeof cancelRunSchema>;

/**
 * Body of POST /api/runs/[id]/follow-up. The same limits as a first
 * instruction: a follow-up is an instruction, just one with a history behind it.
 */
export const followUpSchema = z.object({
  prompt: z
    .string()
    .trim()
    .min(1, "Say what the agent should do next.")
    .max(4000, "Keep instructions under 4000 characters."),
});
export type FollowUpInput = z.infer<typeof followUpSchema>;

/**
 * One page of history. `hasMore` comes from reading one row past the page and
 * dropping it, which answers "is there another page" without a second count.
 */
export const runPageSchema = z.object({
  runs: z.array(runSchema),
  hasMore: z.boolean(),
});
export type RunPage = z.infer<typeof runPageSchema>;

/** Response of GET /api/runs/[id]/steps: the run plus its derived live view. */
export const runProgressSchema = z.object({
  run: runSchema,
  steps: z.array(runStepSchema),
  phase: runPhaseSchema,
  filesWritten: z.array(z.string()),
  /** Servers the run actually called, by key. Older responses omit it. */
  mcpServersUsed: z.array(z.string()).default([]),
});
export type RunProgress = z.infer<typeof runProgressSchema>;
