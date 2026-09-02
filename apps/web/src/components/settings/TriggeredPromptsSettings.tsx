import { AlarmClockIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  DELIVERY_MODE_DESCRIPTIONS,
  DELIVERY_MODE_LABELS,
  EMPTY_TRIGGERED_PROMPT_DRAFT,
  describeTriggerSchedule,
  draftToRequestBody,
  recordToDraft,
  validateTriggeredPromptDraft,
  type TriggeredPromptDeliveryMode,
  type TriggeredPromptDraft,
  type TriggeredPromptRecord,
} from "./TriggeredPromptsSettings.logic";

type ProxyAction = "list" | "create" | "update" | "enable" | "delete" | "run";

async function triggeredPromptsApi(
  action: ProxyAction,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/triggered-prompts/${action}`, {
    method: action === "list" ? "GET" : "POST",
    credentials: "same-origin",
    ...(action === "list"
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        }),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const issues = data.issues;
    const message = Array.isArray(issues)
      ? issues.join("; ")
      : typeof data.error === "string"
        ? data.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data;
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function TriggeredPromptRow({
  record,
  busy,
  onRun,
  onToggleEnabled,
  onEdit,
  onDelete,
}: {
  readonly record: TriggeredPromptRecord;
  readonly busy: boolean;
  readonly onRun: () => void;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{record.name}</h3>
            <span className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
              <AlarmClockIcon className="size-2.5" aria-hidden />
              cron
            </span>
            {!record.enabled ? (
              <span className="rounded-md border border-border/70 px-1 py-0.5 text-[10px] text-muted-foreground">
                Paused
              </span>
            ) : null}
          </div>
          <p className="line-clamp-2 text-xs text-muted-foreground">{record.prompt}</p>
          <p className="text-[11px] text-muted-foreground/70">
            <code className="font-mono">{describeTriggerSchedule(record)}</code>
            <span aria-hidden> · </span>
            {DELIVERY_MODE_LABELS[record.deliveryMode]}
            <span aria-hidden> · </span>
            {record.slackChannelId ?? `thread ${record.targetThreadId?.slice(0, 8) ?? "?"}…`}
            <span aria-hidden> · </span>
            {record.lastFiredAt
              ? `Last fired ${timestampFormatter.format(new Date(record.lastFiredAt))}`
              : "Never fired"}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Switch
            checked={record.enabled}
            disabled={busy}
            aria-label={`${record.name} enabled`}
            onCheckedChange={(checked) => onToggleEnabled(Boolean(checked))}
          />
          <Button size="xs" variant="outline" disabled={busy} onClick={onRun}>
            <PlayIcon aria-hidden />
            Run now
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={onEdit}>
            Edit
          </Button>
          <Button size="xs" variant="destructive-outline" disabled={busy} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftField({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-foreground">
        {label}
        {hint ? <span className="ml-1.5 font-normal text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

function TriggeredPromptDialog({
  open,
  editing,
  draft,
  isSaving,
  onDraftChange,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly editing: TriggeredPromptRecord | null;
  readonly draft: TriggeredPromptDraft;
  readonly isSaving: boolean;
  readonly onDraftChange: (draft: TriggeredPromptDraft) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: () => void;
}) {
  const set = <Key extends keyof TriggeredPromptDraft>(
    key: Key,
    value: TriggeredPromptDraft[Key],
  ) => onDraftChange({ ...draft, [key]: value });
  const validationError = validateTriggeredPromptDraft(draft);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit: ${editing.name}` : "New triggered prompt"}</DialogTitle>
          <DialogDescription>
            The agent receives the prompt verbatim on each fire — it never sees the trigger.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <DraftField label="Name">
            <Input
              value={draft.name}
              onChange={(event) => set("name", event.target.value)}
              placeholder="Daily standup summary"
              disabled={isSaving}
              autoFocus
            />
          </DraftField>
          <DraftField label="Prompt" hint="sent to the agent verbatim">
            <Textarea
              value={draft.prompt}
              onChange={(event) => set("prompt", event.target.value)}
              placeholder="Summarize yesterday's merged PRs and open incidents…"
              rows={4}
              disabled={isSaving}
            />
          </DraftField>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <DraftField label="Cron expression" hint="e.g. 0 9 * * 1-5">
              <Input
                value={draft.cronExpression}
                onChange={(event) => set("cronExpression", event.target.value)}
                placeholder="0 9 * * 1-5"
                className="font-mono"
                disabled={isSaving}
              />
            </DraftField>
            <DraftField label="Timezone" hint="optional IANA, defaults to UTC">
              <Input
                value={draft.timezone}
                onChange={(event) => set("timezone", event.target.value)}
                placeholder="America/Chicago"
                disabled={isSaving}
              />
            </DraftField>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {draft.deliveryMode === "existing_thread" ? (
              <DraftField label="Compadre thread" hint="paste the thread's URL">
                <Input
                  value={draft.targetThread}
                  onChange={(event) => set("targetThread", event.target.value)}
                  placeholder="https://compadre.comprehensive.io/…/thread-id"
                  disabled={isSaving}
                />
              </DraftField>
            ) : (
              <DraftField label="Slack channel ID">
                <Input
                  value={draft.slackChannelId}
                  onChange={(event) => set("slackChannelId", event.target.value)}
                  placeholder="C0123456789"
                  className="font-mono"
                  disabled={isSaving}
                />
              </DraftField>
            )}
            <DraftField label="Thread behavior">
              <Select
                value={draft.deliveryMode}
                onValueChange={(value) => set("deliveryMode", value as TriggeredPromptDeliveryMode)}
                disabled={isSaving}
              >
                <SelectTrigger size="sm" className="w-full" aria-label="Thread behavior">
                  <SelectValue>{DELIVERY_MODE_LABELS[draft.deliveryMode]}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-72">
                  {(Object.keys(DELIVERY_MODE_LABELS) as TriggeredPromptDeliveryMode[]).map(
                    (mode) => (
                      <SelectItem key={mode} value={mode}>
                        <span className="block">
                          <span className="block text-sm">{DELIVERY_MODE_LABELS[mode]}</span>
                          <span className="block text-xs text-muted-foreground">
                            {DELIVERY_MODE_DESCRIPTIONS[mode]}
                          </span>
                        </span>
                      </SelectItem>
                    ),
                  )}
                </SelectPopup>
              </Select>
            </DraftField>
          </div>
          {validationError ? <p className="text-xs text-destructive">{validationError}</p> : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={isSaving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isSaving || validationError !== null} onClick={onSave}>
            {isSaving ? "Saving…" : editing ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function TriggeredPromptsSettingsPanel() {
  const [prompts, setPrompts] = useState<ReadonlyArray<TriggeredPromptRecord> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TriggeredPromptRecord | null>(null);
  const [draft, setDraft] = useState<TriggeredPromptDraft>(EMPTY_TRIGGERED_PROMPT_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TriggeredPromptRecord | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await triggeredPromptsApi("list");
      setPrompts((data.prompts as TriggeredPromptRecord[] | undefined) ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load triggered prompts.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reportError = useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Unknown error.",
      }),
    );
  }, []);

  const runRowAction = useCallback(
    async (record: TriggeredPromptRecord, title: string, action: () => Promise<void>) => {
      setBusyId(record.id);
      try {
        await action();
        await load();
      } catch (error) {
        reportError(title, error);
      } finally {
        setBusyId(null);
      }
    },
    [load, reportError],
  );

  const openCreateDialog = useCallback(() => {
    setEditing(null);
    setDraft(EMPTY_TRIGGERED_PROMPT_DRAFT);
    setDialogOpen(true);
  }, []);

  const openEditDialog = useCallback((record: TriggeredPromptRecord) => {
    setEditing(record);
    setDraft(recordToDraft(record));
    setDialogOpen(true);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const body = draftToRequestBody(draft);
      if (editing) {
        await triggeredPromptsApi("update", { ...body, id: editing.id, enabled: editing.enabled });
      } else {
        await triggeredPromptsApi("create", body);
      }
      setDialogOpen(false);
      await load();
      toastManager.add({
        type: "success",
        title: editing ? "Triggered prompt updated" : "Triggered prompt created",
        description: editing ? undefined : "It will fire on its cron schedule.",
      });
    } catch (error) {
      reportError("Could not save triggered prompt", error);
    } finally {
      setIsSaving(false);
    }
  }, [draft, editing, load, reportError]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="triggered-prompts"
        title="Triggered Prompts"
        headerAction={
          <Button size="xs" onClick={openCreateDialog}>
            <PlusIcon className="size-3" aria-hidden />
            New prompt
          </Button>
        }
      >
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground">
            Prompts fired on a schedule. Each fire runs the agent and delivers only the answer — to
            Slack or the target thread. The agent sees just the prompt, never the trigger.
          </p>
        </div>
        {prompts === null && loadError === null ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              Loading…
            </span>
          </div>
        ) : null}
        {loadError !== null ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-destructive">{loadError}</p>
          </div>
        ) : null}
        {prompts?.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground/60">No triggered prompts yet.</p>
          </div>
        ) : null}
        {prompts?.map((record) => (
          <TriggeredPromptRow
            key={record.id}
            record={record}
            busy={busyId === record.id}
            onRun={() =>
              void runRowAction(record, "Could not fire triggered prompt", async () => {
                const data = await triggeredPromptsApi("run", { id: record.id });
                toastManager.add({
                  type: "success",
                  title: "Triggered prompt fired",
                  description:
                    typeof data.workflowId === "string" ? `Workflow ${data.workflowId}` : undefined,
                });
              })
            }
            onToggleEnabled={(enabled) =>
              void runRowAction(record, "Could not update triggered prompt", async () => {
                await triggeredPromptsApi("enable", { id: record.id, enabled });
              })
            }
            onEdit={() => openEditDialog(record)}
            onDelete={() => setPendingDelete(record)}
          />
        ))}
      </SettingsSection>

      <TriggeredPromptDialog
        open={dialogOpen}
        editing={editing}
        draft={draft}
        isSaving={isSaving}
        onDraftChange={setDraft}
        onOpenChange={setDialogOpen}
        onSave={() => void handleSave()}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete triggered prompt?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” and its schedule will be removed. Runs it already started are
              unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const record = pendingDelete;
                setPendingDelete(null);
                if (!record) return;
                void runRowAction(record, "Could not delete triggered prompt", async () => {
                  await triggeredPromptsApi("delete", { id: record.id });
                });
              }}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
