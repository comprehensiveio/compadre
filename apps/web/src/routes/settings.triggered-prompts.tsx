import { createFileRoute } from "@tanstack/react-router";

import { TriggeredPromptsSettingsPanel } from "../components/settings/TriggeredPromptsSettings";

function SettingsTriggeredPromptsRoute() {
  return <TriggeredPromptsSettingsPanel />;
}

export const Route = createFileRoute("/settings/triggered-prompts")({
  component: SettingsTriggeredPromptsRoute,
});
