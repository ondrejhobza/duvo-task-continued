import { NextResponse } from "next/server";
import { createMcpServer, getMcpServerByKey, listMcpServers } from "@/lib/repo";
import { createMcpServerSchema } from "@/lib/schema";

export async function GET(): Promise<NextResponse> {
  const servers = await listMcpServers();
  return NextResponse.json({ servers });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = createMcpServerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const input = parsed.data;

  if (await getMcpServerByKey(input.key)) {
    return NextResponse.json(
      { error: `An MCP server with key "${input.key}" is already connected.` },
      { status: 409 },
    );
  }

  const server = await createMcpServer(input);
  return NextResponse.json({ server }, { status: 201 });
}
