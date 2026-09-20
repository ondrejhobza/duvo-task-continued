import { mkdir } from "node:fs/promises";
import path from "node:path";
import { query, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { collectArtifacts } from "@/lib/artifacts";
import { ASK_USER_SERVER_KEY, buildAskUserSetup } from "@/lib/ask-user";
import { formatClarificationContext, planClarification } from "@/lib/clarify";
import { evaluateRun, recordCancelledEvaluation } from "@/lib/evaluate";
import { routeModel, type RoutingOutcome } from "@/lib/model-router";
import {
  appendRunEvent,
  currentTurnSeq,
  finishTurn,
  getRun,
  getRunCancellation,
  getRunSession,
  listEnabledMcpServerConfigs,
  listMcpServers,
  markClarificationChecked,
  markRunCancelled,
  markRunning,
  markTurnRunning,
  pauseRunForClarification,
  replaceRunArtifacts,
  saveResolvedModel,
  saveRunSession,
  type McpServerConfigRow,
} from "@/lib/repo";
import { sessionTranscriptExists } from "@/lib/session-files";
import {
  isAutoSelection,
  isTerminalRunStatus,
  modelSupportsReasoning,
  latestPrompt,
  resolveAgentModelId,
  type AgentModelId,
  type Continuation,
  type Run,
  type RunTurn,
} from "@/lib/schema";
import { bearerTokenFor, McpAuthError, refreshAdvertisedTools } from "@/lib/mcp-oauth";
import { namedInPrompt, selectMcpServers } from "@/lib/mcp-relevance";

const RUNS_ROOT = path.resolve(process.env.RUNS_DIR ?? ".runs");

/** Tools the agent may use. Bash is deliberately absent: web + its own folder only. */
const AGENT_TOOLS = [
  "WebSearch",
  "WebFetch",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
] as const;

const SYSTEM_PROMPT = [
  "You are an automation agent running unattended inside a small internal platform.",
  "Your working directory is a private, empty workspace created for this run.",
  "Only write a file when the task actually calls for one: the user asked you to export, save or produce a document, dataset, spreadsheet or report. Otherwise put the answer in your final reply and write nothing to disk.",
  "Never write a file just to show your work; a file the user did not ask for is noise.",
  "When you do write a file, save it directly into the working directory (not in subfolders); files there are offered to the user as downloads.",
  "When the user names an output format (CSV, JSON, Markdown, XLSX, ...), produce the file in exactly that format with the matching file extension and a descriptive file name.",
  "When the user asks to save, export or collect results without naming a format, pick the most sensible format for the data (CSV for tabular data, Markdown for prose).",
  "Make CSV files well-formed: a header row, one record per line, RFC 4180 quoting, UTF-8.",
  "When you finish, reply with a short plain-text summary that answers the user's request directly, and mention any files you created.",
  "Do not ask the user questions; make reasonable assumptions and state them in the summary.",
  "The user watches your progress live. Before every tool call, write one short plain sentence (max 15 words) saying what you are about to do and why.",
].join(" ");

export function runWorkspaceDir(runId: string): string {
  return path.join(RUNS_ROOT, runId);
}

// ---------- Stopping a run ----------

/** How often the loop asks whether the user has pressed stop. */
const CANCEL_POLL_MS = 1000;

/**
 * How long a pending stop is given before it is finalised without its loop.
 * Only reached when no loop is running it: long enough for an `after()` task
 * that has been scheduled but not yet started to register itself.
 */
const ORPHANED_CANCEL_MS = 15_000;

/**
 * The runs this process is executing right now. A stop is honoured by the loop
 * that owns the run, so a pending stop with no entry here has nobody left to
 * honour it — which is what `reconcileCancellation` is for.
 */
const inFlight = new Set<string>();

async function cancellationRequested(runId: string): Promise<boolean> {
  const state = await getRunCancellation(runId);
  return state !== null && state.cancelRequestedAt !== null;
}

/**
 * Lands a stopped run on `cancelled`, keeping every step and file it produced
 * first, so a poller never sees a terminal run without its output.
 *
 * Evaluation is deliberately skipped and recorded as "nothing to judge": the
 * judge answers "did the run do what was asked", and a run the user stopped
 * was never given the chance to.
 */
async function finaliseCancellation(runId: string, cwd: string): Promise<void> {
  await appendRunEvent(runId, "run_cancelled", {
    message: "You stopped this run. Everything it had done up to here is kept.",
  });
  await replaceRunArtifacts(runId, await collectArtifacts(cwd)).catch(() => undefined);
  if (await markRunCancelled(runId)) await recordCancelledEvaluation(runId);
}

/** Is this process still executing the run? */
export function isRunInFlight(runId: string): boolean {
  return inFlight.has(runId);
}

/**
 * Finalises a stop that has no loop left to honour it: the server restarted
 * mid-run, or the runner died, and the row would otherwise sit in "stopping"
 * for ever. A run this process is executing is left alone — its own loop will
 * notice at the next step boundary — and so is a stop younger than the grace
 * window, which may still belong to a runner that is only just starting.
 */
export async function reconcileCancellation(
  runId: string,
  graceMs = ORPHANED_CANCEL_MS,
): Promise<boolean> {
  if (inFlight.has(runId)) return false;
  const state = await getRunCancellation(runId);
  if (!state || state.cancelRequestedAt === null) return false;
  if (isTerminalRunStatus(state.status)) return false;
  if (Date.now() - new Date(state.cancelRequestedAt).getTime() < graceMs) return false;
  await finaliseCancellation(runId, runWorkspaceDir(runId));
  return true;
}

interface McpSetup {
  servers: Record<string, McpServerConfig>;
  /** Fully qualified tool names (mcp__key__tool) the agent may call. */
  toolNames: string[];
  /** Tools removed from the agent's context, so read-only really is read-only. */
  deniedToolNames: string[];
  promptLines: string[];
  /** Servers that were asked for but could not be connected; the run goes on without them. */
  notices: string[];
}

/**
 * Turns enabled MCP connections into SDK config plus an explicit tool
 * allow-list. Mutating tools are only in that list when the user opted the
 * server into writes; otherwise they are denied by name as well, because the
 * SDK still exposes everything the server advertises.
 */
async function buildMcpSetup(rows: McpServerConfigRow[]): Promise<McpSetup> {
  const servers: Record<string, McpServerConfig> = {};
  const toolNames: string[] = [];
  const deniedToolNames: string[] = [];
  const promptLines: string[] = [];
  const notices: string[] = [];

  for (const row of rows) {
    let headers = row.headers;
    let readTools = row.allowedTools;
    let writeTools = row.writeTools;

    if (row.authMode === "oauth") {
      try {
        const token = await bearerTokenFor(row);
        headers = { ...headers, Authorization: `Bearer ${token}` };
        // Take the tool list from the server itself rather than from anything
        // written down here, so a surface that changed since the last run is
        // picked up instead of silently keeping the agent on an older one.
        const advertised = await refreshAdvertisedTools(row, token);
        if (advertised) {
          readTools = advertised.readTools;
          writeTools = advertised.writeTools;
        }
      } catch (error) {
        if (!(error instanceof McpAuthError)) throw error;
        notices.push(`${row.name} MCP was skipped: ${error.message}`);
        promptLines.push(
          `The "${row.name}" MCP server is unavailable for this run; do not try to use it and say so in your summary.`,
        );
        continue;
      }
    }

    if (row.transport === "stdio" && row.command) {
      // The SDK spawns MCP servers from the run's workspace folder, so
      // project-relative commands (node_modules/.bin/...) must be made absolute.
      const command = row.command.includes("/")
        ? path.resolve(process.cwd(), row.command)
        : row.command;
      servers[row.key] = {
        type: "stdio",
        command,
        args: row.args,
        env: { ...process.env, ...row.env } as Record<string, string>,
      };
    } else if (row.transport === "http" && row.url) {
      servers[row.key] = { type: "http", url: row.url, headers };
    } else {
      continue;
    }

    if (readTools.length === 0 && writeTools.length === 0) {
      // No lists at all: expose the whole server, as before.
      toolNames.push(`mcp__${row.key}`);
      promptLines.push(
        `The "${row.name}" MCP server (tools prefixed mcp__${row.key}__) is connected; use it whenever the task involves data from ${row.name}.`,
      );
      continue;
    }

    const allowed = row.allowWrites ? [...readTools, ...writeTools] : readTools;
    toolNames.push(...allowed.map((t) => `mcp__${row.key}__${t}`));
    if (!row.allowWrites) {
      deniedToolNames.push(...writeTools.map((t) => `mcp__${row.key}__${t}`));
    }
    promptLines.push(
      row.allowWrites
        ? `The "${row.name}" MCP server (tools prefixed mcp__${row.key}__) is connected with write access; only create or change things there when the task explicitly asks for it, and report every change in your summary.`
        : `The "${row.name}" MCP server (tools prefixed mcp__${row.key}__) is connected read-only; use it whenever the task involves data from ${row.name}.`,
    );

    // Notion routes searches by plan, and a listed tool is not always usable.
    // Keyed off an advertised tool rather than the server's identity.
    if (readTools.includes("notion-fetch")) {
      promptLines.push(
        `Before the first content search on "${row.name}", call notion-fetch with the id "self" and read the current_tool_access map: use notion-ai-search for content searches when its ai_search entry is "available", otherwise use notion-search. Treat an entry of upgrade_required, plan_required or not_enabled as "this tool is unavailable on this workspace's plan": do not call it, and say so in your summary instead of retrying.`,
      );
    }
  }

  return { servers, toolNames, deniedToolNames, promptLines, notices };
}

type ResultMessage = Extract<SDKMessage, { type: "result" }>;

function describeFailure(result: ResultMessage): string {
  if (result.subtype === "success") {
    return result.is_error ? result.result : "";
  }
  const detail = result.errors.length > 0 ? `: ${result.errors.join("; ")}` : "";
  switch (result.subtype) {
    case "error_max_turns":
      return `The agent hit the turn limit (${result.num_turns})${detail}`;
    case "error_max_budget_usd":
      return `The agent hit the cost budget${detail}`;
    default:
      return `The agent stopped with ${result.subtype}${detail}`;
  }
}

/**
 * Runs the intake check in front of the agent: if the task is too
 * underspecified to run, the run parks in `awaiting_input` with its questions
 * and this returns "paused". Answering them re-enters runAgent, and the
 * `pending` guard means the check happens at most once per run. Any failure of
 * the check itself degrades to running the task as submitted — a clarification
 * model that is down must never block the work.
 */
async function resolveClarification(run: Run): Promise<"paused" | "continue"> {
  const decision = await planClarification(run.prompt);

  if (decision.kind === "unavailable") {
    await markClarificationChecked(run.id, "unavailable");
    await appendRunEvent(run.id, "clarification_notice", {
      message: `Could not check whether the task needed clarifying (${decision.error}). Running it as submitted.`,
    });
    return "continue";
  }

  // The common case. Deliberately silent: a step saying "no questions needed"
  // on every clear prompt would be noise in the step list.
  if (decision.kind === "proceed") {
    await markClarificationChecked(run.id, "not_needed");
    return "continue";
  }

  if (!(await pauseRunForClarification(run.id, decision.questions))) return "continue";
  await appendRunEvent(run.id, "clarification_asked", {
    reason: decision.reason,
    questions: decision.questions.map((q) => q.question),
  });
  return "paused";
}

/** The user's task plus whatever the question round added to it. */
function composePrompt(run: Run): string {
  // What to work on now is the current turn's instruction, not the one the run
  // was started with — those are the same thing only until the first follow-up.
  const prompt = latestPrompt(run);
  const { state, questions, answers } = run.clarification;
  if (state !== "answered" && state !== "skipped") return prompt;

  const context = formatClarificationContext(questions, answers);
  if (context) return `${prompt}\n\n${context}`;
  return [
    prompt,
    "The user was asked to clarify this task and chose not to answer. Proceed on the most reasonable reading, and state the assumptions you made in your summary.",
  ].join("\n\n");
}

interface RunModelChoice {
  model: AgentModelId;
  reasoning: boolean;
  /** Set only for an Auto run, so the step list can explain the pick. */
  routing: RoutingOutcome | null;
}

/**
 * What this run will actually use. Auto asks the router; everything else is
 * already concrete. Settled once, at start, so a run in flight keeps the model
 * it began with no matter what the picker does afterwards.
 */
async function resolveRunModel(run: Run): Promise<RunModelChoice> {
  if (isAutoSelection(run.requestedModel)) {
    const routing = await routeModel(run.prompt);
    return { model: routing.model, reasoning: routing.reasoning, routing };
  }

  // A row may hold a family alias from before versioned ids, or nothing at all
  // if it predates the picker; both land on a concrete id.
  const model = run.resolvedModel ?? resolveAgentModelId(run.requestedModel);
  return {
    model,
    // A stored `true` against a model with no extended thinking would ask the
    // API for something it does not have.
    reasoning: run.reasoning && modelSupportsReasoning(model),
    routing: null,
  };
}

interface Continued {
  /** The session to reopen, when one is still on disk to reopen. */
  resume: string | null;
  /** The workspace to work in: a follow-up inherits the files it produced. */
  cwd: string;
  /**
   * A written account of the earlier run, used only when the session could not
   * be reopened. Null when it could, because then the agent has the real thing.
   */
  brief: string | null;
}

/**
 * Works out what the turn about to run actually inherits.
 *
 * Reopening the session is the real feature: the agent carries on as the same
 * conversation, remembering its own reasoning and the files it wrote. That is
 * only possible while the transcript is on disk, so when it is not — a run
 * from before sessions were kept, or a transcript since cleared — the turn
 * falls back to a fresh agent handed a written account of the turns before it.
 * The two are recorded differently on the turn, and the UI says which the user
 * got, because the difference decides whether their follow-up makes sense.
 */
async function resolveContinuation(run: Run, turnSeq: number): Promise<Continued> {
  // A run's turns all happen in the run's own workspace, so the agent can read
  // and edit what earlier turns wrote. The exception is a run created while
  // follow-ups were briefly separate records: it borrows its parent's.
  const cwd = await runChainWorkspaceDir(run);
  if (turnSeq <= 1 && run.parentRunId === null) {
    return { resume: null, cwd, brief: null };
  }

  // Later turns reopen this run's own session — literally the same
  // conversation, not a copy of it. A legacy child run reopens its parent's.
  const sourceId = turnSeq > 1 ? run.id : (run.parentRunId ?? run.id);
  const sessionId = await getRunSession(sourceId);
  if (sessionId && (await sessionTranscriptExists(sessionId, cwd))) {
    return { resume: sessionId, cwd, brief: null };
  }

  const earlier =
    turnSeq > 1
      ? run.turns.filter((turn) => turn.seq < turnSeq)
      : ((await getRun(run.parentRunId ?? "")) ?? { turns: [] }).turns;
  return { resume: null, cwd, brief: describeEarlierTurns(run, earlier) };
}

/** Follows the chain to the run that owns the workspace the others share. */
export async function runChainWorkspaceDir(run: Run): Promise<string> {
  let current = run;
  // Bounded: a chain longer than this is a loop, and the workspace of the run
  // in hand is a safe answer either way.
  for (let depth = 0; depth < 20 && current.parentRunId !== null; depth += 1) {
    const parent = await getRun(current.parentRunId);
    if (!parent) break;
    current = parent;
  }
  return runWorkspaceDir(current.id);
}

/** What a fresh agent is told about the turns it cannot remember taking. */
function describeEarlierTurns(run: Run, earlier: readonly RunTurn[]): string {
  const exchanges = earlier.map((turn) => {
    const outcome =
      turn.status === "cancelled"
        ? "(the user stopped this one part-way)"
        : turn.status === "failed"
          ? `(this one ended in an error: ${turn.error ?? "no detail was recorded"})`
          : "";
    return [
      `They asked: ${turn.prompt}`,
      outcome,
      turn.resultText ? `You replied:\n${turn.resultText}` : "You left no reply.",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const files =
    run.artifacts.length > 0
      ? `Files left in this workspace, which you can read and edit: ${run.artifacts.map((a) => a.name).join(", ")}.`
      : "No files were left in the workspace.";

  return [
    "You are continuing a conversation you do not remember: the earlier session could not be reopened, so the account below is all you have of it.",
    exchanges.join("\n\n"),
    files,
    "Say plainly in your summary if the request below depends on something from that earlier work that you were not given.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Executes a queued run to completion, persisting every SDK message as a
 * run_event and the final outcome onto the run row. Safe to call once per run;
 * the queued -> running guard makes a second call a no-op.
 */
export async function runAgent(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  if (isTerminalRunStatus(run.status)) return;

  // Everything below belongs to one turn of the conversation: its events are
  // tagged with it, and its outcome closes it before rolling up into the run.
  const turn = await currentTurnSeq(runId);
  const continued = await resolveContinuation(run, turn);
  const cwd = continued.cwd;
  const continuation: Continuation =
    turn === 1 && run.parentRunId === null ? "none" : continued.resume ? "resumed" : "seeded";

  // Stopped before this loop ever got going — while it sat queued, or while it
  // was parked on the pre-run questions. Nothing has started, so nothing has to
  // be interrupted: the run just lands on `cancelled` here.
  if (run.cancelRequestedAt !== null) {
    await finaliseCancellation(runId, cwd);
    return;
  }

  if (run.status === "queued" && run.clarification.state === "pending") {
    if ((await resolveClarification(run)) === "paused") return;
  }

  const claimed = await markRunning(runId);
  if (!claimed) return;
  await markTurnRunning(runId, turn, continuation);

  await mkdir(cwd, { recursive: true });

  let model: string | null = null;
  let result: ResultMessage | null = null;

  // A stop is honoured at step boundaries, and the signal is handed to the SDK
  // so an in-flight model or tool call is dropped rather than waited out.
  const abortController = new AbortController();
  let stopping = false;
  inFlight.add(runId);
  const stopWatch = setInterval(() => {
    void cancellationRequested(runId)
      .then((requested) => {
        if (!requested || stopping) return;
        stopping = true;
        abortController.abort();
      })
      .catch(() => undefined);
  }, CANCEL_POLL_MS);

  try {
    // Only the servers that were enabled when the run was created take part.
    const enabled = (await listEnabledMcpServerConfigs()).filter((s) =>
      run.mcpServers.includes(s.name),
    );
    // Of those, only the ones this task plausibly needs: every attached server
    // spends context and tempts the model into using it. The task text used
    // here includes the clarification answers, so a run whose nature changed in
    // the question round is judged on what it actually became.
    const task = composePrompt(run);
    const selection = await selectMcpServers(task, enabled);
    await appendRunEvent(runId, "mcp_notice", { message: selection.reason });

    const mcp = await buildMcpSetup(selection.attach);
    // The agent's only channel back to the user: it pauses the run rather than
    // guessing when a required value is genuinely only the user's to give.
    const ask = buildAskUserSetup(runId);
    const tools = [...AGENT_TOOLS, ...mcp.toolNames, ask.toolName];

    // Naming a server that is off or signed out should be said out loud, not
    // silently ignored until the agent invents an answer instead.
    const namedButMissing = (await listMcpServers()).filter(
      (server) =>
        namedInPrompt(task, server) && !selection.attach.some((s) => s.id === server.id),
    );
    for (const server of namedButMissing) {
      const why =
        server.authStatus === "needs_auth" || server.authStatus === "error"
          ? "it is not signed in"
          : "it is switched off for this run";
      mcp.notices.push(`${server.name} was named in the task but ${why}.`);
      mcp.promptLines.push(
        `The "${server.name}" server is named in the task but unavailable because ${why}; do not pretend to use it, and say so plainly in your summary.`,
      );
    }

    // A server the user asked for but that is not authorized shows up in the
    // step list instead of failing the run.
    for (const notice of mcp.notices) {
      await appendRunEvent(runId, "mcp_notice", { message: notice });
    }

    // So the run page tells the whole story: the answers are part of the work.
    if (run.clarification.state === "answered" || run.clarification.state === "skipped") {
      await appendRunEvent(runId, "clarification_answered", {
        skipped: run.clarification.state === "skipped",
        answers: run.clarification.questions.map((question) => {
          const answer = run.clarification.answers.find((a) => a.questionId === question.id);
          const parts = [...(answer?.selected ?? [])];
          if (answer?.text) parts.push(answer.text);
          return { question: question.question, answer: parts.join("; ") };
        }),
      });
    }

    // The intake calls above are model calls of their own and do not take the
    // abort signal, so the stop is checked between them rather than only once
    // at the end: a run stopped seconds after starting should not have to wait
    // out the whole of its own setup.
    if (await cancellationRequested(runId)) {
      await finaliseCancellation(runId, cwd);
      return;
    }

    const choice = await resolveRunModel(run);
    await saveResolvedModel(runId, choice.model, choice.reasoning);
    if (choice.routing) {
      await appendRunEvent(runId, "model_routing", {
        model: choice.model,
        reasoning: choice.reasoning,
        rationale: choice.routing.rationale,
        routed: choice.routing.routed,
        // The run's own cost figure covers the agent loop only, so what the
        // routing call spent is recorded here rather than going unaccounted.
        costUsd: choice.routing.costUsd,
      });
    }

    // Last boundary before anything is spent on the model: a stop asked for
    // while the intake work above was running is honoured without starting.
    if (await cancellationRequested(runId)) {
      await finaliseCancellation(runId, cwd);
      return;
    }

    // Said out loud at the head of the turn, because the difference matters to
    // whoever reads it back: one of these agents remembers the earlier turns,
    // the other has only been told about them.
    if (turn > 1 || run.parentRunId !== null) {
      await appendRunEvent(runId, "clarification_notice", {
        message: continued.resume
          ? "Carrying on in the same session: the agent still has everything it did earlier in this run."
          : "The earlier session could not be reopened, so this turn starts fresh with a written summary of what came before. The agent does not remember that work itself.",
      });
    }

    const stream = query({
      prompt: continued.brief
        ? `${continued.brief}\n\n---\n\nWhat to do now:\n${composePrompt(run)}`
        : composePrompt(run),
      options: {
        cwd,
        // Reopens the conversation, which is what makes a follow-up a
        // continuation rather than a restart. Not forked: the turns of a run
        // are one thread and belong in one session, and only one turn can be
        // open at a time, so there is nothing to branch away from. The
        // exception is a legacy child run, which must not write into the
        // session its parent still owns.
        ...(continued.resume
          ? { resume: continued.resume, ...(run.parentRunId !== null ? { forkSession: true } : {}) }
          : {}),
        // Aborts the CLI's in-flight work, so a stop lands within a second
        // instead of waiting out the current model or tool call.
        abortController,
        // Always a concrete id by this point: the picker's choice, or the
        // router's for an Auto run.
        model: choice.model,
        systemPrompt: [SYSTEM_PROMPT, ask.promptLine, ...mcp.promptLines].join(" "),
        mcpServers: { ...mcp.servers, [ASK_USER_SERVER_KEY]: ask.server },
        tools,
        allowedTools: tools,
        disallowedTools: ["Bash", ...mcp.deniedToolNames],
        permissionMode: "acceptEdits",
        permissionPrompts: "none",
        settingSources: [],
        strictMcpConfig: true,
        // Kept on disk on purpose: this is the transcript a follow-up reopens.
        // With it off the SDK cannot resume a session at all, and every
        // continuation would silently degrade to a summary.
        persistSession: true,
        maxTurns: 30,
        // Summarised rather than omitted so the live view can show what the
        // model is reasoning about; without it the thinking blocks are empty.
        // Off by default: extended thinking is slower and costs more, and the
        // models without it reject being asked.
        thinking: choice.reasoning
          ? { type: "adaptive", display: "summarized" }
          : { type: "disabled" },
      },
    });

    for await (const message of stream) {
      await appendRunEvent(runId, message.type, message);

      if (message.type === "system" && message.subtype === "init") {
        model = message.model;
        // Recorded as soon as it is known rather than at the end, so a run that
        // is stopped or fails can still be followed up — which is when a user
        // most often wants to.
        await saveRunSession(runId, message.session_id);
      }
      if (message.type === "result") {
        result = message;
      }

      // Step boundary: the message just recorded is kept, and the loop stops
      // here rather than letting the next tool call or model turn begin.
      if (stopping) break;
    }

    if (stopping) {
      await finaliseCancellation(runId, cwd);
      return;
    }

    if (!result) {
      throw new Error("The agent stream ended without a result message.");
    }

    // Record artifacts before flipping the status so a poller never sees a
    // finished run without its files.
    await replaceRunArtifacts(runId, await collectArtifacts(cwd));

    const failure = describeFailure(result);
    await finishTurn(runId, turn, {
      status: failure ? "failed" : "succeeded",
      resultText: result.subtype === "success" ? result.result : null,
      error: failure || null,
      model,
      costUsd: result.total_cost_usd,
      numTurns: result.num_turns,
      continuation,
    });
  } catch (error) {
    // The abort the stop fired surfaces here as a thrown error. A run the user
    // stopped is not a run that broke, so it never lands on `failed`.
    if (stopping || (await cancellationRequested(runId))) {
      await finaliseCancellation(runId, cwd);
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    await appendRunEvent(runId, "runner_error", { message });
    // Keep whatever the agent managed to write before the failure.
    await replaceRunArtifacts(runId, await collectArtifacts(cwd)).catch(() => undefined);
    await finishTurn(runId, turn, {
      status: "failed",
      resultText: null,
      error: message,
      model,
      costUsd: null,
      numTurns: null,
      continuation,
    });
  } finally {
    clearInterval(stopWatch);
    inFlight.delete(runId);
  }

  // "The loop finished" and "the run did what the user asked" are different
  // questions; now that the row is terminal, answer the second one too.
  // Inline rather than a separate trigger: runAgent is already a background
  // after() task, so one more model call costs nothing here, and sequencing it
  // guarantees the run is terminal before the evaluator reads it.
  await evaluateRun(runId, cwd);
}
