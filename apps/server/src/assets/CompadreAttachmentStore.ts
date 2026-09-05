import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export class AttachmentObjectError extends Schema.TaggedErrorClass<AttachmentObjectError>()(
  "AttachmentObjectError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** SQLite environments keep their existing filesystem attachment store. */
export class CompadreAttachmentStore extends Context.Reference<{
  readonly persist: (absolutePath: string) => Effect.Effect<void, AttachmentObjectError>;
}>("t3/assets/CompadreAttachmentStore", {
  defaultValue: () => ({ persist: () => Effect.void }),
}) {}
