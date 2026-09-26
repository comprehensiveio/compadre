import type { ThreadExternalReference } from "@t3tools/contracts";
import { MessageSquareIcon, SlackIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import { SIDEBAR_IDENTITY_FILTER_OPTIONS, type SidebarIdentityFilter } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function participantInitials(displayName: string): string {
  return (
    displayName
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export function ThreadParticipantAvatars({
  thread,
  compact = false,
}: {
  thread: Pick<SidebarThreadSummary, "participants">;
  compact?: boolean;
}) {
  const participants = thread.participants ?? [];
  const visible = participants.slice(0, 3);
  if (visible.length === 0) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-sidebar-control-surface text-sidebar-muted-foreground",
          compact ? "size-4" : "size-5",
        )}
      >
        <MessageSquareIcon className={compact ? "size-2.5" : "size-3"} />
      </span>
    );
  }
  const names = participants.map((participant) => participant.displayName).join(", ");
  return (
    <span className="flex shrink-0 items-center" aria-label={`Participants: ${names}`}>
      {visible.map((participant, index) => (
        <Tooltip key={participant.userId}>
          <TooltipTrigger render={<span className="contents" />}>
            {participant.avatarUrl ? (
              <img
                key={participant.userId}
                src={participant.avatarUrl}
                alt=""
                className={cn(
                  "rounded-full border border-sidebar object-cover",
                  compact ? "size-4" : "size-5",
                  index > 0 && "-ml-1.5",
                )}
              />
            ) : (
              <span
                key={participant.userId}
                className={cn(
                  "flex items-center justify-center rounded-full border border-sidebar bg-sidebar-control-surface font-medium text-sidebar-muted-foreground",
                  compact ? "size-4 text-5xs" : "size-5 text-4xs",
                  index > 0 && "-ml-1.5",
                )}
              >
                {participantInitials(participant.displayName)}
              </span>
            )}
          </TooltipTrigger>
          <TooltipPopup>{participant.displayName}</TooltipPopup>
        </Tooltip>
      ))}
      {participants.length > visible.length ? (
        <span className="-ml-1.5 flex size-5 items-center justify-center rounded-full border border-sidebar bg-sidebar-control-surface text-4xs font-medium text-sidebar-muted-foreground">
          +{participants.length - visible.length}
        </span>
      ) : null}
    </span>
  );
}

export function CompadreConversationFilter({
  value,
  onChange,
}: {
  value: SidebarIdentityFilter;
  onChange: (value: SidebarIdentityFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter conversations"
      className="mb-2 grid grid-cols-3 gap-0.5 rounded-md bg-sidebar-control-surface p-0.5 text-2xs"
    >
      {SIDEBAR_IDENTITY_FILTER_OPTIONS.map(({ value: option, label }) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "min-w-0 cursor-pointer truncate rounded-sm px-1.5 py-1 text-center transition-colors",
            value === option
              ? "bg-sidebar-row-active font-medium text-sidebar-foreground shadow-xs"
              : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function CompadreSlackThreadLink({ reference }: { reference: ThreadExternalReference }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={reference.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Slack thread"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <SlackIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup>Slack thread</TooltipPopup>
    </Tooltip>
  );
}
