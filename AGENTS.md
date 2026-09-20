# Project conventions

Optimise for a working vertical slice, then polish. Do not add libraries without being asked.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict. Route handlers in `app/api/**/route.ts`; `params` is a Promise (`await ctx.params`); use the global `RouteContext<'/api/x/[id]'>` type.
- Tailwind 4 + shadcn/ui (`components/ui`). Add components with `npx shadcn@latest add <name>`; do not hand-roll buttons/dialogs/tables.
- Zod 4 for every boundary (`lib/schema.ts`). Infer types with `z.infer`. Use `safeParse` in routes and return 400 with `issues` on failure.
- Kysely for SQL (`lib/db.ts` types + `ensureSchema`, `lib/repo.ts` queries). PGlite locally, Postgres via `DATABASE_URL`. Keep SQL out of routes and components. Primary keys are app-generated UUID strings. Numeric columns come back as strings: normalise with `Number()` in the repo.
- Vercel AI SDK 7: use `generateText` with `output: Output.object({ schema })` via `lib/llm.ts#extractStructured`. `generateObject` is deprecated. Never `JSON.parse` raw model text. Always handle the `{ ok: false }` branch in the UI (manual review path).



## Code style

- Server components by default; `"use client"` only for interactivity. Fetch data in `app/**/page.tsx` via `lib/repo.ts`, pass to client components as props.
- Mutations go through route handlers with Zod validation. Guard state transitions in SQL (`where status = 'pending'`) and return 409 when the guard fails.
- Every list needs an empty state. Every action needs a disabled/saving state and an error toast (sonner) with rollback of optimistic updates.
- Irreversible actions (send, pay, post, delete) require explicit confirmation; declines/rejections require a reason.
- Put a summary number the user cares about at the top of each page.
- Prefer small, named functions and explicit types at module boundaries. No `any`.
- Commit after each working step with an intent-revealing message.



## UI harness

- Palette: the neutral shadcn oklch theme in `app/globals.css` (`--radius: 0.625rem`), dark mode via `.dark`. Style with theme tokens only (`bg-card`, `bg-muted`, `text-muted-foreground`, `border`, `primary`, `secondary`, `destructive`); no raw Tailwind colours like `bg-amber-50`. Severity comes from `Badge`/`Button` variants, not colour classes.
- Fonts: `Geist` on `--font-sans` (also `--font-heading`), `Geist_Mono` on `--font-geist-mono` for identifiers (`font-mono text-xs`). Numbers use `tabular-nums`; format money/dates via `lib/format.ts`.
- Components: shadcn/ui or baseui only (`Button`, `Badge`, `Card`, `Dialog`, `Table`, `Select`, `Input`, `Textarea`, `Label`, `Tabs`, `Sonner`). Add with `npx shadcn@latest add`; do not restyle them or hand-roll equivalents.
- Icons: `lucide-react`, sized by the component (`size-4`), placed before the label.
- Surfaces: `rounded-xl border bg-card` panels, `rounded-lg border bg-muted/40` for nested panels. Content width `max-w-7xl`, spacing in `gap-4`–`gap-6`, `p-4 sm:p-6`.



## When asked to build a feature

1. Restate: user, outcome, core flow, out of scope.
2. Edit `lib/schema.ts` first, then `lib/db.ts`, `lib/repo.ts`, route, UI.
3. Run `npm run check` before declaring done. Test the unhappy path (bad input, empty list, double submit).



## How to work

- Do not write output files the user did not ask for. Report findings in your response, not as markdown summary, plan, or report files in the repo.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
