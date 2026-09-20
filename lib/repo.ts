import { randomUUID } from "node:crypto";
import { sql, type Selectable } from "kysely";
import {
  getDb,
  type McpServersTable,
  type RunArtifactsTable,
  type RunEvaluationsTable,
  type RunsTable,
} from "@/lib/db";
import {
  agentModelIdSchema,
  clarificationAnswerSchema,
  clarificationStateSchema,
  continuationSchema,
  DEFAULT_AGENT_MODEL_ID,
  pendingInputSchema,
  evaluationStatusSchema,
  isAutoSelection,
  isTerminalRunStatus,
  requirementCheckSchema,
  RUNS_PAGE_SIZE,
  storedModelSelectionSchema,
  verdictSchema,
  type AgentModelId,
  type ModelSelection,
  type RunCursor,
  type RunPage,
  type Artifact,
  type ClarificationAnswer,
  type ClarificationState,
  type Continuation,
  type PendingInput,
  type CreateMcpServerInput,
  type Evaluation,
  type EvaluationStatus,
  type GateCheck,
  type HumanVerdictInput,
  type McpAuthStatus,
  type McpServer,
  type RequirementCheck,
  type Run,
  type RunClarification,
  type RunStatus,
  type UpdateMcpServerInput,
  type Verdict,
} from "@/lib/schema";

type RunRow = Selectable<RunsTable>;
type ArtifactRow = Selectable<RunArtifactsTable>;
type McpServerRow = Selectable<McpServersTable>;
type EvaluationRow = Selectable<RunEvaluationsTable>;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
}

function jsonb(value: unknown) {
  return sql<string>`${JSON.stringify(value)}::jsonb`;
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    name: row.name,
    sizeBytes: Number(row.size_bytes),
    mimeType: row.mime_type,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

function toVerdict(value: string | null): Verdict | null {
  const parsed = verdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function gateChecks(value: unknown): GateCheck[] {
  return Array.isArray(value) ? (value as GateCheck[]) : [];
}

function requirementChecks(value: unknown): RequirementCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = requirementCheckSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function toEvaluation(row: EvaluationRow): Evaluation {
  const now = new Date().toISOString();
  return {
    runId: row.run_id,
    status: evaluationStatusSchema.safeParse(row.status).data ?? "done",
    gatePassed: row.gate_passed,
    gateChecks: gateChecks(row.gate_checks),
    artifactName: row.artifact_name,
    judgeVerdict: toVerdict(row.judge_verdict),
    judgeConfidence: row.judge_score === null ? null : Number(row.judge_score),
    judgeRationale: row.judge_rationale,
    judgeRequirements: requirementChecks(row.judge_requirements),
    judgeError: row.judge_error,
    judgeModel: row.judge_model,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    humanVerdict: toVerdict(row.human_verdict),
    humanNote: row.human_note,
    createdAt: toIso(row.created_at) ?? now,
    updatedAt: toIso(row.updated_at) ?? now,
  };
}

/**
 * Requests recorded before the open-text shape existed have no `kind`; they were
 * all multiple choice, so they are read back as such instead of being dropped.
 */
function withKind(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  if ("kind" in entry) return entry;
  return { ...entry, kind: "choice" };
}

function pendingInputs(value: unknown): PendingInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = pendingInputSchema.safeParse(withKind(entry));
    return parsed.success ? [parsed.data] : [];
  });
}

function clarificationAnswers(value: unknown): ClarificationAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = clarificationAnswerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function toClarification(row: RunRow): RunClarification {
  return {
    state: clarificationStateSchema.safeParse(row.clarification_state).data ?? "pending",
    questions: pendingInputs(row.clarification_questions),
    answers: clarificationAnswers(row.clarification_answers),
  };
}

function toRun(row: RunRow, artifacts: Artifact[], evaluation: Evaluation | null = null): Run {
  return {
    id: row.id,
    prompt: row.prompt,
    artifacts,
    mcpServers: stringArray(row.mcp_servers),
    clarification: toClarification(row),
    evaluation,
    status: row.status,
    resultText: row.result_text,
    error: row.error,
    requestedModel: storedModelSelectionSchema.safeParse(row.requested_model).data ?? null,
    resolvedModel: agentModelIdSchema.safeParse(row.resolved_model).data ?? null,
    reasoning: row.reasoning,
    model: row.model,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    numTurns: row.num_turns,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    cancelRequestedAt: toIso(row.cancel_requested_at),
    parentRunId: row.parent_run_id,
    continuation: continuationSchema.safeParse(row.continuation).data ?? "none",
    // What the database knows: this run held a session. Whether that session's
    // transcript is still on disk is a question for the moment a follow-up is
    // actually submitted, and the route asks it there rather than every read.
    resumable: row.session_id !== null,
  };
}

