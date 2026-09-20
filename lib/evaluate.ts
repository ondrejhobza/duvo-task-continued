import { open } from "node:fs/promises";
import { extractStructured } from "@/lib/llm";
import { resolveArtifactPath } from "@/lib/artifacts";
import { beginEvaluation, getRun, saveEvaluation, type SaveEvaluationInput } from "@/lib/repo";
import {
  judgeResultSchema,
  latestPrompt,
  type Artifact,
  type Evaluation,
  type GateCheck,
  type JudgeResult,
  type RequirementCheck,
  type Run,
  type Verdict,
} from "@/lib/schema";

/**
 * Decides whether a finished run did what the user asked for.
 *
 * Two stages, cheapest first. A deterministic gate reads what the run actually
 * produced and settles the cases that need no judgement — the run never
 * finished, it produced nothing at all, the file it was asked for is missing
 * or corrupt. Only if the gate is satisfied does an LLM judge read the user's
 * task and the output and rule on whether the request was satisfied.
 *
 * This is a different question from the run's `status`. `status` says whether
 * the agent loop terminated cleanly; the verdict says whether the user got
 * what they wanted. A run is routinely `succeeded` and `fail`.
 */

/** Per-body budget handed to the judge; the model sees a truncation notice. */
const MAX_EVIDENCE_CHARS = 20_000;
/** Never slurp a large file into memory just to grade it. */
const MAX_READ_BYTES = 2_000_000;
const MAX_RESULT_TEXT_CHARS = 8_000;
/** How many rows of a CSV to structurally check. */
const CSV_ROWS_CHECKED = 50;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "image/svg+xml",
]);

