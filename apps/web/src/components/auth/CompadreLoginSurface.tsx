import { MessageCircleIcon } from "lucide-react";

import { APP_DISPLAY_NAME } from "../../branding";
import { Button } from "../ui/button";

const RETURN_TO_KEY = "compadre:auth-return-to";

export function rememberCompadreAuthReturnTo(path: string): void {
  if (path.startsWith("/") && !path.startsWith("//")) {
    window.sessionStorage.setItem(RETURN_TO_KEY, path);
  }
}

function compadreSlackLoginUrl(): string {
  const returnTo = window.sessionStorage.getItem(RETURN_TO_KEY) ?? "/";
  return `/auth/slack/start?return_to=${encodeURIComponent(returnTo)}`;
}

export function CompadreLoginSurface() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 compadre-login-glow-top" />
        <div className="absolute inset-y-0 left-0 w-72 compadre-login-glow-side" />
        <div className="absolute inset-0 compadre-login-shade" />
      </div>

      <section className="relative w-full max-w-lg rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <div className="flex items-center gap-2">
          <img alt="" aria-hidden className="size-6 rounded-md" src="/compadre.png" />
          <p className="text-2xs font-semibold tracking-brand text-muted-foreground uppercase">
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
