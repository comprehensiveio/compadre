import { LegendList } from "@legendapp/list/react";
import {
  CompadreThreadOperationsSnapshot,
  ThreadId,
  type CompadreThreadOperation,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  containerLabel,
  isObservationStale,
  lastActivityAt,
  type ThreadOperationsSort,
  filterThreadOperations,
  formatOperationsAge,
  type ThreadOperationsFilter,
} from "./threadOperations.logic";

const decodeSnapshot = Schema.decodeUnknownSync(CompadreThreadOperationsSnapshot);
const FILTERS: ReadonlyArray<{ value: ThreadOperationsFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "working", label: "Agent active" },
  { value: "running", label: "Containers running" },
  { value: "problems", label: "Problems" },
  { value: "unknown", label: "Unknown / stale" },
];
const columns =
  "grid grid-cols-[minmax(14rem,1.5fr)_minmax(14rem,1.5fr)_minmax(10rem,1fr)_9rem_9rem_6rem] gap-4";

function DetailText({
  children,
  detail,
  className,
}: {
  children: ReactNode;
  detail?: string | undefined;
  className?: string;
}) {
  if (!detail) return <p className={className}>{children}</p>;
  return (
    <Tooltip>
      <TooltipTrigger render={<p className={className} tabIndex={0} />}>{children}</TooltipTrigger>
      <TooltipPopup>{detail}</TooltipPopup>
    </Tooltip>
  );
}

