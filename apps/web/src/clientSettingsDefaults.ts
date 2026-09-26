import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  PanelAnimationDurationMs,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { COMPADRE_AUTH_ENABLED } from "./branding";

// Keep hosted browser defaults at the client boundary; saved preferences still win.
export const WEB_CLIENT_SETTINGS_DEFAULTS = COMPADRE_AUTH_ENABLED
  ? { ...DEFAULT_CLIENT_SETTINGS, panelAnimationDurationMs: 275 }
  : DEFAULT_CLIENT_SETTINGS;

export const BrowserClientSettingsSchema = Schema.Struct({
  ...ClientSettingsSchema.fields,
  panelAnimationDurationMs: PanelAnimationDurationMs.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(WEB_CLIENT_SETTINGS_DEFAULTS.panelAnimationDurationMs),
    ),
  ),
});
