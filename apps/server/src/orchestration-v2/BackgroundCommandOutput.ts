import type {
  OrchestrationV2GetBackgroundCommandOutputInput,
  OrchestrationV2GetBackgroundCommandOutputResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Tail size returned to clients; background logs can grow without bound. */
const MAX_TAIL_BYTES = 256 * 1024;

// Claude's Bash tool with run_in_background answers with this notice instead of the output.
const BACKGROUND_NOTICE = /Output is being written to: (\/\S+\.output)\b/;
// Only Claude's own task files: <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output.
const CLAUDE_TASK_OUTPUT =
  /^\/(?:[^/]+\/)*claude-\d+\/[^/]+\/[^/]+\/tasks\/[A-Za-z0-9_-]+\.output$/;

export function backgroundOutputPath(commandOutput: string): string | null {
  const path = BACKGROUND_NOTICE.exec(commandOutput)?.[1];
  return path !== undefined && isClaudeTaskOutputPath(path) ? path : null;
}

function isClaudeTaskOutputPath(path: string): boolean {
  return !path.split("/").includes("..") && CLAUDE_TASK_OUTPUT.test(path);
}

export class BackgroundCommandOutputError extends Schema.TaggedError<BackgroundCommandOutputError>()(
  "BackgroundCommandOutputError",
  {
    reason: Schema.Literals(["not-background", "read-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class BackgroundCommandOutput extends Context.Service<
  BackgroundCommandOutput,
  {
    readonly read: (
      input: OrchestrationV2GetBackgroundCommandOutputInput,
    ) => Effect.Effect<
      OrchestrationV2GetBackgroundCommandOutputResult,
      BackgroundCommandOutputError
    >;
  }
>()("t3/orchestration-v2/BackgroundCommandOutput") {}

const make = Effect.fn("makeBackgroundCommandOutput")(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;

  const read: BackgroundCommandOutput["Service"]["read"] = Effect.fn(
    "BackgroundCommandOutput.read",
  )(function* (input) {
    const { item } = yield* threadManagement
      .getTurnItem({ threadId: input.threadId, itemId: input.itemId })
      .pipe(
        Effect.mapError(
          (cause) => new BackgroundCommandOutputError({ reason: "read-failed", cause }),
        ),
      );
    const path =
      item?.type === "command_execution" && item.output !== undefined
        ? backgroundOutputPath(item.output)
        : null;
    if (path === null) return yield* new BackgroundCommandOutputError({ reason: "not-background" });
    return yield* Effect.gen(function* () {
      // A symlink must not lead the read outside the task directory.
      if (!isClaudeTaskOutputPath(yield* fileSystem.realPath(path))) {
        return yield* new BackgroundCommandOutputError({ reason: "not-background" });
      }
      const info = yield* fileSystem.stat(path);
      const sizeBytes = Number(info.size);
      const offset = Math.max(0, sizeBytes - MAX_TAIL_BYTES);
      const chunks = [...(yield* Stream.runCollect(fileSystem.stream(path, { offset })))];
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      return { path, text: new TextDecoder().decode(bytes), sizeBytes, truncated: offset > 0 };
    }).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new BackgroundCommandOutputError({ reason: "read-failed", cause })),
      }),
    );
  });

  return BackgroundCommandOutput.of({ read });
});

export const layer = Layer.effect(BackgroundCommandOutput, make());