export async function createRun(
  prompt: string,
  mcpServerNames: string[],
  requestedModel: ModelSelection,
  reasoning = false,
): Promise<Run> {
  const db = await getDb();
  const row = await db
    .insertInto("runs")
    .values({
      id: randomUUID(),
      prompt,
      status: "queued",
      mcp_servers: jsonb(mcpServerNames),
      requested_model: requestedModel,
      // Named selections resolve to themselves; Auto is settled by the router
      // at start, so the row shows what it actually ran on either way.
      resolved_model: isAutoSelection(requestedModel) ? null : requestedModel,
      reasoning,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRun(row, []);
}

/**
 * Starts a run that continues an earlier one. It is its own row on purpose:
 * cost, steps, duration and the outcome verdict all belong to the instruction
 * that caused them, and folding a follow-up into the original record would
 * overwrite the first answer and leave the judge grading the second piece of
 * work against the first request.
 *
 * The settings are inherited rather than re-asked: a follow-up to a run is
 * plainly meant to happen under the same conditions.
 */
export async function createFollowUpRun(parent: Run, prompt: string): Promise<Run> {
  const db = await getDb();
  const row = await db
    .insertInto("runs")
    .values({
      id: randomUUID(),
      prompt,
      status: "queued",
      mcp_servers: jsonb(parent.mcpServers),
      requested_model: parent.requestedModel ?? DEFAULT_AGENT_MODEL_ID,
      resolved_model: isAutoSelection(parent.requestedModel) ? null : parent.resolvedModel,
      reasoning: parent.reasoning,
      parent_run_id: parent.id,
      // Settled by the runner once it knows whether the session reopened.
      continuation: "seeded",
      // A follow-up is an answer to a question the user has already thought
      // about, so the pre-run clarifier is skipped rather than asking again.
      clarification_state: "not_needed",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRun(row, []);
}

/** The run whose session a follow-up should reopen, with its own id. */
export async function getRunSession(id: string): Promise<string | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("runs")
    .select("session_id")
    .where("id", "=", id)
    .executeTakeFirst();
  return row?.session_id ?? null;
}

/**
 * Records the agent session a run is holding, so a later follow-up can reopen
 * the same conversation. Written as soon as the session announces itself,
 * rather than at the end, so a run that is stopped or fails can still be
 * continued — which is exactly when a user most wants to.
 */
export async function saveRunSession(id: string, sessionId: string): Promise<void> {
  const db = await getDb();
  await db.updateTable("runs").set({ session_id: sessionId }).where("id", "=", id).execute();
}

/** Records what the follow-up actually got: the live session, or a written account of it. */
export async function saveRunContinuation(
  id: string,
  continuation: Extract<Continuation, "resumed" | "seeded">,
): Promise<void> {
  const db = await getDb();
  await db.updateTable("runs").set({ continuation }).where("id", "=", id).execute();
}

/**
 * The one-run-at-a-time rule, asked of the database rather than of the page
 * that happens to be open: two tabs, or a follow-up submitted from a stale
 * view, must not get past a check the composer only makes on the client.
 *
 * Deliberately the newest run rather than any unfinished one, which is the
 * rule the composer already states. Anything older that never landed — a run
 * stranded by a restart, say — is a thing to stop from the runs table, not a
 * reason to lock the product for good.
 */
export async function findActiveRun(): Promise<Run | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!row || isTerminalRunStatus(row.status)) return null;
  return toRun(row, []);
}

/** The follow-ups of a run, oldest first, so a chain reads in the order it happened. */
export async function listRunContinuations(id: string): Promise<Run[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("runs")
    .selectAll()
    .where("parent_run_id", "=", id)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((row) => toRun(row, []));
}

/**
 * Records what Auto settled on, before the agent stream opens. Kept separate
 * from `finishRun` so the choice is visible while the run is still going.
 */
export async function saveResolvedModel(
  id: string,
  resolvedModel: AgentModelId,
  reasoning: boolean,
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("runs")
    .set({ resolved_model: resolvedModel, reasoning })
    .where("id", "=", id)
    .execute();
}

// ---------- MCP servers ----------

function toAuthStatus(row: McpServerRow): McpAuthStatus {
  if (row.auth_mode !== "oauth") return "not_required";
  if (row.auth_error) return "error";
  return row.oauth_access_token ? "connected" : "needs_auth";
}

/** Browser-safe projection: secrets and tokens are dropped, only names and a status remain. */
function toMcpServer(row: McpServerRow): McpServer {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: stringArray(row.args),
    url: row.url,
    envKeys: Object.keys(stringMap(row.env)),
    headerKeys: Object.keys(stringMap(row.headers)),
    allowedTools: stringArray(row.allowed_tools),
    writeTools: stringArray(row.write_tools),
    allowWrites: row.allow_writes,
    authMode: row.auth_mode,
    authStatus: toAuthStatus(row),
    authError: row.auth_error,
    enabled: row.enabled,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  };
}

