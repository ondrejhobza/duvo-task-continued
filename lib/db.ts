import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  CompiledQuery,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
  type ColumnType,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from "kysely";
import {
  NOTION_REMOTE_FALLBACK_KEY,
  NOTION_REMOTE_KEY,
  NOTION_REMOTE_NAME,
  NOTION_REMOTE_URL,
  type ClarificationState,
  type Continuation,
  type EvaluationStatus,
  type McpAuthMode,
  type McpTransport,
  type RunStatus,
} from "@/lib/schema";

// ---------- Table types ----------

export interface RunsTable {
  id: string;
  prompt: string;
  status: RunStatus;
  result_text: string | null;
  error: string | null;
  requested_model: string | null;
  /** The concrete model the run started on; for an Auto run, the router's pick. */
  resolved_model: string | null;
  /** Whether extended thinking was requested for this run. */
  reasoning: ColumnType<boolean, boolean | undefined, boolean>;
  model: string | null;
  cost_usd: ColumnType<string | null, number | null, number | null>;
  num_turns: number | null;
  mcp_servers: ColumnType<unknown, string | undefined, string>;
  /** Where the clarification round got to; see ClarificationState. */
  clarification_state: ColumnType<
    ClarificationState,
    ClarificationState | undefined,
    ClarificationState
  >;
  clarification_questions: ColumnType<unknown, string | undefined, string>;
  clarification_answers: ColumnType<unknown, string | undefined, string>;
  created_at: ColumnType<Date, string | undefined, never>;
  started_at: ColumnType<Date | null, string | null, string | null>;
  finished_at: ColumnType<Date | null, string | null, string | null>;
  /** When the user asked for the run to stop; null on runs nobody stopped. */
  cancel_requested_at: ColumnType<Date | null, string | null, string | null>;
  /**
   * When the run last moved, which on a run that can be continued days later
   * is not when it was created. Decides which run is the live one.
   */
  last_activity_at: ColumnType<Date | null, string | null, string | null>;
  /** The agent session this run held, so a follow-up can resume the conversation. */
  session_id: string | null;
  /** A separate, earlier run this one continues. Only on legacy follow-ups. */
  parent_run_id: string | null;
  /** How the latest turn got its context; see `Continuation`. */
  continuation: ColumnType<Continuation, Continuation | undefined, Continuation>;
}

export interface RunEventsTable {
  id: string;
  run_id: string;
  seq: number;
  type: string;
  payload: ColumnType<unknown, string, never>;
  created_at: ColumnType<Date, string | undefined, never>;
  /** Which turn of the conversation produced this event; 1 for a single-turn run. */
  turn: ColumnType<number, number | undefined, number>;
}

/**
 * One instruction and what came of it. A run owns an ordered list of these:
 * the first is the task it was started with, and each follow-up adds another.
 */
export interface RunTurnsTable {
  id: string;
  run_id: string;
  seq: number;
  prompt: string;
  status: RunStatus;
  result_text: string | null;
  error: string | null;
  model: string | null;
  cost_usd: ColumnType<string | null, number | null, number | null>;
  num_turns: number | null;
  continuation: ColumnType<Continuation, Continuation | undefined, Continuation>;
  created_at: ColumnType<Date, string | undefined, never>;
  started_at: ColumnType<Date | null, string | null, string | null>;
  finished_at: ColumnType<Date | null, string | null, string | null>;
}

