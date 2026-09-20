import { randomUUID } from "node:crypto";
import { extractStructured } from "@/lib/llm";
import {
  clarificationPlanSchema,
  hasClarificationAnswer,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_QUESTIONS,
  type ChoiceInput,
  type ClarificationAnswer,
  type PendingInput,
} from "@/lib/schema";

/**
 * Decides whether a submitted prompt is too underspecified to run, and if so
 * what to ask. The bias is heavily towards running: a tool that interrogates
 * the user about an obvious request is worse than one that just does the work,
 * so the planner has to clear a high bar and the result is filtered again here.
 */

/** Cheap and quick: this is a one-line judgement call in front of every run. */
const PLANNER_MODEL = "sonnet";
/**
 * Long enough for the model to draft three questions with options (measured at
 * 10-25s), short enough that a planner which is wedged only delays the work by
 * half a minute before the run goes ahead without it.
 */
const PLANNER_TIMEOUT_MS = 45_000;

const SYSTEM = [
  "You are the intake check of an automation platform. A user submitted a task for an autonomous agent that can search and read the web and write files.",
  "Your only job: decide whether the task is so underspecified that the agent would likely produce the wrong thing, and if so, ask the few questions that would change what it produces.",
  "Default to needsClarification=false. The agent is capable and states its assumptions; a question the user finds obvious is a worse outcome than a sensible assumption.",
  "Return needsClarification=false whenever the task is self-contained, conversational, a direct instruction, a trivial request, or answerable in any reasonable way. Examples that need no clarification: 'reply with one sentence', 'what is the capital of France', 'summarise the news about EU battery regulation', 'write a haiku about rain'.",
  "Only return needsClarification=true when a missing decision would send the agent down a materially different path: an undefined subject or scope, a named deliverable with no indication of its content, or two incompatible readings of the same sentence.",
  `Ask at most ${MAX_CLARIFICATION_QUESTIONS} questions, and only ones whose answer changes the work. Never ask for information the agent can look up, never ask about tone, formatting or file format unless the task hinges on it, and never ask a question you could answer yourself from the task text.`,
  `Every question must be answerable by picking from options: give 2 to ${MAX_CLARIFICATION_OPTIONS} short, concrete, mutually distinct options, phrased as the answer the user would give. Use type 'radio' when exactly one option can apply and 'check' when several can.`,
  "Questions are one short sentence, in the user's own vocabulary, no preamble and no apologising.",
  "reason: one sentence explaining the decision, addressed to an engineer reading the run log.",
].join(" ");

export type ClarificationDecision =
  | { kind: "ask"; questions: ChoiceInput[]; reason: string }
  | { kind: "proceed"; reason: string }
  | { kind: "unavailable"; error: string };

function cleanOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of options) {
    const option = raw.trim();
    if (!option) continue;
    const key = option.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(option);
    if (cleaned.length === MAX_CLARIFICATION_OPTIONS) break;
  }
  return cleaned;
}

/**
 * The second brake on over-asking, applied to whatever the model said: a
 * question with no options is not a question the card can render, duplicates
 * are noise, and the cap is enforced here rather than trusted to the prompt.
 */
export function normaliseQuestions(
  raw: { question: string; type: "radio" | "check"; options: string[] }[],
): ChoiceInput[] {
  const seen = new Set<string>();
  const questions: ChoiceInput[] = [];
  for (const entry of raw) {
    const question = entry.question.trim();
    if (!question) continue;
    const key = question.toLowerCase();
    if (seen.has(key)) continue;
    const options = cleanOptions(entry.options);
    if (options.length === 0) continue;
    seen.add(key);
    questions.push({ id: randomUUID(), kind: "choice", question, type: entry.type, options });
    if (questions.length === MAX_CLARIFICATION_QUESTIONS) break;
  }
  return questions;
}

export async function planClarification(prompt: string): Promise<ClarificationDecision> {
  const result = await extractStructured({
    schema: clarificationPlanSchema,
    system: SYSTEM,
    prompt: `The user submitted this task:\n\n${prompt}`,
    model: PLANNER_MODEL,
    timeoutMs: PLANNER_TIMEOUT_MS,
  });

  if (!result.ok) return { kind: "unavailable", error: result.error };

  const reason = result.data.reason.trim();
  if (!result.data.needsClarification) {
    return { kind: "proceed", reason: reason || "The task was clear enough to run as submitted." };
  }

  const questions = normaliseQuestions(result.data.questions);
  if (questions.length === 0) {
    return { kind: "proceed", reason: "No answerable question survived review; running as submitted." };
  }
  return { kind: "ask", questions, reason };
}

/**
 * Renders the answers as instructions appended to the user's own prompt, so the
 * agent reads them as part of the task rather than as a transcript to interpret.
 * Returns null when nothing usable came back, which is how a full skip reaches
 * the agent as "proceed on your own assumptions".
 */
export function formatClarificationContext(
  questions: PendingInput[],
  answers: ClarificationAnswer[],
): string | null {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const lines: string[] = [];
  const unanswered: string[] = [];

  for (const question of questions) {
    const answer = byId.get(question.id);
    if (!answer || !hasClarificationAnswer(answer)) {
      unanswered.push(question.question);
      continue;
    }
    const parts = [...answer.selected];
    if (answer.text) parts.push(answer.text);
    lines.push(`- ${question.question}\n  Answer: ${parts.join("; ")}`);
  }

  if (lines.length === 0) return null;

  const block = [
    "The user was asked to clarify the task and answered as follows. Treat these answers as part of the instructions above; where they conflict with your own reading of the task, the answers win.",
    lines.join("\n"),
  ];
  if (unanswered.length > 0) {
    block.push(
      `The user declined to answer: ${unanswered.join("; ")} — decide these yourself and state the assumption in your summary.`,
    );
  }
  return block.join("\n\n");
}