/** Server-side only: the OAuth session of one MCP server. Never leaves the server. */
export interface McpOAuthState {
  scope: string | null;
  clientId: string | null;
  clientSecret: string | null;
  serverUrl: string | null;
  resource: string | null;
  redirectUri: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  state: string | null;
  codeVerifier: string | null;
}

/** Server-side only: full config including secrets, for spawning the server. */
export interface McpServerConfigRow extends McpServer {
  env: Record<string, string>;
  headers: Record<string, string>;
  oauth: McpOAuthState;
}

function toMcpServerConfig(row: McpServerRow): McpServerConfigRow {
  return {
    ...toMcpServer(row),
    env: stringMap(row.env),
    headers: stringMap(row.headers),
    oauth: {
      scope: row.oauth_scope,
      clientId: row.oauth_client_id,
      clientSecret: row.oauth_client_secret,
      serverUrl: row.oauth_server_url,
      resource: row.oauth_resource,
      redirectUri: row.oauth_redirect_uri,
      accessToken: row.oauth_access_token,
      refreshToken: row.oauth_refresh_token,
      expiresAt: toIso(row.oauth_expires_at),
      state: row.oauth_state,
      codeVerifier: row.oauth_code_verifier,
    },
  };
}

export async function listMcpServers(): Promise<McpServer[]> {
  const db = await getDb();
  const rows = await db.selectFrom("mcp_servers").selectAll().orderBy("created_at", "asc").execute();
  return rows.map(toMcpServer);
}

export async function listEnabledMcpServerConfigs(): Promise<McpServerConfigRow[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("mcp_servers")
    .selectAll()
    .where("enabled", "=", true)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map(toMcpServerConfig);
}

export async function getMcpServerByKey(key: string): Promise<McpServer | null> {
  const db = await getDb();
  const row = await db.selectFrom("mcp_servers").selectAll().where("key", "=", key).executeTakeFirst();
  return row ? toMcpServer(row) : null;
}

/** Server-side only: one server with its secrets, for the OAuth routes and the runner. */
export async function getMcpServerConfig(id: string): Promise<McpServerConfigRow | null> {
  const db = await getDb();
  const row = await db.selectFrom("mcp_servers").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? toMcpServerConfig(row) : null;
}

