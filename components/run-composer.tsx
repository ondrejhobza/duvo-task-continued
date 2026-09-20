"use client";

import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Brain, ChevronDown, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { ComposerField } from "@/components/composer-field";
import { DictateButton } from "@/components/dictate-button";
import { McpDirectoryDialog } from "@/components/mcp-controls";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { appendTranscript, useDictation } from "@/lib/use-dictation";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import {
  AGENT_MODELS,
  agentModelName,
  AUTO_MODEL_OPTION,
  DEFAULT_AGENT_MODEL_ID,
  isAutoSelection,
  modelSelectionSchema,
  modelSupportsReasoning,
  resolveModelSelection,
  runSchema,
  type McpServer,
  type ModelSelection,
} from "@/lib/schema";

const PROMPT_MAX = 4000;
const MODEL_STORAGE_KEY = "duvo.composer.model";
const REASONING_STORAGE_KEY = "duvo.composer.reasoning";

async function readError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const issues =
        "issues" in body && Array.isArray(body.issues)
          ? body.issues
              .map((i: { message?: string }) => i.message)
              .filter(Boolean)
              .join(" ")
          : "";
      return issues || String(body.error);
    }
  } catch {
    // fall through
  }
  return `Request failed (${response.status})`;
}

/**
 * A value remembered from a previous visit. Read through an external store so
 * the server render (and therefore hydration) sees no stored value at all.
 */
function useStoredValue(key: string): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      return () => window.removeEventListener("storage", onChange);
    },
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        // Blocked storage throws on read, not just on write. This runs during
        // render, so letting it escape would take the whole composer down.
        return null;
      }
    },
    () => null,
  );
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the choice just will not survive a reload.
  }
}

