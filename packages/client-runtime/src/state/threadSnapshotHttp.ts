import type {
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadMessagePage,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Bounded so a pathologically slow endpoint cannot block the (cheaper) socket
// fallback for long. The cached thread renders while this runs, so the wait only
// delays the transition to live data on the first open, not the initial paint.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
  // When true, load only the most recent message window (+ pagination metadata)
  // instead of the whole thread history. Mobile opts in; the desktop web app
  // keeps loading the full snapshot.
  readonly windowed?: boolean;
}) {
  const path = input.windowed
    ? `/api/orchestration/threads/${input.threadId}/window`
    : `/api/orchestration/threads/${input.threadId}`;
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, path);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      input.windowed
        ? client.orchestration.threadWindowSnapshot({
            params: { threadId: input.threadId },
            headers,
          })
        : client.orchestration.threadSnapshot({
            params: { threadId: input.threadId },
            headers,
          }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

/**
 * Fetch a page of messages older than `beforeMessageId` for "load older"
 * scrolling. Same transport/auth as the snapshot fetch.
 */
export const fetchEnvironmentThreadMessagePage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadMessagePage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly beforeMessageId: string;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}/messages-before/${encodeURIComponent(
      input.beforeMessageId,
    )}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadMessagesBefore({
        params: { threadId: input.threadId, beforeMessageId: input.beforeMessageId },
        headers,
      }),
    ),
  );
});

export type OrchestrationThreadMessagePageResult = OrchestrationThreadMessagePage;

/**
 * Loads a thread's detail snapshot over HTTP, returning `Option.none()` when it
 * cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the thread state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
    // Load a page of messages older than `beforeMessageId`. Returns
    // `Option.none()` on any failure so the caller simply stops paging.
    readonly loadOlder: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      beforeMessageId: string,
    ) => Effect.Effect<Option.Option<OrchestrationThreadMessagePage>>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const makeThreadSnapshotLoaderLayer = (options?: {
  // When true, the loader fetches only the latest message window (mobile).
  readonly windowed?: boolean;
}): Layer.Layer<ThreadSnapshotLoader, never, HttpClient.HttpClient> =>
  Layer.effect(
    ThreadSnapshotLoader,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
      // connections, so the loader must not hard-require it (bearer/primary
      // connections work without one).
      const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
      return ThreadSnapshotLoader.of({
        load: (prepared: PreparedConnection, threadId: ThreadId) =>
          fetchEnvironmentThreadSnapshot({
            prepared,
            threadId,
            signer,
            windowed: options?.windowed ?? false,
          }).pipe(
            Effect.map(Option.some<OrchestrationThreadDetailSnapshot>),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            // A genuinely missing thread (404) is expected — the socket
            // subscription is the source of truth for thread existence and will
            // surface the deletion — so don't treat it as an error worth warning
            // about; just defer to the socket path.
            Effect.catchTags({
              EnvironmentResourceNotFoundError: () =>
                Effect.logDebug(
                  "Thread snapshot not found over HTTP; deferring to the socket subscription.",
                ).pipe(
                  Effect.annotateLogs({ threadId }),
                  Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
                ),
            }),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
              ).pipe(
                Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
                Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
              ),
            ),
          ),
        loadOlder: (prepared: PreparedConnection, threadId: ThreadId, beforeMessageId: string) =>
          fetchEnvironmentThreadMessagePage({
            prepared,
            threadId,
            beforeMessageId,
            signer,
          }).pipe(
            Effect.map(Option.some<OrchestrationThreadMessagePage>),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not load older thread messages over HTTP.").pipe(
                Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
                Effect.as(Option.none<OrchestrationThreadMessagePage>()),
              ),
            ),
          ),
      });
    }),
  );

// Full-history loader (desktop web app keeps its current behavior).
export const threadSnapshotLoaderLayer = makeThreadSnapshotLoaderLayer();
