import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { artifactNameSchema } from "@/lib/schema";
import type { ArtifactFileInput } from "@/lib/repo";

const MIME_BY_EXTENSION: Record<string, string> = {
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function mimeTypeFor(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Lists the files the agent left in its workspace. Only top-level regular
 * files with safe names are considered artifacts; hidden files are skipped.
 */
export async function collectArtifacts(workspaceDir: string): Promise<ArtifactFileInput[]> {
  let entries: string[];
  try {
    entries = await readdir(workspaceDir);
  } catch {
    return [];
  }

  const files: ArtifactFileInput[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!artifactNameSchema.safeParse(name).success) continue;
    const info = await stat(path.join(workspaceDir, name));
    if (!info.isFile()) continue;
    files.push({ name, sizeBytes: info.size, mimeType: mimeTypeFor(name) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolves an artifact path inside the workspace, refusing anything that escapes it. */
export function resolveArtifactPath(workspaceDir: string, name: string): string | null {
  if (!artifactNameSchema.safeParse(name).success) return null;
  const root = path.resolve(workspaceDir);
  const full = path.resolve(root, name);
  return full.startsWith(root + path.sep) ? full : null;
}