export function RunComposer({
  mcpServers,
  busyReason = null,
}: {
  mcpServers: McpServer[];
  /** Set while another run has the floor; the composer says so rather than queueing. */
  busyReason?: string | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // A pick made in this session wins; otherwise fall back to the remembered
  // one. A stored value naming a model that no longer exists is migrated to
  // the default rather than left to fail at the API boundary.
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const storedModel = useStoredValue(MODEL_STORAGE_KEY);
  const model =
    picked ?? (storedModel === null ? DEFAULT_AGENT_MODEL_ID : resolveModelSelection(storedModel));

  const [reasoningPicked, setReasoningPicked] = useState<boolean | null>(null);
  const storedReasoning = useStoredValue(REASONING_STORAGE_KEY);
  const reasoningWanted = reasoningPicked ?? storedReasoning === "true";

  // Auto decides thinking for itself as part of choosing a model, and a model
  // without extended thinking has nothing to switch on. In both cases the
  // control is shown disabled with the reason rather than silently ignored.
  const reasoningAvailable = modelSupportsReasoning(model);
  const reasoning = reasoningAvailable && reasoningWanted;
  const reasoningNote = isAutoSelection(model) ? "decided by Auto" : "not on this model";
  const reasoningHint = isAutoSelection(model)
    ? "Auto decides for itself whether the task is worth extended thinking."
    : `${agentModelName(model)} does not support extended thinking.`;

  function chooseModel(next: ModelSelection) {
    setPicked(next);
    writeStored(MODEL_STORAGE_KEY, next);
  }

  function chooseReasoning(next: boolean) {
    setReasoningPicked(next);
    writeStored(REASONING_STORAGE_KEY, String(next));
  }

  const handleTranscript = useCallback((spoken: string) => {
    setPrompt((current) => appendTranscript(current, spoken).slice(0, PROMPT_MAX));
  }, []);

  const handleDictationError = useCallback((message: string) => {
    toast.error(message);
  }, []);

  const dictation = useDictation({
    onTranscript: handleTranscript,
    onError: handleDictationError,
  });

  const empty = prompt.trim().length === 0;
  const busy = busyReason !== null;
  const canSubmit = !submitting && !empty && !busy;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    dictation.stop();
    setSubmitting(true);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, model, reasoning }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const body: unknown = await response.json();
      const parsed = runSchema.safeParse((body as { run?: unknown }).run);
      if (!parsed.success) throw new Error("Unexpected response from server");
      setPrompt("");
      // Stay put: the live panel directly below picks the new run up from the
      // server, which is also where it asks for any clarification it needs. A
      // run already in flight is not disturbed; it carries on in the list.
      router.refresh();
      setSubmitting(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start the run");
      setSubmitting(false);
    }
  }

  const selectedName = agentModelName(model);

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
      <Label htmlFor="prompt" className="sr-only">
        Instructions for the agent
      </Label>

      <ComposerField
        id="prompt"
        value={prompt}
        onValueChange={setPrompt}
        onSubmitShortcut={() => formRef.current?.requestSubmit()}
        placeholder="e.g. Fetch the latest AI news from the web and save it into a CSV."
        maxLength={PROMPT_MAX}
        disabled={submitting}
        required
        interim={dictation.interim}
        status={busyReason && <span className="text-xs text-muted-foreground">{busyReason}</span>}
        submit={
          <Button
            type="submit"
            size="icon"
            disabled={!canSubmit}
            aria-label={submitting ? "Starting the run" : "Start the run"}
          >
            {submitting ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        }
        controls={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="outline" size="sm" disabled={submitting} />
                }
                aria-label={`Model: ${selectedName}. Change model`}
              >
                <Sparkles />
                {selectedName}
                <ChevronDown data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-64">
                <DropdownMenuRadioGroup
                  value={model}
                  onValueChange={(next) => {
                    const parsed = modelSelectionSchema.safeParse(next);
                    if (parsed.success) chooseModel(parsed.data);
                  }}
                >
                  {/* The label is a group part: it names the radio group it sits
                      in, and Base UI throws if it is rendered outside one. */}
                  <DropdownMenuLabel>Model for this run</DropdownMenuLabel>
                  <DropdownMenuRadioItem value={AUTO_MODEL_OPTION.id} className="gap-2">
                    <span className="flex flex-1 flex-col">
                      <span>{AUTO_MODEL_OPTION.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {AUTO_MODEL_OPTION.hint}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground">{AUTO_MODEL_OPTION.tag}</span>
                  </DropdownMenuRadioItem>
                  {AGENT_MODELS.map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id} className="gap-2">
                      <span className="flex-1">{option.name}</span>
                      <span className="text-xs text-muted-foreground">{option.tag}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

            <ReasoningToggle
              checked={reasoning}
              available={reasoningAvailable}
              note={reasoningNote}
              hint={reasoningHint}
              disabled={submitting}
              onCheckedChange={chooseReasoning}
            />

            <DictateButton dictation={dictation} disabled={submitting} />

            <McpDirectoryDialog servers={mcpServers} disabled={submitting} />
          </>
        }
      />

      <p className="sr-only" aria-live="polite">
        {dictation.listening ? "Listening. Speak your instructions." : "Dictation off."}
      </p>

    </form>
  );
}

/**
 * Extended thinking. When the chosen model has none — or Auto is deciding for
 * itself — the switch is shown off and disabled with the reason, so the
 * control never looks like it did something it did not.
 */
function ReasoningToggle({
  checked,
  available,
  note,
  hint,
  disabled,
  onCheckedChange,
}: {
  checked: boolean;
  available: boolean;
  /** Two or three words shown in place of nothing when the switch is off-limits. */
  note: string;
  hint: string;
  disabled: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  // Deliberately one stable subtree whatever the model is: switching between a
  // tooltip-wrapped and a plain version would remount a live control every
  // time the picker changed. The reason is carried by the visible note and the
  // native title, which a disabled control still shows.
  return (
    <span
      className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm"
      title={available ? "Slower and dearer, for tasks that need deliberation." : hint}
    >
      <Brain className="size-4 text-muted-foreground" />
      <Label
        htmlFor="reasoning"
        className={cn("font-normal", available ? "cursor-pointer" : "text-muted-foreground")}
      >
        Reasoning
      </Label>
      {!available && <span className="text-xs text-muted-foreground">{note}</span>}
      <Switch
        id="reasoning"
        size="sm"
        checked={checked}
        disabled={disabled || !available}
        onCheckedChange={onCheckedChange}
      />
    </span>
  );
}

