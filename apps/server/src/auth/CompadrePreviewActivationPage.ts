export type PreviewActivationState =
  | "idle"
  | "requested"
  | "restoring"
  | "starting"
  | "failed"
  | "unavailable";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function previewActivationHtml(state: PreviewActivationState, error?: string): string {
  const failed = state === "failed";
  const unavailable = state === "unavailable";
  const detail = error
    ? escapeHtml(error)
    : unavailable
      ? "The saved environment can no longer be restored."
      : "Restoring the container and starting the development server.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Starting preview · Compadre</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #11130f; color: #eef0e8; }
    main { width: min(34rem, calc(100vw - 3rem)); padding: 2rem; border: 1px solid #34392f; border-radius: 16px; background: #191c16; box-shadow: 0 20px 60px #0008; }
    .eyebrow { color: #a9b49d; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: .7rem 0 .6rem; font-size: clamp(1.6rem, 5vw, 2.25rem); letter-spacing: -.035em; }
    p { margin: 0; color: #bfc6b7; line-height: 1.55; }
    #status { margin-top: 1.4rem; padding-top: 1.2rem; border-top: 1px solid #30352c; color: #dbe6ce; }
    button { margin-top: 1.25rem; border: 0; border-radius: 9px; padding: .7rem 1rem; background: #d7f7b6; color: #17200e; font: inherit; font-weight: 700; cursor: pointer; }
    button[hidden] { display: none; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Compadre preview</div>
    <h1>${unavailable ? "Preview unavailable" : failed ? "Preview could not start" : "Waking up your environment"}</h1>
    <p>${detail}</p>
    <div id="status" role="status">${failed ? "Startup failed." : unavailable ? "Open the thread and ask the agent to rebuild the environment." : "Preparing container…"}</div>
    <button id="retry" type="button" ${failed ? "" : "hidden"}>Try again</button>
  </main>
  ${
    unavailable
      ? ""
      : `<script>
    const status = document.getElementById("status");
    const retry = document.getElementById("retry");
    let stopped = ${failed ? "true" : "false"};
    async function activate() {
      stopped = false;
      retry.hidden = true;
      status.textContent = "Requesting environment…";
      const response = await fetch("/.compadre/preview/activate", {
        method: "POST",
        headers: { "x-compadre-preview-action": "start" },
      });
      if (!response.ok) throw new Error("Activation request failed");
      await poll();
    }
    async function poll() {
      while (!stopped) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const response = await fetch("/.compadre/preview/status", { cache: "no-store" });
        const result = await response.json();
        if (result.state === "ready") { location.reload(); return; }
        if (result.state === "failed" || result.state === "unavailable") {
          stopped = true;
          status.textContent = result.error || "Preview startup failed.";
          retry.hidden = result.state === "unavailable";
          return;
        }
        status.textContent = result.state === "restoring"
          ? "Restoring container…"
          : result.state === "starting"
            ? "Starting database and development server…"
            : "Waiting for a worker…";
      }
    }
    retry.addEventListener("click", () => void activate().catch(showFailure));
    function showFailure() { stopped = true; status.textContent = "Preview startup failed."; retry.hidden = false; }
    ${failed ? "" : "void activate().catch(showFailure);"}
  </script>`
  }
</body>
</html>`;
}
