"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * The shape shared by everything the user types at the agent: the main prompt
 * composer and the field that answers it mid-run. One card-coloured surface, a
 * textarea that grows with the text, and a control row whose left half each
 * caller fills for itself — the composer with its model and MCP controls, the
 * answer field with nothing but a microphone, because the model and the
 * servers were settled when the run started.
 *
 * Shared rather than copied so the two can never drift apart; slotted rather
 * than configured so neither has to grow a flag for the other's controls.
 */
export function ComposerField({
  id,
  value,
  onValueChange,
  onSubmitShortcut,
  placeholder,
  maxLength,
  disabled = false,
  required = false,
  autoFocus = false,
  invalid = false,
  describedBy,
  /** Live speech, shown under the text while dictation is running. */
  interim,
  controls,
  status,
  submit,
  className,
}: {
  id: string;
  value: string;
  onValueChange: (next: string) => void;
  /** Enter without Shift. Newlines stay on Shift+Enter, as everywhere else. */
  onSubmitShortcut: () => void;
  placeholder: string;
  maxLength: number;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** The value fails the caller's own check; the message sits below the field. */
  invalid?: boolean;
  describedBy?: string;
  interim?: string | null;
  controls?: ReactNode;
  status?: ReactNode;
  submit: ReactNode;
  className?: string;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    // The field can appear while the user is mid-sentence somewhere else — the
    // prompt composer above, most obviously. Taking the caret off them is
    // worse than making them click, so only an idle caret is claimed.
    const active = document.activeElement;
    const typingElsewhere =
      active instanceof HTMLElement &&
      active !== fieldRef.current &&
      (active.isContentEditable ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLInputElement);
    if (typingElsewhere) return;
    fieldRef.current?.focus();
  }, [autoFocus]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmitShortcut();
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-2 transition-colors focus-within:border-ring",
        className,
      )}
    >
      <Textarea
        id={id}
        ref={fieldRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        required={required}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        className="max-h-56 min-h-16 resize-none overflow-y-auto border-0 bg-transparent px-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      {interim && <p className="px-1.5 text-sm text-muted-foreground italic">{interim}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {controls}
        <div className="ml-auto flex items-center gap-2">
          {status}
          {/* Only once it matters: a counter on an empty box is noise. */}
          {value.length > maxLength * 0.8 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {value.length} / {maxLength}
            </span>
          )}
          {submit}
        </div>
      </div>
    </div>
  );
}
