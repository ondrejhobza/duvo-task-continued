"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownRight, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { ComposerField } from "@/components/composer-field";
import { DictateButton } from "@/components/dictate-button";
import { Button } from "@/components/ui/button";
import { appendTranscript, useDictation } from "@/lib/use-dictation";
import { canFollowUp, FOLLOW_UP_MAX, type Run } from "@/lib/schema";

/**
 * Carries a finished run on with another instruction, in the place the user is
 * already looking at that run.
 *
 * Deliberately not the composer at the top of the page: that one starts a fresh
 * agent that knows nothing, this one adds a turn to the run on screen. The two
 * are the same gesture and share the same field, so the difference is carried
 * by where it sits, what it is called, and a line that says in plain words how
 * much of the conversation the next turn will actually have.
 */
export function RunFollowUp({
  run,
  /** Why the run cannot be continued right now; the composer's own rule. */
  busyReason = null,
}: {
  run: Run;
  busyReason?: string | null;
}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);

  const handleTranscript = useCallback((spoken: string) => {
    setPrompt((current) => appendTranscript(current, spoken).slice(0, FOLLOW_UP_MAX));
  }, []);

  const handleDictationError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const dictation = useDictation({
    onTranscript: handleTranscript,
    onError: handleDictationError,
  });

  if (!canFollowUp(run)) return null;

  const text = prompt.trim();
  const blocked = busyReason !== null;
  const canSend = text.length > 0 && !sending && !blocked;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    dictation.stop();
    try {
      const response = await fetch(`/api/runs/${run.id}/follow-up`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const body: unknown = await response.json().catch(() => null);
      const payload = (body ?? {}) as { error?: unknown; continuation?: unknown };

      if (response.status === 409) {
        // Something else is running, or this run turned out not to be finished
        // after all. Neither is an error the user caused; the text stays.
        toast.info(
          typeof payload.error === "string"
            ? payload.error
            : "That run cannot be continued right now.",
        );
        return;
      }
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`,
        );
      }

      setPrompt("");
      // The distinction is worth a sentence: one of these agents remembers the
      // work, the other has only been told about it.
      toast.success(
        payload.continuation === "resumed"
          ? "Picking up where it left off, in the same session."
          : "Started in a new session: the agent was given a summary of the conversation so far, not its memory of it.",
      );
      // The run has gone back to work, so the panel around this box needs to
      // start watching it again and the new turn needs to appear in the thread.
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the follow-up.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <CornerDownRight className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Carry on from here</h3>
      </div>
      <p className="text-sm text-muted-foreground">
        {blocked
          ? busyReason
          : run.resumable
            ? "Adds a turn to this run, in the same session: the agent still has the work above in mind, and it all stays on this one record. The box at the top of the page starts a fresh agent instead."
            : "This run's session is no longer open, so the agent will be given a written summary of the conversation rather than remembering it. Repeat anything it needs to know."}
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <ComposerField
          id={`follow-up-${run.id}`}
          value={prompt}
          onValueChange={setPrompt}
          onSubmitShortcut={() => void submit()}
          placeholder={
            run.status === "succeeded"
              ? "What next? For example: turn that into a CSV."
              : "What should it try instead?"
          }
          maxLength={FOLLOW_UP_MAX}
          disabled={sending || blocked}
          controls={
            <DictateButton
              dictation={dictation}
              disabled={sending || blocked}
              label="Dictate a follow-up"
            />
          }
          interim={dictation.interim}
          submit={
            <Button type="submit" size="sm" disabled={!canSend}>
              {sending ? <Loader2 className="animate-spin" /> : <Send />}
              {sending ? "Starting…" : "Continue"}
            </Button>
          }
        />
      </form>
    </section>
  );
}
