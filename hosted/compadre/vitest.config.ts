import { defineConfig } from "vitest/config";

// In the monorepo, vitest would otherwise walk up and load the repo root's
// vite.config.ts (the fork's vp config, which needs vite-plus and excludes
// hosted/compadre/**). An explicit local config pins resolution here; the
// standalone-repo defaults were empty, so this stays empty too.
export default defineConfig({});
