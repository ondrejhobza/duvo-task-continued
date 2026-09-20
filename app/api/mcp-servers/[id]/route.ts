import { NextResponse } from "next/server";
import { deleteMcpServer, updateMcpServer } from "@/lib/repo";
import { updateMcpServerSchema } from "@/lib/schema";

export async function PATCH(
  request: Request,
  ctx: RouteContext<"/api/mcp-servers/[id]">,
): Promise<NextResponse> {
  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = updateMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const server = await updateMcpServer(id, parsed.data);
  if (!server) {
    return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  }
  return NextResponse.json({ server });
}

export async function DELETE(
  _request: Request,
  ctx: RouteContext<"/api/mcp-servers/[id]">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const deleted = await deleteMcpServer(id);
  if (!deleted) {
    return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
  }
  return new NextResponse(null, { status: 204 });
}
