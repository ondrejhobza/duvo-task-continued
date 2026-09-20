import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  appendRunEvent,
  getRunCancellation,
  getRunClarification,
  pauseRunForMidRunInput,
  resumeRunAfterMidRunInput,
} from "@/lib/repo";
import {
  hasClarificationAnswer,
  inputValueHintSchema,
  isAwaitingInput,
  MAX_CLARIFICATION_OPTIONS,
  MAX_CLARIFICATION_QUESTIONS,
  type ClarificationAnswer,
  type PendingInput,
} from "@/lib/schema";

/**
 * The agent's one way to reach the user mid-run: an in-process MCP tool that
 * parks the run in `awaiting_input`, waits for the answer to be submitted from
 * the browser, and returns it as the tool's result — so the session carries on
 * from where it stopped, with every step it had already taken intact.
 *
 * Asking is deliberately expensive to do: the description below, a hard cap per
 * run, and a wait that ends by itself all push the model towards searching,
 * inferring or assuming instead.
 */

export const ASK_USER_SERVER_KEY = "duvo";
const ASK_USER_TOOL = "ask_user";
export const ASK_USER_TOOL_NAME = `mcp__${ASK_USER_SERVER_KEY}__${ASK_USER_TOOL}`;

/**
 * A run may genuinely need the user more than once — a URL now, a decision
 * later — so asking again is expected rather than exceptional. The cap is only
 * here to stop a model that has started nagging; past it, it works it out.
 */
const MAX_ASKS_PER_RUN = 4;
/** The user may be away from the tab. Long enough to come back, short enough to end. */
const WAIT_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 1500;

const DESCRIPTION = [
  "Ask the user for a value you cannot obtain yourself, and wait for their reply.",
  "This is a last resort. Before calling it: search the web, read what you have, and check whether a sensible default or assumption would do. If it would, take it and say so in your summary instead of asking.",
  "Only legitimate uses: a private, internal or unguessable URL; a file or credential only the user has; a genuine either/or preference with no defensible default; a value the task refers to but never gives.",
  "Never use it to confirm something you already know, to check your plan, to ask about tone or formatting, or to ask for anything a web search would answer.",
  "It blocks the run while the user answers and they may skip, in which case you must proceed on your best assumption and state it.",
  `At most ${MAX_ASKS_PER_RUN} calls per run; ask for everything you need in one call.`,
].join(" ");

const requestShape = {
  requests: z
    .array(
      z.object({
        question: z
          .string()
          .min(1)
          .max(200)
          .describe("One short sentence, in the user's own words, naming exactly what you need."),
        kind: z
          .enum(["choice", "text"])
          .describe(
            "'text' for a value you need typed (a URL, a name, a number). 'choice' when you can offer the two to five realistic answers.",
          ),
        options: z
          .array(z.string().min(1).max(80))
          .max(MAX_CLARIFICATION_OPTIONS)
          .optional()
          .describe("Choice requests only: the answers on offer, phrased as the user would say them."),
        multiple: z
          .boolean()
          .optional()
          .describe("Choice requests only: true when several options can apply at once."),
        hint: inputValueHintSchema
          .optional()
          .describe("Text requests only: the shape of the value, so it can be validated ('url', 'number', 'text')."),
        placeholder: z
          .string()
          .max(120)
          .optional()
          .describe("Text requests only: an example of the value, shown in the field."),
      }),
    )
    .min(1)
    .max(MAX_CLARIFICATION_QUESTIONS)
    .describe("Everything you need, in one call. Keep it to the minimum."),
};

type RawRequest = {
  question: string;
  kind: "choice" | "text";
  options?: string[];
  multiple?: boolean;
  hint?: "text" | "url" | "number";
  placeholder?: string;
};

/**
 * Turns what the model asked for into something the card can render: a choice
 * with fewer than two real options is not a choice, so it becomes an open field
 * rather than a button the user has no alternative to.
 */
export function normaliseRequests(raw: RawRequest[]): PendingInput[] {
  const requests: PendingInput[] = [];
  for (const entry of raw) {
    const question = entry.question.trim();
    if (!question) continue;

    const options = [
      ...new Set((entry.options ?? []).map((o) => o.trim()).filter(Boolean)),
    ].slice(0, MAX_CLARIFICATION_OPTIONS);

    if (entry.kind === "choice" && options.length >= 2) {
      requests.push({
        id: randomUUID(),
        kind: "choice",
        question,
        type: entry.multiple ? "check" : "radio",
        options,
      });
    } else {
      requests.push({
        id: randomUUID(),
        kind: "text",
        question,
        hint: entry.hint ?? "text",
        placeholder: entry.placeholder?.trim() ?? "",
      });
    }
    if (requests.length === MAX_CLARIFICATION_QUESTIONS) break;
  }
  return requests;
}

