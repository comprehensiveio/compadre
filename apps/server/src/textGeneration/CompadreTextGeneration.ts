import { type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as HttpBody from "effect/unstable/http/HttpBody";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const COMPADRE_TIMEOUT_MS = 180_000;
const COMPADRE_METADATA_PROVIDER = "codex";
const COMPADRE_METADATA_MODEL = "gpt-5.6-luna";
const COMPADRE_METADATA_OPTIONS = [{ id: "reasoningEffort", value: "low" }] as const;
const PromptResponse = Schema.Struct({ result: Schema.String });
const isTextGenerationError = Schema.is(TextGenerationError);

type CompadreAgentProvider = "claude-code" | "codex";

export interface CompadreTextGenerationOptions {
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly provider?: CompadreAgentProvider;
}

function textGenerationEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/hosted\/(?:t3\/)?chat\/?$/u, "/hosted/t3/text-generation");
  return url.toString();
}

export const makeCompadreTextGeneration = Effect.fn("makeCompadreTextGeneration")(function* (
  options: CompadreTextGenerationOptions,
) {
  const httpClient = yield* HttpClient.HttpClient;

  const runCompadreJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> => {
    let request = HttpClientRequest.post(textGenerationEndpoint(options.endpoint), {
      body: HttpBody.jsonUnsafe({
        prompt: input.prompt,
        provider: COMPADRE_METADATA_PROVIDER,
        model: COMPADRE_METADATA_MODEL,
        modelOptions: COMPADRE_METADATA_OPTIONS,
      }),
    });
    if (options.apiKey) {
      request = request.pipe(HttpClientRequest.bearerToken(options.apiKey));
    }

    return httpClient.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PromptResponse)),
      Effect.timeoutOption(COMPADRE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Compadre text-generation request timed out.",
              }),
            ),
          onSome: (response) => Effect.succeed(response.result),
        }),
      ),
      Effect.flatMap((result) =>
        Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(extractJsonObject(result)),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: HttpClientError.isHttpClientError(cause)
                ? cause.response !== undefined
                  ? `Compadre text-generation request failed with HTTP ${cause.response.status}.`
                  : "Compadre text-generation request failed."
                : Schema.isSchemaError(cause)
                  ? "Compadre returned invalid structured text-generation output."
                  : "Compadre text-generation request failed.",
              cause,
            }),
      ),
    );
  };

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CompadreTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runCompadreJson({
        operation: "generateCommitMessage",
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CompadreTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runCompadreJson({
        operation: "generatePrContent",
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CompadreTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runCompadreJson({
        operation: "generateBranchName",
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CompadreTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runCompadreJson({
        operation: "generateThreadTitle",
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
