import { MessageCircleIcon } from "lucide-react";

import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";

const RETURN_TO_KEY = "compadre:auth-return-to";

export function rememberCompadreAuthReturnTo(path: string): void {
  if (path.startsWith("/") && !path.startsWith("//")) {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  }
}

export function compadreSlackLoginUrl(): string {
  const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/";
  return `/auth/slack/start?return_to=${encodeURIComponent(returnTo)}`;
}

export function CompadreLoginSurface() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-lg rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <div className="flex items-center gap-2">
          <img alt="" aria-hidden className="size-6 rounded-md" src="/compadre.png" />
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            {APP_DISPLAY_NAME}
          </p>
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">
          Sign in with Slack
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Use your Comprehensive Slack account to open conversations and continue them from the web.
        </p>
        <Button className="mt-6 w-full" render={<a href={compadreSlackLoginUrl()} />} size="lg">
          <MessageCircleIcon className="size-4" />
          Continue with Slack
        </Button>
      </section>
    </div>
  );
}