function describeAnswers(requests: PendingInput[], answers: ClarificationAnswer[]): string {
  const byId = new Map(answers.map((a) => [a.questionId, a]));
  const given: string[] = [];
  const refused: string[] = [];

  for (const request of requests) {
    const answer = byId.get(request.id);
    if (!answer || !hasClarificationAnswer(answer)) {
      refused.push(request.question);
      continue;
    }
    const parts = [...answer.selected];
    if (answer.text) parts.push(answer.text);
    given.push(`- ${request.question}\n  ${parts.join("; ")}`);
  }

  if (given.length === 0) {
    return "The user chose not to answer. Do not ask again: carry on with the most reasonable assumption and state plainly in your summary what you assumed.";
  }
  const lines = ["The user answered:", given.join("\n")];
  if (refused.length > 0) {
    lines.push(
      `They left these unanswered, so decide them yourself and say what you assumed: ${refused.join("; ")}`,
    );
  }
  return lines.join("\n\n");
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export interface AskUserSetup {
  server: McpServerConfig;
  /** Fully qualified tool name, for the allow-list. */
  toolName: string;
  /** The carve-out from "never ask the user questions", spelled out for the model. */
  promptLine: string;
}

/**
 * Builds the tool for one run. The ask counter lives in this closure, so it is
 * per run rather than per process.
 */
export function buildAskUserSetup(runId: string): AskUserSetup {
  let asks = 0;

  const askUser = tool(
    ASK_USER_TOOL,
    DESCRIPTION,
    requestShape,
    async ({ requests: raw }) => {
      if (asks >= MAX_ASKS_PER_RUN) {
        return textResult(
          "You have already interrupted the user as often as this run allows. Proceed on your best assumption and state it in your summary.",
        );
      }

      const requests = normaliseRequests(raw);
      if (requests.length === 0) {
        return textResult("No answerable request was given, so nothing was asked. Carry on.");
      }

      // Guarded on `running`: a run that has finished or failed in the meantime
      // must not be dragged back into waiting.
      if (!(await pauseRunForMidRunInput(runId, requests))) {
        return textResult(
          "This run cannot pause for input right now. Continue on your best assumption and state it in your summary.",
        );
      }
      asks += 1;
      // One event per round, never overwritten, so the run reads as a
      // conversation: asked, answered, more work, asked again.
      await appendRunEvent(runId, "clarification_asked", {
        reason: "The agent needs something from you to carry on.",
        questions: requests.map((request) => request.question),
      });

      try {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          // A stop pressed while the run is parked here: nobody is coming to
          // answer, so the wait ends at once rather than holding the run open
          // until the runner's own abort reaches it.
          const cancellation = await getRunCancellation(runId);
          if (cancellation?.cancelRequestedAt) {
            return textResult(
              "The user stopped this run while you were waiting. Do no further work and reply with what you have.",
            );
          }
          const clarification = await getRunClarification(runId);
          if (!clarification) break;
          if (isAwaitingInput(clarification.state)) continue;
          return textResult(describeAnswers(requests, clarification.answers));
        }
        return textResult(
          "The user did not answer in time. Do not ask again: continue with the most reasonable assumption and state plainly in your summary what you assumed.",
        );
      } finally {
        // Whatever happened — answered, skipped, timed out, or thrown — the run
        // goes back to `running` so it can never be stranded in `awaiting_input`.
        await resumeRunAfterMidRunInput(runId);
      }
    },
  );

  return {
    server: createSdkMcpServer({ name: ASK_USER_SERVER_KEY, version: "1.0.0", tools: [askUser] }),
    toolName: ASK_USER_TOOL_NAME,
    promptLine: [
      `One exception to never asking the user anything: the ${ASK_USER_TOOL_NAME} tool.`,
      "Call it only when a value you need is genuinely unobtainable by you — a private or internal URL, a file only the user has, a credential-gated resource, or a preference with no defensible default.",
      "Search, read and infer first; if a reasonable assumption would do, make it and state it in your summary rather than interrupting.",
      "Ask for everything you need in a single call, and never ask twice for the same thing.",
    ].join(" "),
  };
}
