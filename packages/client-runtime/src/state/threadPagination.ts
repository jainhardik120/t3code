import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";

// "Load older messages" for windowed thread loading. Kept out of the streaming
// thread state machine (which owns the live tail): the caller holds the older
// pages as local UI state and prepends them. An empty page means end-of-history.
export function createThreadPaginationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | ThreadSnapshotLoader | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    loadOlderMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-older",
      scheduler,
      concurrency: {
        mode: "serial" as const,
        key: ({
          environmentId,
          input,
        }: {
          readonly environmentId: string;
          readonly input: { readonly threadId: string; readonly beforeMessageId: string };
        }) => `${environmentId}:${input.threadId}`,
      },
      execute: (input: { readonly threadId: ThreadId; readonly beforeMessageId: string }) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const loader = yield* ThreadSnapshotLoader;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          return yield* loader.loadOlder(prepared, input.threadId, input.beforeMessageId);
        }),
    }),
  };
}