function OperationsRow({ thread }: { readonly thread: CompadreThreadOperation }) {
  const environmentId = usePrimaryEnvironmentId();
  const [expanded, setExpanded] = useState(false);
  const progressAt = lastActivityAt(thread);
  const suspended = thread.container.workerState === "suspended";
  const stale = isObservationStale(thread);
  const checkedAt = thread.environment?.checkedAt;
  const observation = checkedAt
    ? `${stale ? "Stale · " : "Checked "}${formatOperationsAge(checkedAt)}`
    : suspended
      ? "Container suspended"
      : "Not checked yet";
  const devServer = thread.environment?.devServer ?? "unknown";
  const database = thread.environment?.database ?? "unknown";
  const title = (
    <span className="block truncate text-sm font-medium text-foreground">{thread.title}</span>
  );
  return (
    <div className="border-b border-border/70 text-xs">
      <div className={cn(columns, "min-h-24 items-center px-4 py-3")}>
        <div className="flex min-w-0 items-center gap-2">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`${expanded ? "Hide" : "Show"} details for ${thread.title}`}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDownIcon className={cn("size-3.5", expanded && "rotate-180")} />
          </Button>
          <div className="min-w-0">
            {environmentId ? (
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: ThreadId.make(thread.canonicalThreadId) }}
                className="hover:underline"
              >
                {title}
              </Link>
            ) : (
              title
            )}
            <p className="mt-1 text-muted-foreground">
              Created {formatOperationsAge(thread.createdAt)}
            </p>
          </div>
        </div>
        <div className="min-w-0">
          <DetailText className="truncate font-medium text-foreground" detail={thread.phase}>
            {thread.phase}
          </DetailText>
          <DetailText
            className="mt-1 truncate text-muted-foreground"
            detail={thread.activeRun?.lastEvent?.at}
          >
            {thread.activitySince
              ? `Started ${formatOperationsAge(thread.activitySince)}`
              : thread.activeRun?.lastEvent?.at
                ? `Last event ${formatOperationsAge(thread.activeRun.lastEvent.at)}`
                : thread.status === "working"
                  ? "Waiting for activity"
                  : "No active turn"}
          </DetailText>
          {thread.health !== "healthy" ? (
            <DetailText
              className="mt-1 truncate text-amber-600 dark:text-amber-400"
              detail={thread.healthReason}
            >
              {thread.healthReason}
            </DetailText>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="font-medium">{containerLabel(thread)}</p>
          <p className="mt-1 text-muted-foreground">
            {suspended
              ? thread.container.hasSnapshot
                ? "Snapshot available"
                : thread.container.hasSnapshot === false
                  ? "No saved snapshot"
                  : "Snapshot unknown"
              : observation}
          </p>
        </div>
        <div>
          <p
            className={cn(
              "capitalize",
              devServer === "unresponsive" && "text-amber-600 dark:text-amber-400",
            )}
          >
            {suspended ? "Stopped" : devServer}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{observation}</p>
        </div>
        <div>
          <p className="capitalize">{suspended ? "Stopped" : database}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {suspended ? "Data health unchecked" : observation}
          </p>
        </div>
        <DetailText className="text-right text-muted-foreground" detail={progressAt}>
          {formatOperationsAge(progressAt)}
        </DetailText>
      </div>
      {expanded ? (
        <div className="border-t border-border/50 bg-muted/20 px-5 py-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 break-all sm:grid-cols-3">
            {[
              ["Thread ID", thread.canonicalThreadId],
              ["Container ID", thread.container.sandboxId],
              ["Generation", String(thread.container.generation)],
              [
                "Provider / model",
                `${thread.modelSelection.instanceId} / ${thread.modelSelection.model}`,
              ],
              ["Run ID", thread.activeRun?.runId ?? "None"],
              ["Run status", thread.activeRun?.status ?? "None"],
              ["Container started", thread.container.startedAt ?? "Unknown"],
              ["Warm until", thread.container.warmUntil ?? "Not scheduled"],
              ["Last event", thread.activeRun?.lastEvent?.type ?? "None"],
              ["Last event detail", thread.activeRun?.lastEvent?.detail ?? "None"],
              [
                "Recorded state",
                `${thread.container.workerState ?? thread.container.status} · ${thread.updatedAt}`,
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 select-text">{value}</dd>
              </div>
            ))}
          </dl>
          {thread.recentEvents?.length ? (
            <div className="mt-4">
              <p className="font-medium">Recent run events</p>
              <ol className="mt-2 space-y-1 border-l border-border pl-3">
                {thread.recentEvents.map((event) => (
                  <li
                    key={event.id ?? `${event.type}-${event.at}-${event.detail}`}
                    className="text-muted-foreground"
                  >
                    <span>{event.at ? new Date(event.at).toLocaleString() : "Time unknown"}</span> ·{" "}
                    {event.type.replaceAll("_", " ").toLowerCase()}
                    {event.detail ? ` · ${event.detail}` : ""}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div className="mt-4 flex items-center gap-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(thread.canonicalThreadId)}
            >
              Copy thread ID
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigator.clipboard.writeText(thread.container.sandboxId)}
            >
              Copy container ID
            </Button>
            {thread.environment?.previewUrl ? (
              <a
                href={thread.environment.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {suspended || devServer !== "ready"
                  ? "Open preview (starts environment) ↗"
                  : "Open preview ↗"}
              </a>
            ) : null}
          </div>
          <p className="mt-3 text-muted-foreground">
            Database readiness checks whether local PostgreSQL accepts connections; it does not
            verify data or migrations.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function ThreadOperationsPage() {
  const [snapshot, setSnapshot] = useState<CompadreThreadOperationsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<ThreadOperationsFilter>("all");
  const [sort, setSort] = useState<ThreadOperationsSort>("activity");
  const [query, setQuery] = useState("");

  const requestInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
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
      requestInFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!disposed) timer = window.setTimeout(() => void tick(), 5_000);
    };
    void tick();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const threads = useMemo(
    () => filterThreadOperations(snapshot?.threads ?? [], filter, query, sort),
    [filter, query, sort, snapshot?.threads],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex w-full min-w-0 items-center gap-3">
            <div>
              <h1 className="text-sm font-semibold">Thread environments</h1>
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
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {snapshot ? `${threads.length} of ${snapshot.threads.length} threads` : "Loading…"}
            </span>
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
            <select
              aria-label="Sort threads"
              value={sort}
              onChange={(event) => setSort(event.target.value as ThreadOperationsSort)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            >
              <option value="activity">Latest activity</option>
              <option value="created">Newest created</option>
            </select>
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

          <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border border-border bg-card">
            <div
              className={cn(
                columns,
                "min-w-[1050px] border-b border-border bg-muted/25 px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
              )}
            >
              <span>Thread</span>
              <span>Agent activity</span>
              <span>Container</span>
              <span>Dev server</span>
              <span>Dev database</span>
              <span className="text-right">Last activity</span>
            </div>
            {threads.length > 0 ? (
              <LegendList
                data={threads}
                keyExtractor={(thread) => thread.canonicalThreadId}
                renderItem={({ item }) => <OperationsRow thread={item} />}
                estimatedItemSize={96}
                drawDistance={480}
                className="min-h-0 min-w-[1050px] flex-1"
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
