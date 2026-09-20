import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { runWorkspaceDir } from "@/lib/agent";
import { resolveArtifactPath } from "@/lib/artifacts";
import { getArtifact } from "@/lib/repo";
import { artifactNameSchema } from "@/lib/schema";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/runs/[id]/artifacts/[name]">,
): Promise<Response> {
  const { id, name: rawName } = await ctx.params;

  const parsedName = artifactNameSchema.safeParse(decodeURIComponent(rawName));
  if (!parsedName.success) {
    return NextResponse.json(
      { error: "Invalid artifact name", issues: parsedName.error.issues },
      { status: 400 },
    );
  }

  // Only files recorded for this run are downloadable.
  const artifact = await getArtifact(id, parsedName.data);
  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
  }

  const filePath = resolveArtifactPath(runWorkspaceDir(id), artifact.name);
  if (!filePath) {
    return NextResponse.json({ error: "Invalid artifact path" }, { status: 400 });
  }

  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return NextResponse.json({ error: "Artifact file is missing" }, { status: 410 });
  }

  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(body, {
    headers: {
      "content-type": artifact.mimeType,
      "content-length": String(size),
      "content-disposition": contentDisposition(artifact.name),
      "cache-control": "no-store",
    },
  });
}

/** RFC 6266: ASCII fallback plus UTF-8 encoded name for browsers that support it. */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