function isTextArtifact(artifact: Artifact): boolean {
  return artifact.mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(artifact.mimeType);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep the end too: it is where a truncated CSV or report shows its shape.
  const head = text.slice(0, Math.floor(max * 0.8));
  const tail = text.slice(-Math.floor(max * 0.2));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n\n… [${omitted} characters omitted from the middle] …\n\n${tail}`;
}

interface FileHead {
  text: string;
  /** The file was longer than the cap, so the last record may be cut in half. */
  truncated: boolean;
}

async function readTextHead(filePath: string): Promise<FileHead | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: bytesRead === MAX_READ_BYTES,
    };
  } finally {
    await handle.close();
  }
}

// ---------- Deterministic checks ----------

/**
 * Output formats named explicitly enough that "you asked for this file and it
 * is not here" is a fact rather than a guess. Deliberately high precision:
 * a task that merely says "summarise" is not required to write anything.
 */
const NAMED_FORMATS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "CSV", pattern: /\bcsv\b/i },
  { label: "JSON", pattern: /\bjsonl?\b/i },
  { label: "Markdown file", pattern: /\bmarkdown file\b|\b\.md\b/i },
  { label: "XLSX", pattern: /\bxlsx\b|\bexcel\b|\bspreadsheet\b/i },
  { label: "PDF", pattern: /\bpdf\b/i },
  { label: "TSV", pattern: /\btsv\b/i },
];

function namedOutputFormats(prompt: string): string[] {
  return NAMED_FORMATS.filter((f) => f.pattern.test(prompt)).map((f) => f.label);
}

/** Quote-aware field count for one RFC 4180 record. */
function countFields(record: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < record.length; i += 1) {
    const char = record[i];
    if (char === '"') {
      if (inQuotes && record[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields += 1;
    }
  }
  return fields;
}

/**
 * Splits CSV text into logical records. A newline inside a quoted field is
 * part of the value, not a record separator, so a naive line split would
 * report perfectly good files as ragged.
 */
function splitCsvRecords(text: string): string[] {
  const records: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (current.trim().length > 0) records.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) records.push(current);
  return records;
}

interface ParseCheck {
  passed: boolean;
  detail: string;
}

function checkParses(artifact: Artifact, head: FileHead): ParseCheck | null {
  const trimmed = head.text.trim();

  // A cut-off file cannot be judged on structure; the last record is a stub.
  if (head.truncated) {
    return {
      passed: true,
      detail: "Too large to check in full; the first part was read.",
    };
  }

  if (artifact.mimeType.startsWith("application/json")) {
    try {
      JSON.parse(trimmed);
      return { passed: true, detail: "Valid JSON." };
    } catch (error) {
      return {
        passed: false,
        detail: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (artifact.mimeType.startsWith("text/csv")) {
    const records = splitCsvRecords(trimmed);
    if (records.length < 2) {
      return { passed: false, detail: "A header row and at least one record are expected." };
    }
    const expected = countFields(records[0]);
    const ragged = records
      .slice(1, CSV_ROWS_CHECKED + 1)
      .findIndex((record) => countFields(record) !== expected);
    if (ragged >= 0) {
      const actual = countFields(records[ragged + 1]);
      return {
        passed: false,
        detail: `Record ${ragged + 1} has ${actual} fields but the header declares ${expected} — most likely an unquoted comma.`,
      };
    }
    return { passed: true, detail: `${records.length - 1} records across ${expected} columns.` };
  }

  if (artifact.mimeType.startsWith("application/x-ndjson")) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line);
      } catch {
        return { passed: false, detail: `Line ${index + 1} is not valid JSON.` };
      }
    }
    return { passed: true, detail: `${lines.length} JSON records.` };
  }

  // Nothing structural to assert for prose or binary formats.
  return null;
}

export interface RunEvidence {
  checks: GateCheck[];
  /** False when a check settles the outcome and no model call is warranted. */
  passed: boolean;
  /** The file the verdict is mainly about, when the run wrote one. */
  primaryArtifactName: string | null;
  /** The rendered material handed to the judge. */
  body: string;
}

/**
 * Reads everything the run produced and applies the checks that need no
 * model. Evidence is the final reply plus any files: a run that was never
 * asked for a file is judged on its reply alone.
 */
export async function gatherEvidence(
  run: Run,
  workspaceDir: string,
  /**
   * An instruction from outside this run that it continues. Only used by the
   * few runs created while follow-ups were separate records; a run's own
   * earlier turns are read off the run itself, below.
   */
  earlier: string | null = null,
): Promise<RunEvidence> {
  const checks: GateCheck[] = [];
  const resultText = (run.resultText ?? "").trim();
  // A multi-turn run is judged on where it has got to: the latest instruction
  // against the latest reply. Grading "now make it shorter" against the
  // original task would produce nonsense, and one verdict per run — replaced
  // each turn rather than added to — is also what keeps the "did what was
  // asked" rate counting each run once however long the conversation runs.
  const requestedFormats = namedOutputFormats(latestPrompt(run));

  // Read the text artifacts up front; the checks and the evidence both need them.
  const heads = new Map<string, FileHead>();
  const missing: string[] = [];
  const empty: string[] = [];

  for (const artifact of run.artifacts) {
    if (!isTextArtifact(artifact)) {
      if (artifact.sizeBytes === 0) empty.push(artifact.name);
      continue;
    }
    const filePath = resolveArtifactPath(workspaceDir, artifact.name);
    const head = filePath ? await readTextHead(filePath) : null;
    if (head === null) {
      missing.push(artifact.name);
    } else if (head.text.trim().length === 0) {
      empty.push(artifact.name);
    } else {
      heads.set(artifact.name, head);
    }
  }

  const hasOutput = resultText.length > 0 || run.artifacts.length > 0;
  checks.push({
    label: "The run produced something",
    passed: hasOutput,
    detail: hasOutput
      ? [
          resultText.length > 0 ? "a final reply" : null,
          run.artifacts.length > 0
            ? `${run.artifacts.length} file${run.artifacts.length === 1 ? "" : "s"}`
            : null,
        ]
          .filter(Boolean)
          .join(" and ")
      : "No reply text and no files.",
  });

  if (requestedFormats.length > 0) {
    const produced = run.artifacts.length > 0;
    checks.push({
      label: "A file was produced, as the task asked",
      passed: produced,
      detail: produced
        ? `Task names ${requestedFormats.join(", ")}; the run wrote ${run.artifacts
            .map((a) => a.name)
            .join(", ")}.`
        : `Task names ${requestedFormats.join(", ")} but the run wrote no file.`,
    });
  } else if (run.artifacts.length === 0) {
    checks.push({
      label: "No file expected",
      passed: true,
      detail: "The task did not name an output format, so the reply is the deliverable.",
    });
  }

  if (missing.length > 0) {
    checks.push({
      label: "Recorded files exist on disk",
      passed: false,
      detail: `Missing from the workspace: ${missing.join(", ")}.`,
    });
  }
  if (empty.length > 0) {
    checks.push({
      label: "Files are not empty",
      passed: false,
      detail: `Empty: ${empty.join(", ")}.`,
    });
  }

  for (const artifact of run.artifacts) {
    const head = heads.get(artifact.name);
    if (head === undefined) continue;
    const parse = checkParses(artifact, head);
    if (parse) {
      checks.push({
        label: `${artifact.name} is well-formed`,
        passed: parse.passed,
        detail: parse.detail,
      });
    }
  }

  // Largest readable file first: the biggest one is almost always the deliverable.
  const readable = run.artifacts
    .filter((a) => heads.has(a.name))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    checks,
    passed: checks.every((c) => c.passed),
    primaryArtifactName: readable[0]?.name ?? null,
    body: renderEvidence(run, resultText, readable, heads, earlier),
  };
}

function renderEvidence(
  run: Run,
  resultText: string,
  readable: Artifact[],
  heads: Map<string, FileHead>,
  earlier: string | null,
): string {
  const sections: string[] = [];

  // Everything the conversation asked for before the instruction being judged.
  // The judge needs it to know what "it" refers to in "now make it shorter",
  // and needs telling just as plainly that it is not what is being graded.
  const background = [
    earlier,
    ...run.turns.slice(0, -1).map((turn) => turn.prompt),
  ].filter((text): text is string => text !== null && text.trim().length > 0);

  if (background.length > 0) {
    sections.push(
      `## Background: what the user asked for earlier in this conversation\n\n${background
        .map((text, index) => `${index + 1}. ${text}`)
        .join("\n")}\n\nJudge only the task below, not these.`,
    );
  }

  sections.push(
    `## The user's task\n\n${latestPrompt(run)}`,
    `## What the run produced\n\nFinal reply:\n${
      resultText ? truncate(resultText, MAX_RESULT_TEXT_CHARS) : "(the run left no final reply)"
    }`,
  );

  if (run.artifacts.length === 0) {
    sections.push("## Files written\n\nNone. The final reply above is the whole deliverable.");
    return sections.join("\n\n");
  }

  sections.push(
    `## Files written\n\n${run.artifacts
      .map((a) => `- ${a.name} (${a.mimeType}, ${a.sizeBytes} bytes)`)
      .join("\n")}`,
  );

  // Spend the content budget on the biggest readable files first.
  let remaining = MAX_EVIDENCE_CHARS;
  for (const artifact of readable) {
    if (remaining <= 0) break;
    const content = heads.get(artifact.name)?.text ?? "";
    const slice = truncate(content, remaining);
    remaining -= slice.length;
    sections.push(`## Contents of ${artifact.name}\n\n${slice}`);
  }

  const unread = run.artifacts.filter((a) => !heads.has(a.name));
  if (unread.length > 0) {
    sections.push(
      `## Not shown\n\n${unread
        .map((a) => `- ${a.name} (${a.mimeType}) — binary or unreadable, judge it by name and size only`)
        .join("\n")}`,
    );
  }

  return sections.join("\n\n");
}

