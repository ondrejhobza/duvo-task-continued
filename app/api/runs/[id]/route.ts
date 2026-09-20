import { NextResponse } from "next/server";
import { getRun } from "@/lib/repo";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[id]">,
): Promise<NextResponse> {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json({ run });
}