export interface RunArtifactsTable {
  id: string;
  run_id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface McpServersTable {
  id: string;
  key: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: ColumnType<unknown, string, string>;
  url: string | null;
  env: ColumnType<unknown, string, string>;
  headers: ColumnType<unknown, string, string>;
  allowed_tools: ColumnType<unknown, string, string>;
  write_tools: ColumnType<unknown, string, string>;
  allow_writes: boolean;
  enabled: boolean;
  auth_mode: McpAuthMode;
  /** OAuth: everything below stays server-side; it is never projected to the client. */
  oauth_scope: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_server_url: string | null;
  oauth_resource: string | null;
  oauth_redirect_uri: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: ColumnType<Date | null, string | null, string | null>;
  /** Pending authorization: CSRF state and PKCE verifier, cleared on completion. */
  oauth_state: string | null;
  oauth_code_verifier: string | null;
  auth_error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
}

export interface RunEvaluationsTable {
  run_id: string;
  status: EvaluationStatus;
  gate_passed: boolean;
  gate_checks: ColumnType<unknown, string, string>;
  artifact_name: string | null;
  judge_verdict: string | null;
  /** The judge's 0-100 confidence. Named `score` by the original migration. */
  judge_score: number | null;
  judge_rationale: string | null;
  judge_requirements: ColumnType<unknown, string, string>;
  judge_error: string | null;
  judge_model: string | null;
  cost_usd: ColumnType<string | null, number | null, number | null>;
  human_verdict: string | null;
  human_note: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

export interface Database {
  run_evaluations: RunEvaluationsTable;
  runs: RunsTable;
  run_turns: RunTurnsTable;
  run_events: RunEventsTable;
  run_artifacts: RunArtifactsTable;
  mcp_servers: McpServersTable;
}

// ---------- PGlite dialect for Kysely ----------
// Hand-written because the community adapter is unmaintained and the driver
// surface is tiny. PGlite is single-connection, so connections are serialised.

class PGliteConnection implements DatabaseConnection {
  constructor(private readonly client: PGlite) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.client.query<R>(compiled.sql, [
      ...compiled.parameters,
    ]);
    return {
      rows: result.rows,
      numAffectedRows: BigInt(result.affectedRows ?? 0),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("PGlite driver does not support streaming");
  }
}

class PGliteDriver implements Driver {
  private connection: PGliteConnection | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly client: PGlite) {}

  async init(): Promise<void> {
    await this.client.waitReady;
    this.connection = new PGliteConnection(this.client);
  }

  acquireConnection(): Promise<DatabaseConnection> {
    let release: () => void = () => {};
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(() => {
      const conn = this.connection;
      if (!conn) throw new Error("PGlite driver not initialised");
      releases.set(conn, release);
      return conn;
    });
  }

  async beginTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await conn.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(conn: DatabaseConnection): Promise<void> {
    releases.get(conn)?.();
    releases.delete(conn);
  }

  async destroy(): Promise<void> {
    await this.client.close();
  }
}

const releases = new WeakMap<DatabaseConnection, () => void>();

function createPGliteDialect(client: PGlite): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new PGliteDriver(client),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}

// ---------- Singleton + schema ----------

const DATA_DIR = process.env.PGLITE_DATA_DIR ?? ".pglite";

// The PGlite client is cached on globalThis so hot reloads in `next dev` do not
// open the data directory twice. The Kysely instance and ensureSchema() live at
// module scope so a code change (new table) re-runs the idempotent DDL.
type DbGlobal = typeof globalThis & {
  __duvoPglite?: PGlite;
};

function getClient(): PGlite {
  const g = globalThis as DbGlobal;
  if (!g.__duvoPglite) g.__duvoPglite = new PGlite(DATA_DIR);
  return g.__duvoPglite;
}

let dbPromise: Promise<Kysely<Database>> | null = null;

async function createDb(): Promise<Kysely<Database>> {
  const db = new Kysely<Database>({ dialect: createPGliteDialect(getClient()) });
  await ensureSchema(db);
  return db;
}

export function getDb(): Promise<Kysely<Database>> {
  if (!dbPromise) dbPromise = createDb();
  return dbPromise;
}

