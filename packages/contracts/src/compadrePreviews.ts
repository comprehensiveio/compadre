import { Schema } from "effect";

/** Only recently observed, reachable previews are exposed to the sidebar. */
export const CompadreReadyPreviews = Schema.Struct({
  previews: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      url: Schema.String,
      checkedAt: Schema.String,
    }),
  ),
});
export type CompadreReadyPreviews = typeof CompadreReadyPreviews.Type;

export const COMPADRE_PREVIEW_FRESHNESS_MS = 90_000;

export function freshCompadrePreviewUrl(
  preview: CompadreReadyPreviews["previews"][number],
  now: number,
): string | null {
  const age = now - Date.parse(preview.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age >= COMPADRE_PREVIEW_FRESHNESS_MS) return null;
  try {
    const url = new URL(preview.url);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