// ---------- The judge ----------

const JUDGE_SYSTEM = [
  "You grade whether an automated agent run finished what the user asked for.",
  "You are given the user's original task and everything the run produced: its final reply and the contents of any files it wrote.",
  "",
  "Work in two steps.",
  "First, extract the discrete, checkable requirements the user's task implies — the things that must be true for the user to consider the request done. Use the user's own terms. Do not invent requirements the user did not ask for, and do not grade style, tone, formatting or effort.",
  "Second, check the produced output against each requirement and mark it yes, partly or no, naming the evidence you used.",
  "",
  "Then choose a verdict:",
  "- pass: every requirement is met.",
  "- partial: the output does real work on the task, but at least one requirement is unmet or only partly met. A request for five things answered with three is partial.",
  "- fail: the output does not do what was asked. It is off-topic, empty, refuses, asks a clarifying question instead of doing the work, or misses the central requirement.",
  "- inconclusive: the task is too vague to yield any checkable requirement, so there is nothing to grade against. Do not use this because you feel unsure — only when the task itself cannot be checked.",
  "",
  "Judge satisfaction of the request, not quality in the abstract. A fluent, confident output that answers a different question than the one asked is a fail.",
  "You cannot browse, so do not mark a requirement unmet merely because you cannot independently verify a fact the output states. Judge whether the output addresses the requirement.",
  "A run that was not asked for a file and wrote none has done nothing wrong; judge its final reply.",
  "Set confidence to how sure you are of your own verdict, 0 to 100.",
  "Keep rationale to one or two sentences that name the requirement which decided the verdict.",
].join("\n");

/**
 * Guards against a flattering judge: a `pass` is only allowed when every
 * requirement it listed is actually met. Verdicts are never rounded up.
 */
function reconcile(judged: JudgeResult): { verdict: Verdict; rationale: string } {
  const shortfall = judged.requirements.filter((r) => r.met !== "yes");
  if (judged.verdict === "pass" && shortfall.length > 0) {
    return {
      verdict: "partial",
      rationale: `${judged.rationale} (Recorded as partial: ${shortfall
        .map((r) => r.requirement)
        .join("; ")} not fully met.)`,
    };
  }
  return { verdict: judged.verdict, rationale: judged.rationale };
}

// ---------- Orchestration ----------

export type EvaluateRunResult =
  | { ok: true; evaluation: Evaluation }
  | { ok: false; reason: "not_found" | "run_active" | "run_cancelled" | "already_running" };

function blankJudgeFields(): Pick<
  SaveEvaluationInput,
  "judgeVerdict" | "judgeConfidence" | "judgeRationale" | "judgeRequirements" | "judgeError" | "judgeModel" | "costUsd"
