import { createFileRoute } from "@tanstack/react-router";

import { ThreadOperationsPage } from "../components/operations/ThreadOperationsPage";

export const Route = createFileRoute("/_chat/operations/threads")({
  component: ThreadOperationsPage,
});