export async function createMcpServer(input: CreateMcpServerInput): Promise<McpServer> {
  const db = await getDb();
  const row = await db
    .insertInto("mcp_servers")
    .values({
      id: randomUUID(),
      key: input.key,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: jsonb(input.args),
      url: input.url ?? null,
      env: jsonb(input.env),
      headers: jsonb(input.headers),
      allowed_tools: jsonb(input.allowedTools),
      write_tools: jsonb(input.writeTools),
      allow_writes: input.allowWrites,
      auth_mode: input.authMode,
      oauth_scope: input.scope ?? null,
      enabled: true,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toMcpServer(row);
}

export async function updateMcpServer(
  id: string,
  patch: UpdateMcpServerInput,
): Promise<McpServer | null> {
  const db = await getDb();
  const row = await db
    .updateTable("mcp_servers")
    .set({
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.allowWrites === undefined ? {} : { allow_writes: patch.allowWrites }),
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  return row ? toMcpServer(row) : null;
}

// ---------- MCP OAuth session ----------

export interface McpOAuthClientInput {
  clientId: string;
  clientSecret: string | null;
  serverUrl: string;
  resource: string | null;
  redirectUri: string;
  scope: string | null;
}

/** Stores the dynamically registered client plus the pending PKCE/CSRF material. */
export async function startMcpOAuthFlow(
  id: string,
  client: McpOAuthClientInput,
  pending: { state: string; codeVerifier: string },
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("mcp_servers")
    .set({
      oauth_client_id: client.clientId,
      oauth_client_secret: client.clientSecret,
      oauth_server_url: client.serverUrl,
      oauth_resource: client.resource,
      oauth_redirect_uri: client.redirectUri,
      oauth_scope: client.scope,
      oauth_state: pending.state,
      oauth_code_verifier: pending.codeVerifier,
      auth_error: null,
    })
    .where("id", "=", id)
    .execute();
}

export async function saveMcpOAuthTokens(
  id: string,
  tokens: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
  options: { enable?: boolean } = {},
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("mcp_servers")
    .set({
      oauth_access_token: tokens.accessToken,
      oauth_refresh_token: tokens.refreshToken,
      oauth_expires_at: tokens.expiresAt,
      oauth_state: null,
      oauth_code_verifier: null,
      auth_error: null,
      // Only a first connection turns the server on. A silent refresh, or a
      // re-authorisation after expiry, must leave a server the user switched
      // off exactly where they left it.
      ...(options.enable ? { enabled: true } : {}),
    })
    .where("id", "=", id)
    .execute();
}

/**
 * Removes the connection: tokens, the dynamically registered client and the
 * discovered tool list all go, so the server is back to never-connected. This
 * is the destructive counterpart to simply switching a server off, which keeps
 * everything and only stops offering its tools to runs.
 */
export async function removeMcpOAuthConnection(id: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("mcp_servers")
    .set({
      oauth_access_token: null,
      oauth_refresh_token: null,
      oauth_expires_at: null,
      oauth_state: null,
      oauth_code_verifier: null,
      oauth_client_id: null,
      oauth_client_secret: null,
      oauth_server_url: null,
      oauth_resource: null,
      oauth_redirect_uri: null,
      allowed_tools: jsonb([]),
      write_tools: jsonb([]),
      allow_writes: false,
      auth_error: null,
      enabled: false,
    })
    .where("id", "=", id)
    .execute();
}

export async function setMcpAuthError(id: string, message: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("mcp_servers")
    .set({ auth_error: message, oauth_state: null, oauth_code_verifier: null })
    .where("id", "=", id)
    .execute();
}

/**
 * Records the tool list a server advertised. These columns are a cache of what
 * the server said, not a policy written here, so they are replaced wholesale
 * every time we manage to ask.
 */
export async function saveMcpServerTools(
  id: string,
  tools: { readTools: string[]; writeTools: string[] },
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("mcp_servers")
    .set({
      allowed_tools: jsonb(tools.readTools),
      write_tools: jsonb(tools.writeTools),
    })
    .where("id", "=", id)
    .execute();
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.deleteFrom("mcp_servers").where("id", "=", id).executeTakeFirst();
  return Number(result.numDeletedRows) === 1;
}

async function artifactsByRun(runIds: string[]): Promise<Map<string, Artifact[]>> {
  const grouped = new Map<string, Artifact[]>();
  if (runIds.length === 0) return grouped;
  const db = await getDb();
  const rows = await db
    .selectFrom("run_artifacts")
    .selectAll()
    .where("run_id", "in", runIds)
    .orderBy("name", "asc")
    .execute();
  for (const row of rows) {
    const list = grouped.get(row.run_id) ?? [];
    list.push(toArtifact(row));
    grouped.set(row.run_id, list);
  }
  return grouped;
}

export async function getRun(id: string): Promise<Run | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  const [artifacts, evaluations] = await Promise.all([
    artifactsByRun([row.id]),
    evaluationsByRun([row.id]),
  ]);
  return toRun(row, artifacts.get(row.id) ?? [], evaluations.get(row.id) ?? null);
}

async function evaluationsByRun(runIds: string[]): Promise<Map<string, Evaluation>> {
  const grouped = new Map<string, Evaluation>();
  if (runIds.length === 0) return grouped;
  const db = await getDb();
  const rows = await db
    .selectFrom("run_evaluations")
    .selectAll()
    .where("run_id", "in", runIds)
    .execute();
  for (const row of rows) grouped.set(row.run_id, toEvaluation(row));
  return grouped;
}

async function hydrate(rows: RunRow[]): Promise<Run[]> {
  const ids = rows.map((r) => r.id);
  const [artifacts, evaluations] = await Promise.all([
    artifactsByRun(ids),
    evaluationsByRun(ids),
  ]);
  return rows.map((row) =>
    toRun(row, artifacts.get(row.id) ?? [], evaluations.get(row.id) ?? null),
  );
}

export async function listRuns(limit = RUNS_PAGE_SIZE): Promise<Run[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  return hydrate(rows);
}

/**
 * One page of history, newest first, paged by keyset rather than offset: runs
 * are started from the same screen that is being paged, and an offset would
 * push every unseen row down by one each time, skipping rows silently.
 *
 * `hasMore` comes from asking for one row beyond the page and dropping it,
 * which avoids a second `count(*)` over the whole table.
 */
export async function listRunsPage(
  limit = RUNS_PAGE_SIZE,
  cursor: RunCursor | null = null,
): Promise<RunPage> {
  const db = await getDb();
  let q = db
    .selectFrom("runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(limit + 1);

  if (cursor) {
    // Row-value comparison: strictly older, or same instant and a lower id.
    // Two runs can share a created_at, so the id breaks the tie.
    q = q.where(
      sql<boolean>`(created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id})`,
    );
  }

  const rows = await q.execute();
  const hasMore = rows.length > limit;
  return { runs: await hydrate(hasMore ? rows.slice(0, limit) : rows), hasMore };
}

// ---------- Evaluations ----------

export type BeginEvaluationResult =
  | { ok: true; evaluation: Evaluation }
  | { ok: false; reason: "not_found" | "run_active" | "run_cancelled" | "already_running" };

/**
 * Claims the right to evaluate a run. The guard is in SQL: only a run that has
 * reached a terminal status can be claimed, and only when no evaluation is
 * already in flight, so a double submit cannot start a second judge call.
 */
export async function beginEvaluation(runId: string): Promise<BeginEvaluationResult> {
  const db = await getDb();
  const claimed = await sql<EvaluationRow>`
    insert into run_evaluations (run_id, status, gate_passed, gate_checks, updated_at)
    select r.id, 'running', false, '[]'::jsonb, now()
      from runs r
     where r.id = ${runId}
       and r.status in ('succeeded', 'failed')
    on conflict (run_id) do update
       set status = 'running',
           updated_at = now()
     where run_evaluations.status <> 'running'
    returning *
  `.execute(db);

  const row = claimed.rows[0];
  if (row) return { ok: true, evaluation: toEvaluation(row) };

  // Nothing was written; read back why so the route can pick 404 or 409.
  const run = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) return { ok: false, reason: "not_found" };
  if (run.status === "queued" || run.status === "running" || run.status === "awaiting_input") {
    return { ok: false, reason: "run_active" };
  }
  // Stopped runs are graded by `recordCancelledEvaluation`, not by the judge.
  if (run.status === "cancelled") return { ok: false, reason: "run_cancelled" };
  return { ok: false, reason: "already_running" };
}

export interface SaveEvaluationInput {
  status: EvaluationStatus;
  gatePassed: boolean;
  gateChecks: GateCheck[];
  artifactName: string | null;
  judgeVerdict: Verdict | null;
  judgeConfidence: number | null;
  judgeRationale: string | null;
  judgeRequirements: RequirementCheck[];
  judgeError: string | null;
  judgeModel: string | null;
  costUsd: number | null;
}

/** Upsert the machine part of an evaluation, keeping any human verdict intact. */
export async function saveEvaluation(
  runId: string,
  input: SaveEvaluationInput,
): Promise<Evaluation> {
  const db = await getDb();
  const columns = {
    status: input.status,
    gate_passed: input.gatePassed,
    gate_checks: jsonb(input.gateChecks),
    artifact_name: input.artifactName,
    judge_verdict: input.judgeVerdict,
    judge_score: input.judgeConfidence,
    judge_rationale: input.judgeRationale,
    judge_requirements: jsonb(input.judgeRequirements),
    judge_error: input.judgeError,
    judge_model: input.judgeModel,
    cost_usd: input.costUsd,
    updated_at: new Date().toISOString(),
  };
  const row = await db
    .insertInto("run_evaluations")
    .values({ run_id: runId, ...columns })
    .onConflict((oc) => oc.column("run_id").doUpdateSet(columns))
    .returningAll()
    .executeTakeFirstOrThrow();
  return toEvaluation(row);
}

export async function setHumanVerdict(
  runId: string,
  verdict: HumanVerdictInput["verdict"],
  note: string,
): Promise<Evaluation | null> {
  const db = await getDb();
  const row = await db
    .updateTable("run_evaluations")
    .set({
      human_verdict: verdict,
      human_note: note || null,
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", runId)
    .returningAll()
    .executeTakeFirst();
  return row ? toEvaluation(row) : null;
}

/** Withdraws a human verdict, leaving the automatic one in charge again. */
export async function clearHumanVerdict(runId: string): Promise<Evaluation | null> {
  const db = await getDb();
  const row = await db
    .updateTable("run_evaluations")
    .set({
      human_verdict: null,
      human_note: null,
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", runId)
    .returningAll()
    .executeTakeFirst();
  return row ? toEvaluation(row) : null;
}

export async function getEvaluation(runId: string): Promise<Evaluation | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("run_evaluations")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst();
  return row ? toEvaluation(row) : null;
}

export interface ArtifactFileInput {
  name: string;
  sizeBytes: number;
  mimeType: string;
}

/** Replace the recorded artifacts of a run with the given files. */
export async function replaceRunArtifacts(
  runId: string,
  files: ArtifactFileInput[],
): Promise<void> {
  const db = await getDb();
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("run_artifacts").where("run_id", "=", runId).execute();
    if (files.length === 0) return;
    await trx
      .insertInto("run_artifacts")
      .values(
        files.map((f) => ({
          id: randomUUID(),
          run_id: runId,
          name: f.name,
          size_bytes: f.sizeBytes,
          mime_type: f.mimeType,
        })),
      )
      .execute();
  });
}

export async function getArtifact(runId: string, name: string): Promise<Artifact | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("run_artifacts")
    .selectAll()
    .where("run_id", "=", runId)
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? toArtifact(row) : null;
}

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  active: number;
  /** Runs paused on a clarifying question, waiting for the user. */
  awaitingInput: number;
  /** Runs that reached a verdict on "did it do what was asked". */
  evaluated: number;
  /** Of those, how many did what was asked. */
  passed: number;
}

export async function getRunSummary(): Promise<RunSummary> {
  const db = await getDb();
  const [rows, verdicts] = await Promise.all([
    db
      .selectFrom("runs")
      .select(["status", db.fn.countAll<string>().as("count")])
      .groupBy("status")
      .execute(),
    // Mirrors effectiveVerdict() in lib/schema.ts: human beats judge beats gate.
    sql<{ evaluated: string; passed: string }>`
      select
        count(*) as evaluated,
        count(*) filter (
          where coalesce(
            human_verdict,
            case when gate_passed then judge_verdict else 'fail' end
          ) = 'pass'
        ) as passed
      from run_evaluations
      where status = 'done'
    `.execute(db),
  ]);

  const byStatus = new Map<RunStatus, number>(
    rows.map((r) => [r.status, Number(r.count)] as const),
  );
  const count = (s: RunStatus) => byStatus.get(s) ?? 0;
  const tally = verdicts.rows[0];
  return {
    total: rows.reduce((acc, r) => acc + Number(r.count), 0),
    succeeded: count("succeeded"),
    failed: count("failed"),
    active: count("queued") + count("running"),
    awaitingInput: count("awaiting_input"),
    evaluated: Number(tally?.evaluated ?? 0),
    passed: Number(tally?.passed ?? 0),
  };
}

// ---------- Clarification round ----------

/**
 * Pauses a queued run on a set of questions. The guard is in SQL and covers
 * both columns: only a still-queued run whose questions have never been asked
 * can be paused, so a retry of the planner cannot re-ask or re-pause a run that
 * has already moved on.
 */
export async function pauseRunForClarification(
  id: string,
  questions: PendingInput[],
): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable("runs")
    .set({
      status: "awaiting_input",
      clarification_state: "awaiting",
      clarification_questions: jsonb(questions),
    })
    .where("id", "=", id)
    .where("status", "=", "queued")
    .where("clarification_state", "=", "pending")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/**
 * Closes the question round without asking anything: either the prompt was
 * clear, or the planner could not be reached. Both leave the run queued.
 */
export async function markClarificationChecked(
  id: string,
  state: Extract<ClarificationState, "not_needed" | "unavailable">,
): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("runs")
    .set({ clarification_state: state })
    .where("id", "=", id)
    .where("clarification_state", "=", "pending")
    .execute();
}