> {
  return {
    judgeVerdict: null,
    judgeConfidence: null,
    judgeRationale: null,
    judgeRequirements: [],
    judgeError: null,
    judgeModel: null,
    costUsd: null,
  };
}

/**
 * Claims and runs the evaluation of one finished run. The claim is guarded in
 * SQL, so calling this twice for the same run is safe: the second call is
 * refused with `already_running` rather than starting a second judge.
 */
export async function evaluateRun(
  runId: string,
  workspaceDir: string,
): Promise<EvaluateRunResult> {
  const claim = await beginEvaluation(runId);
  if (!claim.ok) return claim;
  const evaluation = await performEvaluation(runId, workspaceDir);
  return evaluation ? { ok: true, evaluation } : { ok: false, reason: "not_found" };
}

/**
 * Does the grading for a run whose evaluation has already been claimed with
 * `beginEvaluation`. Callers that need to answer the client before the judge
 * has finished claim first and run this in the background.
 */
export async function performEvaluation(
  runId: string,
  workspaceDir: string,
): Promise<Evaluation | null> {
  try {
    return await gradeRun(runId, workspaceDir);
  } catch (error) {
    // The claim is already in the database; leaving it on "running" would show
    // a spinner forever, so land on a retryable state instead.
    const message = error instanceof Error ? error.message : String(error);
    return saveEvaluation(runId, {
      ...blankJudgeFields(),
      status: "unavailable",
      gatePassed: false,
      gateChecks: [],
      artifactName: null,
      judgeError: message,
    }).catch(() => null);
  }
}

/**
 * Records that a stopped run has nothing to grade, without calling the judge.
 * The verdict asks whether the run did what was asked; a run the user stopped
 * was never given the chance, so grading it would be grading the user.
 */
export async function recordCancelledEvaluation(runId: string): Promise<Evaluation | null> {
  return saveEvaluation(runId, {
    ...blankJudgeFields(),
    status: "not_evaluable",
    gatePassed: false,
    gateChecks: [
      {
        label: "The run finished",
        passed: false,
        detail: "You stopped this run, so there is no finished attempt to grade.",
      },
    ],
    artifactName: null,
  }).catch(() => null);
}

async function gradeRun(runId: string, workspaceDir: string): Promise<Evaluation | null> {
  const run = await getRun(runId);
  if (!run) return null;

  if (run.status === "cancelled") return recordCancelledEvaluation(runId);

  // A run that crashed cannot be graded on "did it do what was asked": there
  // is no finished attempt to grade. Say so rather than calling it a failure.
  if (run.status === "failed") {
    return saveEvaluation(runId, {
      ...blankJudgeFields(),
      status: "not_evaluable",
      gatePassed: false,
      gateChecks: [
        {
          label: "The run finished",
          passed: false,
          detail: run.error ?? "The run did not complete, so there is no output to grade.",
        },
      ],
      artifactName: null,
    });
  }

  // A follow-up is graded on what it was asked to do, with the request it
  // continues supplied only as background.
  const parent = run.parentRunId === null ? null : await getRun(run.parentRunId);
  const evidence = await gatherEvidence(run, workspaceDir, parent?.prompt ?? null);

  // The gate settled it; no model call.
  if (!evidence.passed) {
    const failed = evidence.checks.filter((c) => !c.passed);
    return saveEvaluation(runId, {
      ...blankJudgeFields(),
      status: "done",
      gatePassed: false,
      gateChecks: evidence.checks,
      artifactName: evidence.primaryArtifactName,
      judgeRationale: failed.map((c) => c.detail).join(" "),
    });
  }

  const judged = await extractStructured({
    schema: judgeResultSchema,
    system: JUDGE_SYSTEM,
    prompt: evidence.body,
  });

  // The judge is fallible and its transport can fail. Never let that read as
  // a pass, and never let it read as a failure of the run either.
  if (!judged.ok) {
    return saveEvaluation(runId, {
      ...blankJudgeFields(),
      status: "unavailable",
      gatePassed: true,
      gateChecks: evidence.checks,
      artifactName: evidence.primaryArtifactName,
      judgeError: judged.error,
    });
  }

  const { verdict, rationale } = reconcile(judged.data);
  const requirements: RequirementCheck[] = judged.data.requirements;
  return saveEvaluation(runId, {
    status: "done",
    gatePassed: true,
    gateChecks: evidence.checks,
    artifactName: evidence.primaryArtifactName,
    judgeVerdict: verdict,
    judgeConfidence: judged.data.confidence,
    judgeRationale: rationale,
    judgeRequirements: requirements,
    judgeError: null,
    judgeModel: judged.model,
    costUsd: judged.costUsd,
  });
}
