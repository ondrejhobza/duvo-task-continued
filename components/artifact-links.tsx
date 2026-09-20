import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import type { Artifact } from "@/lib/schema";

export function artifactDownloadUrl(artifact: Artifact): string {
  return `/api/runs/${artifact.runId}/artifacts/${encodeURIComponent(artifact.name)}`;
}

export function ArtifactLinks({
  artifacts,
  emptyLabel,
}: {
  artifacts: Artifact[];
  emptyLabel?: string;
}) {
  if (artifacts.length === 0) {
    return emptyLabel ? (
      <span className="text-sm text-muted-foreground">{emptyLabel}</span>
    ) : null;
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {artifacts.map((artifact) => (
        <li key={artifact.id}>
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<a href={artifactDownloadUrl(artifact)} download={artifact.name} />}
            title={`${artifact.name} · ${artifact.mimeType}`}
          >
            <Download />
            <span className="font-mono text-xs">{artifact.name}</span>
            <span className="text-muted-foreground tabular-nums">
              {formatBytes(artifact.sizeBytes)}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