/**
 * Stops a running agent partway through, on something only the user can supply.
 * Guarded on `running` so a run that has already finished, failed or been pulled
 * elsewhere cannot be dragged back into waiting.
 */
export async function pauseRunForMidRunInput(
  id: string,
  requests: PendingInput[],
): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable("runs")
    .set({
      status: "awaiting_input",
      clarification_state: "awaiting_mid_run",
      clarification_questions: jsonb(requests),
      clarification_answers: jsonb([]),
    })
    .where("id", "=", id)
    .where("status", "=", "running")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/**
 * Puts a mid-run pause back into `running`, whether because the answer arrived
 * or because the wait ran out. Always called by the runner that paused it, so
 * the run can never be left sitting in `awaiting_input` with nobody waiting.
 */
export async function resumeRunAfterMidRunInput(id: string): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("runs")
    .set({ status: "running" })
    .where("id", "=", id)
    .where("status", "=", "awaiting_input")
    .execute();
}

/** Cheap read for the runner's wait loop: just the question round, no joins. */
export async function getRunClarification(id: string): Promise<RunClarification | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("runs")
    .select([
      "status",
      "clarification_state",
      "clarification_questions",
      "clarification_answers",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return {
    state: clarificationStateSchema.safeParse(row.clarification_state).data ?? "pending",
    questions: pendingInputs(row.clarification_questions),
    answers: clarificationAnswers(row.clarification_answers),
  };
}

export type ResumeClarificationResult =
  | { ok: true; stage: "pre_run" | "mid_run" }
  | { ok: false; reason: "not_found" | "not_awaiting" | "questions_changed" };

/**
 * Records the answers and releases the run. Three guards matter: `awaiting_input`,
 * a state that is still waiting, and the exact questions the answers were written
 * against. The first two turn a double submit — or a tab left open on the card —
 * into a 409 instead of a second start or a clobbered answer.
 *
 * The third exists because a run can ask more than once. Between the card
 * rendering question two and the user submitting it, the agent may have been
 * answered, carried on, and stopped on question three; without the id check
 * those answers would be filed against a question nobody read.
 *
 * A pre-run pause is re-queued here and picked up by a fresh runner. A mid-run
 * pause is left in `awaiting_input`: its runner is still holding the session and
 * flips the row back to `running` itself, keeping the work already done.
 */
export async function resumeRunWithClarification(
  id: string,
  answers: ClarificationAnswer[],
  state: Extract<ClarificationState, "answered" | "skipped">,
  answeringQuestionIds: string[],
): Promise<ResumeClarificationResult> {
  const db = await getDb();
  const updated = await sql<{ status: RunStatus }>`
    update runs
       set clarification_state = ${state},
           clarification_answers = ${JSON.stringify(answers)}::jsonb,
           status = case when clarification_state = 'awaiting' then 'queued' else status end
     where id = ${id}
       and status = 'awaiting_input'
       and clarification_state in ('awaiting', 'awaiting_mid_run')
       and ${JSON.stringify(answeringQuestionIds)}::jsonb = (
         select coalesce(jsonb_agg(entry->>'id' order by ord), '[]'::jsonb)
           from jsonb_array_elements(clarification_questions) with ordinality as q(entry, ord)
       )
    returning status
  `.execute(db);

  const row = updated.rows[0];
  if (row) return { ok: true, stage: row.status === "queued" ? "pre_run" : "mid_run" };

  const current = await db
    .selectFrom("runs")
    .select(["status", "clarification_state"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!current) return { ok: false, reason: "not_found" };
  const stillWaiting =
    current.status === "awaiting_input" &&
    (current.clarification_state === "awaiting" ||
      current.clarification_state === "awaiting_mid_run");
  return { ok: false, reason: stillWaiting ? "questions_changed" : "not_awaiting" };
}

/** Transition queued -> running. Returns false if the run was already claimed. */
export async function markRunning(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable("runs")
    .set({ status: "running", started_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("status", "=", "queued")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export interface FinishRunInput {
  status: Extract<RunStatus, "succeeded" | "failed">;
  resultText: string | null;
  error: string | null;
  model: string | null;
  costUsd: number | null;
  numTurns: number | null;
}

export async function finishRun(id: string, input: FinishRunInput): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("runs")
    .set({
      status: input.status,
      result_text: input.resultText,
      error: input.error,
      model: input.model,
      cost_usd: input.costUsd,
      num_turns: input.numTurns,
      finished_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .where("status", "=", "running")
    .execute();
}

// ---------- Stopping a run ----------

export type RequestCancellationResult =
  | { ok: true; run: Run }
  | { ok: false; reason: "not_found" | "already_finished" };

/**
 * Records that the user wants this run stopped. The guard is in SQL and names
 * the non-terminal statuses, so a stop that races a run finishing on its own
 * loses cleanly instead of dragging a finished run back out of its outcome.
 *
 * Asking twice is not an error: the timestamp is kept as first written, so the
 * second click sees the same pending stop rather than a 409 it cannot act on.
 */
export async function requestRunCancellation(id: string): Promise<RequestCancellationResult> {
  const db = await getDb();
  const updated = await db
    .updateTable("runs")
    .set({ cancel_requested_at: sql<string>`coalesce(cancel_requested_at, now())` })
    .where("id", "=", id)
    .where("status", "in", ["queued", "running", "awaiting_input"])
    .returningAll()
    .executeTakeFirst();

  if (updated) {
    const [artifacts, evaluations] = await Promise.all([
      artifactsByRun([id]),
      evaluationsByRun([id]),
    ]);
    return {
      ok: true,
      run: toRun(updated, artifacts.get(id) ?? [], evaluations.get(id) ?? null),
    };
  }

  const exists = await db
    .selectFrom("runs")
    .select("id")
    .where("id", "=", id)
    .executeTakeFirst();
  return { ok: false, reason: exists ? "already_finished" : "not_found" };
}

/**
 * The terminal half of a stop: only a run that is still going *and* has a stop
 * on file can land on `cancelled`, so nothing else can reach this state and a
 * run that finished in the meantime keeps the outcome it earned.
 */
export async function markRunCancelled(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .updateTable("runs")
    .set({ status: "cancelled", finished_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("status", "in", ["queued", "running", "awaiting_input"])
    .where("cancel_requested_at", "is not", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export interface RunCancellation {
  status: RunStatus;
  cancelRequestedAt: string | null;
}

/** Cheap read for the agent loop's step boundaries: no joins, two columns. */
export async function getRunCancellation(id: string): Promise<RunCancellation | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("runs")
    .select(["status", "cancel_requested_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  return { status: row.status, cancelRequestedAt: toIso(row.cancel_requested_at) };
}

export interface RunEvent {
  seq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export async function listRunEvents(runId: string): Promise<RunEvent[]> {
  const db = await getDb();
  const rows = await db
    .selectFrom("run_events")
    .select(["seq", "type", "payload", "created_at"])
    .where("run_id", "=", runId)
    .orderBy("seq", "asc")
    .execute();
  return rows.map((row) => ({
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload,
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  }));
}

/**
 * Appends one event and returns the sequence number it was given.
 *
 * The number is allocated inside the insert rather than counted by the caller,
 * because a run has more than one writer: the agent loop streaming SDK
 * messages, the route that records an answer the user typed, and the stop that
 * finalises a cancellation can all write while the run is open. A counter held
 * in the loop would hand the same number to two of them, and the unique
 * (run_id, seq) index would turn that into a failed run.
 */
export async function appendRunEvent(
  runId: string,
  type: string,
  payload: unknown,
): Promise<number> {
  const db = await getDb();
  const inserted = await sql<{ seq: number }>`
    insert into run_events (id, run_id, seq, type, payload)
    select
      ${randomUUID()},
      ${runId},
      coalesce(max(seq), 0) + 1,
      ${type},
      ${JSON.stringify(payload)}::jsonb
    from run_events
    where run_id = ${runId}
    returning seq
  `.execute(db);
  return Number(inserted.rows[0]?.seq ?? 0);
}
