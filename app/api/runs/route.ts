import { after, NextResponse } from "next/server";
import { runAgent } from "@/lib/agent";
import { createRun, listEnabledMcpServerConfigs, listRunsPage } from "@/lib/repo";
import { createRunSchema, listRunsQuerySchema, runCursorSchema } from "@/lib/schema";

/** One page of history, newest first. `cursorCreatedAt`/`cursorId` page backwards. */
export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const parsed = listRunsQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    cursorCreatedAt: params.get("cursorCreatedAt") ?? undefined,
    cursorId: params.get("cursorId") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Both halves of the keyset or neither; half a cursor would silently page
  // from the top again.
  const cursor = runCursorSchema.safeParse({
    createdAt: parsed.data.cursorCreatedAt,
    id: parsed.data.cursorId,
  });
  const page = await listRunsPage(parsed.data.limit, cursor.success ? cursor.data : null);
  return NextResponse.json(page);
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = createRunSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Snapshot which MCP servers are switched on so the run is reproducible.
  const enabledServers = (await listEnabledMcpServerConfigs()).map((s) => s.name);
  const run = await createRun(
    parsed.data.prompt,
    enabledServers,
    parsed.data.model,
    parsed.data.reasoning,
  );
  after(() => runAgent(run.id));

  return NextResponse.json({ run }, { status: 201 });
}
