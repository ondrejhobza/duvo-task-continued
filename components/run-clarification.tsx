"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Loader2,
  MessageCircleQuestionMark,
} from "lucide-react";
import { toast } from "sonner";
import { ComposerField } from "@/components/composer-field";
import { DictateButton } from "@/components/dictate-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { appendTranscript, useDictation } from "@/lib/use-dictation";
import {
  ANSWER_TEXT_MAX,
  inputValueError,
  type ClarificationAnswer,
  type InputValueHint,
  type RunClarification,
} from "@/lib/schema";

/**
 * The question card of a run parked in `awaiting_input`: one question at a
 * time, a free-text escape hatch on every one of them, and two ways out that
 * always work — skip a question, or run without answering at all.
 */

/** Long enough to see the choice register, short enough not to feel like a wait. */
const AUTO_ADVANCE_MS = 480;

interface AnswerDraft {
  selected: string[];
  text: string;
  skipped: boolean;
}

const EMPTY_DRAFT: AnswerDraft = { selected: [], text: "", skipped: false };

/** What the field is for, said in the user's terms rather than the schema's. */
const HINT_LABEL: Record<InputValueHint, string> = {
  text: "Your answer",
  url: "Link",
  number: "Number",
};

const HINT_PLACEHOLDER: Record<InputValueHint, string> = {
  text: "Answer in your own words",
  url: "https://…",
  number: "e.g. 25",
};

