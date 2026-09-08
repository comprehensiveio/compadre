import {
  COMPADRE_PREVIEW_FRESHNESS_MS,
  CompadreReadyPreviews,
  freshCompadrePreviewUrl,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { GlobeIcon } from "lucide-react";
import { usePrimaryEnvironmentId } from "./state/environments";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./components/ui/tooltip";

const emptyPreviews: ReadonlyMap<string, string> = new Map();
const PreviewContext = createContext(emptyPreviews);
const decode = Schema.decodeUnknownSync(CompadreReadyPreviews);

/** One polling loop for the hosted client, shared by all sidebar rows. */
export function watchCompadrePreviews(
  setPreviews: (previews: ReadonlyMap<string, string>) => void,
) {
  let disposed = false;
  let pending = false;
  let controller: AbortController | undefined;
  let hiddenAbortController: AbortController | undefined;
  let refreshAfterPending = false;
  let expiryTimer: number | undefined;
  let latestSnapshot: CompadreReadyPreviews | undefined;
  const publish = (snapshot: CompadreReadyPreviews) => {
    window.clearTimeout(expiryTimer);
    const now = Date.now();
    const next = new Map<string, string>();
    let nextExpiry = Infinity;
    for (const preview of snapshot.previews) {
      const url = freshCompadrePreviewUrl(preview, now);
      if (!url) continue;
      next.set(preview.threadId, url);
      nextExpiry = Math.min(
        nextExpiry,
        Date.parse(preview.checkedAt) + COMPADRE_PREVIEW_FRESHNESS_MS,
      );
    }
    setPreviews(next);
    if (Number.isFinite(nextExpiry)) {
      expiryTimer = window.setTimeout(() => publish(snapshot), nextExpiry - now);
    }
  };
  const refresh = async () => {
    if (document.hidden) return;
    if (pending) {
      refreshAfterPending = true;
      return;
    }
    pending = true;
    const requestController = new AbortController();
    controller = requestController;
    try {
      const response = await fetch("/api/compadre/previews/ready", {
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error("Preview readiness unavailable");
      const snapshot = decode(await response.json());
      if (!disposed && !document.hidden) {
        latestSnapshot = snapshot;
        publish(snapshot);
      }
    } catch {
      if (!disposed && !document.hidden && hiddenAbortController !== requestController) {
        latestSnapshot = undefined;
        window.clearTimeout(expiryTimer);
        setPreviews(emptyPreviews);
      }
    } finally {
      if (controller === requestController) controller = undefined;
      pending = false;
      if (refreshAfterPending && !disposed && !document.hidden) {
        refreshAfterPending = false;
        void refresh();
      }
    }
  };
  void refresh();
  const timer = window.setInterval(() => void refresh(), 15_000);
  const onVisibility = () => {
    if (document.hidden) {
      window.clearTimeout(expiryTimer);
      refreshAfterPending = false;
      hiddenAbortController = controller;
      controller?.abort();
      return;
    }
    if (latestSnapshot) publish(latestSnapshot);
    void refresh();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    disposed = true;
    controller?.abort();
    window.clearInterval(timer);
    window.clearTimeout(expiryTimer);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export function CompadrePreviewsProvider(props: { children: ReactNode }) {
  const [previews, setPreviews] = useState(emptyPreviews);
  useEffect(() => watchCompadrePreviews(setPreviews), []);
  return <PreviewContext.Provider value={previews}>{props.children}</PreviewContext.Provider>;
}

export function CompadrePreviewIndicator(props: {
  threadId: string;
  environmentId: EnvironmentId;
}) {
  const previews = useContext(PreviewContext);
  const primaryId = usePrimaryEnvironmentId();
  const url = props.environmentId === primaryId ? previews.get(props.threadId) : undefined;
  if (!url) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Preview ready"
            className="-m-0.5 ml-0.5 inline-flex shrink-0 items-center rounded-sm p-0.5 text-blue-600 outline-none transition-colors hover:bg-blue-500/10 hover:text-blue-800 focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 dark:hover:text-blue-200"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          />
        }
      >
        <GlobeIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Preview ready</TooltipPopup>
    </Tooltip>
  );
}
