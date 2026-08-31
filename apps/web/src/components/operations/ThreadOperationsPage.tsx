import { LegendList } from "@legendapp/list/react";
import {
  CompadreThreadOperationsSnapshot,
  ThreadId,
  type CompadreThreadOperation,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  filterThreadOperations,
  formatOperationsAge,
  type ThreadOperationsFilter,
} from "./threadOperations.logic";

const decodeSnapshot = Schema.decodeUnknownSync(CompadreThreadOperationsSnapshot);
const FILTERS: ReadonlyArray<{ value: ThreadOperationsFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "attention", label: "Attention" },
  { value: "stuck", label: "Stuck" },
];

function HealthIcon({ thread }: { readonly thread: CompadreThreadOperation }) {
  if (thread.health === "stuck") {
    return <AlertTriangleIcon className="size-4 text-destructive" aria-hidden="true" />;
  }
  if (thread.health === "attention") {
    return <CircleIcon className="size-4 fill-amber-400/20 text-amber-500" aria-hidden="true" />;
  }
  return <CheckCircle2Icon className="size-4 text-emerald-500" aria-hidden="true" />;
}

function OperationsRow({ thread }: { readonly thread: CompadreThreadOperation }) {
  const environmentId = usePrimaryEnvironmentId();
  const progressAt = thread.activeRun?.lastEvent?.at ?? thread.lastActiveAt ?? thread.updatedAt;
  const title = (
    <span className="min-w-0">
      <span className="block truncate text-sm font-medium text-foreground">{thread.title}</span>
      <span className="block truncate font-mono text-[11px] text-muted-foreground/70">
        {thread.canonicalThreadId}
      </span>
    </span>
  );

  return (
    <div className="grid min-h-20 grid-cols-[minmax(15rem,1.4fr)_minmax(13rem,1.3fr)_minmax(10rem,0.8fr)_minmax(9rem,0.7fr)_6rem] items-center gap-4 border-b border-border/70 px-4 py-3 text-xs">
      <div className="flex min-w-0 items-start gap-2.5">
        <HealthIcon thread={thread} />
        {environmentId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: ThreadId.make(thread.canonicalThreadId) }}
            className="min-w-0 hover:underline"
          >
            {title}
          </Link>
        ) : (
          title
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate text-foreground">{thread.phase}</p>
        <p className="mt-1 truncate text-muted-foreground" title={thread.healthReason}>
          {thread.healthReason}
        </p>
      </div>
      <div className="min-w-0">
        <p className="truncate text-foreground">{thread.modelSelection.model}</p>
        <p className="mt-1 truncate text-muted-foreground">{thread.modelSelection.instanceId}</p>
      </div>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-foreground">
          <ServerIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">
            {thread.container.workerState ?? thread.container.status}
          </span>
        </p>
        <p className="mt-1 truncate text-muted-foreground">
          gen {thread.container.generation} · {thread.container.sandboxId}
        </p>
      </div>
      <div className="text-right text-muted-foreground" title={progressAt}>
        {formatOperationsAge(progressAt)}
      </div>
    </div>
  );
}

export function ThreadOperationsPage() {
  const [snapshot, setSnapshot] = useState<CompadreThreadOperationsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ThreadOperationsFilter>("all");
  const [query, setQuery] = useState("");

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/compadre/operations/threads", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setSnapshot(decodeSnapshot(await response.json()));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Thread operations are unavailable");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const threads = useMemo(
    () => filterThreadOperations(snapshot?.threads ?? [], filter, query),
    [filter, query, snapshot?.threads],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex w-full min-w-0 items-center gap-3">
            <div>
              <h1 className="text-sm font-semibold">Thread operations</h1>
              <p className="text-[11px] text-muted-foreground">
                {snapshot ? `Updated ${formatOperationsAge(snapshot.generatedAt)}` : "Loading"}
              </p>
            </div>
            <Button
              className="ms-auto"
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh thread operations"
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              <RefreshCwIcon className={cn("size-3.5", refreshing && "opacity-50")} />
            </Button>
          </div>
        </WorkspacePageHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 p-5">
          <div className="grid grid-cols-5 gap-3">
            {[
              ["Threads", snapshot?.counts.total ?? 0],
              ["Working", snapshot?.counts.working ?? 0],
              ["Attention", snapshot?.counts.attention ?? 0],
              ["Stuck", snapshot?.counts.stuck ?? 0],
              ["Containers running", snapshot?.counts.containersRunning ?? 0],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <ToggleGroup
              variant="segmented"
              value={[filter]}
              onValueChange={(values) => {
                const value = values[0] as ThreadOperationsFilter | undefined;
                if (value) setFilter(value);
              }}
            >
              {FILTERS.map((option) => (
                <Toggle key={option.value} value={option.value}>
                  {option.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <div className="relative ms-auto w-full max-w-sm">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search title, model, phase, or ID"
                className="ps-8"
              />
            </div>
          </div>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              Could not load thread operations: {error}
            </div>
          ) : null}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card">
            <div className="grid grid-cols-[minmax(15rem,1.4fr)_minmax(13rem,1.3fr)_minmax(10rem,0.8fr)_minmax(9rem,0.7fr)_6rem] gap-4 border-b border-border bg-muted/25 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Thread</span>
              <span>Current phase</span>
              <span>Provider / model</span>
              <span>Container</span>
              <span className="text-right">Progress</span>
            </div>
            {threads.length > 0 ? (
              <LegendList
                data={threads}
                keyExtractor={(thread) => thread.canonicalThreadId}
                renderItem={({ item }) => <OperationsRow thread={item} />}
                estimatedItemSize={80}
                drawDistance={480}
                className="min-h-0 flex-1 overflow-x-auto"
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                {snapshot ? "No threads match this view." : "Loading thread operations…"}
              </div>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