export async function ensureSchema(db: Kysely<Database>): Promise<void> {
  await sql`
    create table if not exists runs (
      id text primary key,
      prompt text not null,
      status text not null,
      result_text text,
      error text,
      model text,
      cost_usd numeric,
      num_turns integer,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    )
  `.execute(db);

  await sql`
    create table if not exists run_events (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      seq integer not null,
      type text not null,
      payload jsonb not null,
      created_at timestamptz not null default now(),
      unique (run_id, seq)
    )
  `.execute(db);

  await sql`
    alter table runs add column if not exists mcp_servers jsonb not null default '[]'::jsonb
  `.execute(db);

  // Nullable on purpose: runs created before the model picker have no choice recorded.
  await sql`
    alter table runs add column if not exists requested_model text
  `.execute(db);

  // Additive with a default so runs that predate the toggle read back as
  // "reasoning was off", which is what they actually were. `resolved_model`
  // stays nullable: older runs genuinely never recorded one.
  await sql`
    alter table runs
      add column if not exists reasoning boolean not null default false,
      add column if not exists resolved_model text
  `.execute(db);

  // Additive and nullable: every run that predates the stop button was never
  // stopped, which is exactly what a null reads as.
  await sql`
    alter table runs add column if not exists cancel_requested_at timestamptz
  `.execute(db);

  // Follow-ups. All three are additive: a run from before this existed has no
  // session recorded, continues nothing, and reads back as 'none' — which is
  // the truth about it, and what stops the UI offering a resume it cannot do.
  await sql`
    alter table runs
      add column if not exists session_id text,
      add column if not exists parent_run_id text references runs(id) on delete set null,
      add column if not exists continuation text not null default 'none'
  `.execute(db);

  await sql`
    create index if not exists runs_parent_run_id_idx on runs (parent_run_id)
  `.execute(db);

  // When the run last did something, as opposed to when it was started. The
  // two used to be interchangeable; a run that can be picked up again days
  // later needs both, so "which run is live" cannot be answered by age alone.
  await sql`
    alter table runs add column if not exists last_activity_at timestamptz
  `.execute(db);
  await sql`
    update runs
       set last_activity_at = coalesce(finished_at, started_at, created_at)
     where last_activity_at is null
  `.execute(db);

  // A run is a conversation: one row here per instruction in it.
  await sql`
    create table if not exists run_turns (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      seq integer not null,
      prompt text not null,
      status text not null,
      result_text text,
      error text,
      model text,
      cost_usd numeric,
      num_turns integer,
      continuation text not null default 'none',
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz,
      unique (run_id, seq)
    )
  `.execute(db);

  // Events belong to the turn that produced them, so the history view can show
  // each turn's steps under the instruction that caused them. Existing events
  // all belong to the only turn their run has ever had.
  await sql`
    alter table run_events add column if not exists turn integer not null default 1
  `.execute(db);

  // Every run that predates this table is a conversation of exactly one turn,
  // and its own row already holds that turn's instruction and outcome. Copying
  // it across is what lets every view read turns without special-casing age.
  // The turn takes the run's id: unique by construction, since the ids minted
  // for later turns are fresh.
  await sql`
    insert into run_turns (
      id, run_id, seq, prompt, status, result_text, error, model,
      cost_usd, num_turns, created_at, started_at, finished_at, continuation
    )
    select
      r.id, r.id, 1, r.prompt, r.status, r.result_text, r.error, r.model,
      r.cost_usd, r.num_turns, r.created_at, r.started_at, r.finished_at,
      -- Meaningful only on the few runs recorded as follow-ups of another run;
      -- 'none' on every run that started from the composer.
      r.continuation
    from runs r
    where not exists (select 1 from run_turns t where t.run_id = r.id)
  `.execute(db);

  // Paging is keyset on (created_at, id); this is the index that ordering wants.
  await sql`
    create index if not exists runs_created_at_id_idx on runs (created_at desc, id desc)
  `.execute(db);

  // Additive with defaults so runs that predate the clarification round survive:
  // they read back as "pending" with no questions, which is exactly what they were.
  await sql`
    alter table runs
      add column if not exists clarification_state text not null default 'pending',
      add column if not exists clarification_questions jsonb not null default '[]'::jsonb,
      add column if not exists clarification_answers jsonb not null default '[]'::jsonb
  `.execute(db);

  await sql`
    create table if not exists run_evaluations (
      run_id text primary key references runs(id) on delete cascade,
      gate_passed boolean not null,
      gate_checks jsonb not null default '[]'::jsonb,
      judge_verdict text,
      judge_score integer,
      judge_rubric jsonb not null default '[]'::jsonb,
      judge_reasons jsonb not null default '[]'::jsonb,
      judge_error text,
      human_verdict text,
      human_note text,
      created_at timestamptz not null default now()
    )
  `.execute(db);

  // Additive: evaluations recorded before the verdict gained a lifecycle, a
  // requirement breakdown and cost accounting default to a finished state.
  await sql`
    alter table run_evaluations
      add column if not exists status text not null default 'done',
      add column if not exists artifact_name text,
      add column if not exists judge_rationale text,
      add column if not exists judge_requirements jsonb not null default '[]'::jsonb,
      add column if not exists judge_model text,
      add column if not exists cost_usd numeric,
      add column if not exists updated_at timestamptz not null default now()
  `.execute(db);

  await sql`
    create table if not exists mcp_servers (
      id text primary key,
      key text not null unique,
      name text not null,
      transport text not null,
      command text,
      args jsonb not null default '[]'::jsonb,
      url text,
      env jsonb not null default '{}'::jsonb,
      headers jsonb not null default '{}'::jsonb,
      allowed_tools jsonb not null default '[]'::jsonb,
      enabled boolean not null default true,
      created_at timestamptz not null default now()
    )
  `.execute(db);

  // Additive so servers connected before write opt-in and OAuth keep working:
  // they stay read-only (allow_writes false) and unauthenticated (auth_mode none).
  await sql`
    alter table mcp_servers
      add column if not exists write_tools jsonb not null default '[]'::jsonb,
      add column if not exists allow_writes boolean not null default false,
      add column if not exists auth_mode text not null default 'none',
      add column if not exists oauth_scope text,
      add column if not exists oauth_client_id text,
      add column if not exists oauth_client_secret text,
      add column if not exists oauth_server_url text,
      add column if not exists oauth_resource text,
      add column if not exists oauth_redirect_uri text,
      add column if not exists oauth_access_token text,
      add column if not exists oauth_refresh_token text,
      add column if not exists oauth_expires_at timestamptz,
      add column if not exists oauth_state text,
      add column if not exists oauth_code_verifier text,
      add column if not exists auth_error text
  `.execute(db);

  await sql`
    create table if not exists run_artifacts (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      name text not null,
      size_bytes integer not null,
      mime_type text not null,
      created_at timestamptz not null default now(),
      unique (run_id, name)
    )
  `.execute(db);

  await seedNotion(db);
}

