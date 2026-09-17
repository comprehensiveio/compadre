import { GithubIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useCompadreSessionUser } from "../../compadreSession";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

interface AccountProfile {
  readonly githubLogin?: string;
  readonly email?: string;
}

async function accountProfileApi(body?: { githubLogin: string }): Promise<AccountProfile> {
  const response = await fetch("/api/account/profile", {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    ...(body
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    user?: AccountProfile;
  };
  if (!response.ok || !data.user) {
    throw new Error(
      typeof data.error === "string" ? data.error : `Request failed (${response.status})`,
    );
  }
  return data.user;
}

/**
 * Hosted-only: the signed-in user's GitHub username, used to credit them with
 * a Co-authored-by trailer on commits the agent makes for them. Renders
 * nothing outside a hosted session.
 */
export function AccountSettingsSection() {
  const user = useCompadreSessionUser();
  return user ? <GithubUsernameSection /> : null;
}

function GithubUsernameSection() {
  const [saved, setSaved] = useState<AccountProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    accountProfileApi()
      .then((profile) => {
        if (cancelled) return;
        setSaved(profile);
        setDraft(profile.githubLogin ?? "");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : "Failed to load your account.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isDirty = saved !== null && draft.trim() !== (saved.githubLogin ?? "");

  const save = useCallback(async () => {
    setIsSaving(true);
    try {
      const profile = await accountProfileApi({ githubLogin: draft.trim() });
      setSaved(profile);
      setDraft(profile.githubLogin ?? "");
      toastManager.add({
        type: "success",
        title: profile.githubLogin
          ? `Commits will credit @${profile.githubLogin}`
          : "GitHub username cleared",
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save GitHub username",
          description: error instanceof Error ? error.message : "Unknown error.",
        }),
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft]);

  const { id, title } = searchableSetting("github-username");
  const creditedAs = saved?.githubLogin
    ? `@${saved.githubLogin}`
    : saved?.email
      ? `${saved.email} (linked only if that email is verified on your GitHub account)`
      : "nobody, until a username is set";

  return (
    <SettingsSection id="account" title="Account" icon={<GithubIcon className="size-3.5" />}>
      <div id={id} className={ITEM_ROW_CLASSNAME}>
        <div className="flex flex-col gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">
              Commits the agent makes for you carry a Co-authored-by trailer. With a username set,
              GitHub credits your account directly instead of matching your Slack email.
            </p>
          </div>
          {loadError ? (
            <p className="text-xs text-destructive">{loadError}</p>
          ) : saved === null ? (
            <Spinner className="size-4" />
          ) : (
            <form
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
              onSubmit={(event) => {
                event.preventDefault();
                if (isDirty && !isSaving) void save();
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="octocat"
                autoComplete="off"
                spellCheck={false}
                aria-label={title}
                className="sm:max-w-xs"
              />
              <Button type="submit" size="sm" disabled={!isDirty || isSaving}>
                {isSaving ? <Spinner className="size-3" /> : null}
                Save
              </Button>
            </form>
          )}
          {saved !== null && !loadError ? (
            <p className="text-xs text-muted-foreground">Currently credited as {creditedAs}.</p>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