function hasContent(draft: AnswerDraft): boolean {
  return draft.selected.length > 0 || draft.text.trim().length > 0;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function usePrefersReducedMotion(): boolean {
  // Read as an external store rather than mirrored into state by an effect:
  // the server snapshot is false so the first client render agrees, and the
  // real value is available on that same render instead of one paint later.
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

export function RunClarification({
  runId,
  clarification,
  onResumed,
}: {
  runId: string;
  clarification: RunClarification;
  onResumed?: () => void;
}) {
  const questions = clarification.questions;
  // The run stopped partway through rather than before starting: the work so far
  // is on screen above, so the card asks rather than introduces.
  const midRun = clarification.state === "awaiting_mid_run";
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  // Mirrored in an effect, not during render: the only reader is an event
  // handler, which always runs after the effect for the current drafts.
  const draftsRef = useRef(drafts);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  // One submission per card, whatever the user clicks: a second Continue while
  // the first is in flight must not reach the server.
  const submittingRef = useRef(false);
  const advanceTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (advanceTimer.current !== null) window.clearTimeout(advanceTimer.current);
    };
  }, []);

  const pending = questions.length === 0 ? null : questions[Math.min(index, questions.length - 1)];

  // Dictation lands on whichever question is on screen when it is spoken, so
  // the callback reads the id at that moment rather than closing over it.
  const activeQuestionIdRef = useRef<string>("");
  useEffect(() => {
    activeQuestionIdRef.current = pending?.id ?? "";
  }, [pending?.id]);

  const handleTranscript = useCallback((spoken: string) => {
    const id = activeQuestionIdRef.current;
    if (!id) return;
    setDrafts((current) => {
      const existing = current[id] ?? EMPTY_DRAFT;
      return {
        ...current,
        [id]: {
          ...existing,
          text: appendTranscript(existing.text, spoken).slice(0, ANSWER_TEXT_MAX),
          skipped: false,
        },
      };
    });
  }, []);

  const handleDictationError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const dictation = useDictation({
    onTranscript: handleTranscript,
    onError: handleDictationError,
  });

  if (!pending) return null;

  // Narrowed once, so the handlers below can close over it.
  const question = pending;
  const draft = drafts[question.id] ?? EMPTY_DRAFT;
  const isLast = index === questions.length - 1;
  const answered = hasContent(draft);
  // Same rule the route enforces, run on every keystroke so the user hears about
  // a malformed URL here rather than as a 400 after pressing Send.
  const valueError =
    answered && question.kind === "text" ? inputValueError(question, draft.text.trim()) : null;
  const canContinue = answered && valueError === null;

  function cancelAdvance() {
    if (advanceTimer.current !== null) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }

  function patchDraft(questionId: string, patch: Partial<AnswerDraft>) {
    setDrafts((current) => ({
      ...current,
      [questionId]: { ...(current[questionId] ?? EMPTY_DRAFT), ...patch },
    }));
  }

  function collectAnswers(): ClarificationAnswer[] {
    return questions.map((q) => {
      const value = draftsRef.current[q.id] ?? EMPTY_DRAFT;
      const text = value.text.trim();
      return {
        questionId: q.id,
        selected: value.selected,
        text,
        skipped: value.skipped && value.selected.length === 0 && text.length === 0,
      };
    });
  }

  async function submit(proceedWithout: boolean) {
    cancelAdvance();
    if (submittingRef.current) return;
    submittingRef.current = true;
    dictation.stop();
    setSaving(true);
    try {
      const response = await fetch(`/api/runs/${runId}/clarify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: collectAnswers(), proceedWithout }),
      });
      if (response.status === 409) {
        // A second tab, a second click that got through, a run stopped while
        // the card was open, or a question that has since been replaced.
        const body: unknown = await response.json().catch(() => null);
        const conflict = (body ?? {}) as { status?: unknown; questionsChanged?: unknown };

        if (conflict.questionsChanged === true) {
          // The slow-typing case: this answer belongs to a question the agent
          // has already given up on. Nothing was recorded, and the next poll
          // brings the question it is actually waiting on.
          submittingRef.current = false;
          setSaving(false);
          toast.info("The agent moved on. Your answer was not sent — it is asking something else now.");
          onResumed?.();
          return;
        }

        setSent(true);
        toast.info(
          conflict.status === "cancelled"
            ? "You stopped this run, so it never needed your answer."
            : "This run already carried on without these answers.",
        );
        onResumed?.();
        return;
      }
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setSent(true);
      onResumed?.();
    } catch {
      // Recoverable: let the user try again rather than trapping the run.
      submittingRef.current = false;
      setSaving(false);
      toast.error("Could not send your answers. Try again.");
    }
  }

  function advance() {
    cancelAdvance();
    if (isLast) {
      void submit(false);
      return;
    }
    setIndex((current) => Math.min(current + 1, questions.length - 1));
  }

  /**
   * Enter in the field, and the button inside it. Empty or whitespace-only
   * never gets through: `canContinue` is the same trimmed check the footer and
   * the route both apply.
   */
  function sendAnswer() {
    if (!canContinue || saving) return;
    advance();
  }

  function chooseSingle(option: string) {
    patchDraft(question.id, { selected: [option], skipped: false });
    // A single choice needs no confirmation; the short beat is so the user sees
    // which option took.
    cancelAdvance();
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      advance();
    }, reducedMotion ? 0 : AUTO_ADVANCE_MS);
  }

  function toggleOption(option: string, checked: boolean) {
    const next = checked
      ? [...draft.selected, option]
      : draft.selected.filter((value) => value !== option);
    patchDraft(question.id, { selected: next, skipped: false });
  }

  function skip() {
    patchDraft(question.id, { selected: [], text: "", skipped: true });
    cancelAdvance();
    if (isLast) {
      void submit(false);
      return;
    }
    setIndex((current) => current + 1);
  }

  if (sent) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Badge variant="default">
              <CheckCircle2 />
              Answers sent
            </Badge>
          </CardTitle>
          <CardDescription>
            {midRun
              ? "The agent is carrying on from where it stopped with what you told it."
              : "The agent is picking the work back up with what you told it. The steps below carry on as soon as it starts."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <MessageCircleQuestionMark className="size-4 text-muted-foreground" />
          {midRun ? "The agent needs something from you" : "Before it starts"}
        </CardTitle>
        <CardDescription>
          {midRun
            ? "It got this far and then hit something only you can supply. Give it the value, or tell it to carry on without."
            : questions.length === 1
              ? "One answer would change what the agent produces. Skip it and it will decide for itself."
              : `${questions.length} answers would change what the agent produces. Skip any of them and it will decide for itself.`}
        </CardDescription>
      </CardHeader>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          sendAnswer();
        }}
      >
        <CardContent>
          {/* The whole question region is live, so a screen reader hears the new
              question and its position when the card moves on. */}
          <div
            aria-live="polite"
            className="flex flex-col gap-4 rounded-lg border bg-muted/40 p-4"
          >
            <div
              key={question.id}
              className="flex flex-col gap-4 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2 motion-safe:duration-200"
            >
              <div className="flex items-start justify-between gap-3">
                <p
                  id={`clarify-question-${question.id}`}
                  className="text-sm leading-relaxed font-medium break-words"
                >
                  {question.question}
                </p>
                <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                  {index + 1} / {questions.length}
                </span>
              </div>

              {question.kind === "text" ? null : question.type === "radio" ? (
                <RadioGroup
                  aria-labelledby={`clarify-question-${question.id}`}
                  value={draft.selected[0] ?? ""}
                  onValueChange={(value) => {
                    if (typeof value === "string") chooseSingle(value);
                  }}
                  disabled={saving}
                >
                  {question.options.map((option) => (
                    <Label
                      key={option}
                      className="items-start gap-2.5 rounded-lg border bg-card p-2.5 text-sm font-normal hover:bg-muted"
                    >
                      <RadioGroupItem value={option} className="mt-0.5" />
                      <span className="break-words">{option}</span>
                    </Label>
                  ))}
                </RadioGroup>
              ) : (
                <div role="group" aria-labelledby={`clarify-question-${question.id}`} className="grid gap-2">
                  {question.options.map((option) => (
                    <Label
                      key={option}
                      className="items-start gap-2.5 rounded-lg border bg-card p-2.5 text-sm font-normal hover:bg-muted"
                    >
                      <Checkbox
                        checked={draft.selected.includes(option)}
                        onCheckedChange={(checked) => toggleOption(option, checked === true)}
                        disabled={saving}
                        className="mt-0.5"
                      />
                      <span className="break-words">{option}</span>
                    </Label>
                  ))}
                </div>
              )}

              {/* The same gesture as starting a run, minus the two controls
                  that would be lies mid-run: the model and the MCP servers
                  were both settled when this run began. Beside a list of
                  options it is the escape hatch; on its own it is the answer. */}
              <div className="flex flex-col gap-1.5">
                <Label
                  htmlFor={`clarify-text-${question.id}`}
                  className="text-xs text-muted-foreground"
                >
                  {question.kind === "text" ? HINT_LABEL[question.hint] : "Something else…"}
                </Label>
                <ComposerField
                  id={`clarify-text-${question.id}`}
                  value={draft.text}
                  onValueChange={(next) => {
                    cancelAdvance();
                    patchDraft(question.id, { text: next, skipped: false });
                  }}
                  onSubmitShortcut={sendAnswer}
                  placeholder={
                    question.kind === "text"
                      ? question.placeholder || HINT_PLACEHOLDER[question.hint]
                      : "Answer in your own words"
                  }
                  maxLength={ANSWER_TEXT_MAX}
                  disabled={saving}
                  // The card only mounts once the run is actually waiting, so
                  // the caret lands where the user has to type — unless they
                  // are already typing somewhere else, which the field checks.
                  autoFocus
                  invalid={valueError !== null}
                  describedBy={valueError ? `clarify-error-${question.id}` : undefined}
                  interim={dictation.interim}
                  controls={
                    <DictateButton
                      dictation={dictation}
                      disabled={saving}
                      label="Dictate your answer"
                    />
                  }
                  submit={
                    <Button type="submit" size="sm" disabled={!canContinue || saving}>
                      {saving ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                      {saving ? "Sending…" : isLast ? "Send" : "Continue"}
                    </Button>
                  }
                />
                {valueError && (
                  <p id={`clarify-error-${question.id}`} className="text-xs text-destructive">
                    {valueError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex-wrap justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous question"
              disabled={index === 0 || saving}
              onClick={() => {
                cancelAdvance();
                setIndex((current) => Math.max(0, current - 1));
              }}
            >
              <ArrowLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next question"
              disabled={isLast || saving}
              onClick={() => {
                cancelAdvance();
                setIndex((current) => Math.min(questions.length - 1, current + 1));
              }}
            >
              <ArrowRight />
            </Button>
            {/* The way out: a run must never be stuck waiting on an answer. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              disabled={saving}
              onClick={() => void submit(true)}
            >
              {midRun ? "Carry on without it" : "Run without answering"}
            </Button>
          </div>

          {/* Sending lives inside the field, where the answer is typed; the
              footer keeps only the ways past a question. */}
          <Button type="button" variant="ghost" size="sm" onClick={skip} disabled={saving}>
            Skip
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
