import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function RunNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col items-center justify-center gap-3 p-4 text-center sm:p-6">
      <SearchX className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">This run does not exist</p>
      <p className="text-sm text-muted-foreground">
        It may have been removed, or the link is wrong.
      </p>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/" />}>
        <ArrowLeft />
        All runs
      </Button>
    </main>
  );
}