/**
 * Offers Notion's hosted MCP server out of the box. It arrives disabled and
 * unauthorized: the user signs in with OAuth and switches it on per run. An
 * existing local Notion connection is left alone; the hosted one then takes a
 * second key rather than overwriting it — the key disambiguates, the display
 * name does not, so both are simply "Notion". Its tool lists start empty on
 * purpose: the server reports its own tools once there is a token to ask with.
 */
async function seedNotion(db: Kysely<Database>): Promise<void> {
  // Earlier versions suffixed the display name when the plain key was taken.
  // Idempotent, and it runs before the early return so rows seeded under the
  // old scheme are renamed rather than left behind.
  await sql`
    update mcp_servers
       set name = ${NOTION_REMOTE_NAME}
     where url = ${NOTION_REMOTE_URL}
       and name <> ${NOTION_REMOTE_NAME}
  `.execute(db);

  const seeded = await sql<{ key: string }>`
    select key from mcp_servers where url = ${NOTION_REMOTE_URL} limit 1
  `.execute(db);
  if (seeded.rows.length > 0) return;

  const taken = await sql<{ key: string }>`
    select key from mcp_servers where key = ${NOTION_REMOTE_KEY} limit 1
  `.execute(db);
  const key = taken.rows.length > 0 ? NOTION_REMOTE_FALLBACK_KEY : NOTION_REMOTE_KEY;

  await sql`
    insert into mcp_servers (id, key, name, transport, url, allowed_tools, write_tools, auth_mode, enabled)
    values (
      ${randomUUID()},
      ${key},
      ${NOTION_REMOTE_NAME},
      'http',
      ${NOTION_REMOTE_URL},
      '[]'::jsonb,
      '[]'::jsonb,
      'oauth',
      false
    )
    on conflict (key) do nothing
  `.execute(db);
}
