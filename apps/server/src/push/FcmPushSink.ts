import type { OrchestrationV2ThreadShell, Project, ThreadId } from "@t3tools/contracts";
import type { AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PushDevices from "../persistence/PushDevices.ts";
import { shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { FCM_SERVICE_ACCOUNT_SECRET, PUSH_ANDROID_CHANNEL_ID } from "./config.ts";
import {
  type FcmAccessToken,
  type FcmServiceAccount,
  mintAccessToken,
  parseServiceAccount,
  sendMessage,
} from "./FcmClient.ts";

const NOTIFICATION_DETAIL_MAX_LENGTH = 140;

export class FcmPushSink extends Context.Service<
  FcmPushSink,
  {
    readonly notifyThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/FcmPushSink") {}

type PushCategory = "notifyOnApproval" | "notifyOnInput" | "notifyOnCompletion" | "notifyOnFailure";

// Which preference toggle a phase maps to. Non-alerting phases (starting,
// running, stale) return null and never raise a notification.
export function pushCategoryForPhase(phase: AgentAwarenessPhase): PushCategory | null {
  switch (phase) {
    case "waiting_for_approval":
      return "notifyOnApproval";
    case "waiting_for_input":
      return "notifyOnInput";
    case "completed":
      return "notifyOnCompletion";
    case "failed":
      return "notifyOnFailure";
    default:
      return null;
  }
}

function isActivePhase(phase: AgentAwarenessPhase): boolean {
  return (
    phase === "starting" ||
    phase === "running" ||
    phase === "waiting_for_approval" ||
    phase === "waiting_for_input"
  );
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const pushDevices = yield* PushDevices.PushDeviceRepository;

  // Last phase we observed per thread, so we only notify on transitions rather
  // than on every projection update. `none` = no publishable awareness state.
  const lastPhaseByThread = new Map<ThreadId, AgentAwarenessPhase | "none">();
  // Threads we have seen in an active phase this process. Sessions boot at
  // "ready" (which projects as completed for an instant), so a completed alert
  // is only sent for threads that were previously active — this suppresses a
  // spurious "finished" at thread birth.
  const everActiveThreads = new Set<ThreadId>();
  const accessTokenRef = yield* Ref.make<FcmAccessToken | null>(null);

  const readFcmAccount: Effect.Effect<FcmServiceAccount | null> = Effect.gen(function* () {
    const bytes = yield* secrets.get(FCM_SERVICE_ACCOUNT_SECRET);
    if (Option.isNone(bytes)) {
      return null;
    }
    const json = new TextDecoder().decode(bytes.value);
    return yield* parseServiceAccount(json).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("push notifications disabled; FCM service account is invalid", {
          message: error.message,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
  }).pipe(Effect.orElseSucceed(() => null));

  const getAccessToken = Effect.fn("getAccessToken")(function* (account: FcmServiceAccount) {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(accessTokenRef);
    if (cached && cached.expiresAtMs - 60_000 > now) {
      return cached.accessToken;
    }
    const minted = yield* mintAccessToken(account).pipe(Effect.provide(FetchHttpClient.layer));
    yield* Ref.set(accessTokenRef, minted);
    return minted.accessToken;
  });

  const sendToDevice = (input: {
    readonly account: FcmServiceAccount;
    readonly accessToken: string;
    readonly device: PushDevices.PushDeviceRecord;
    readonly title: string;
    readonly body: string;
    readonly data: Record<string, string>;
  }) =>
    sendMessage({
      accessToken: input.accessToken,
      projectId: input.account.projectId,
      message: {
        token: input.device.token,
        title: input.title,
        body: input.body,
        data: input.data,
        androidChannelId: PUSH_ANDROID_CHANNEL_ID,
      },
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.flatMap((result) =>
        result.unregistered
          ? Effect.logInfo("dropping unregistered push device", {
              deviceId: input.device.deviceId,
            }).pipe(
              Effect.andThen(
                pushDevices
                  .deleteByDeviceId({ deviceId: input.device.deviceId })
                  .pipe(Effect.ignore),
              ),
            )
          : result.ok
            ? Effect.void
            : Effect.logWarning("push delivery failed", {
                deviceId: input.device.deviceId,
                status: result.status,
              }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("push delivery error", {
          deviceId: input.device.deviceId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const notifyThreadUnsafe = Effect.fn("notifyThreadUnsafe")(function* (threadId: ThreadId) {
    const account = yield* readFcmAccount;
    if (!account) {
      return;
    }
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const threadShell = yield* threads.getThreadShell(threadId);
    const thread =
      threadShell === null || threadShell.archivedAt !== null
        ? Option.none<OrchestrationV2ThreadShell>()
        : Option.some(threadShell);
    const project = Option.isSome(thread)
      ? yield* projects.getById(thread.value.projectId)
      : Option.none<Project>();
    const state =
      Option.isSome(thread) && Option.isSome(project)
        ? projectThreadAwarenessV2({
            environmentId,
            project: project.value,
            thread: thread.value,
          })
        : null;

    const phase: AgentAwarenessPhase | "none" = state?.phase ?? "none";
    const previous = lastPhaseByThread.get(threadId) ?? "none";
    lastPhaseByThread.set(threadId, phase);

    if (phase !== "none" && isActivePhase(phase)) {
      everActiveThreads.add(threadId);
    }

    // Only alert on a genuine transition into an alerting phase.
    if (phase === previous || state === null) {
      return;
    }
    const category = pushCategoryForPhase(state.phase);
    if (!category) {
      return;
    }
    if (state.phase === "completed" && !everActiveThreads.has(threadId)) {
      return;
    }

    const devices = yield* pushDevices.listAll().pipe(Effect.orElseSucceed(() => []));
    const targets = devices.filter(
      (device) =>
        device.platform === "android" &&
        device.preferences.notificationsEnabled &&
        device.preferences[category],
    );
    if (targets.length === 0) {
      return;
    }

    const accessToken = yield* getAccessToken(account);
    const detail = state.detail?.trim().slice(0, NOTIFICATION_DETAIL_MAX_LENGTH);
    const title = state.headline;
    const body =
      detail && detail.length > 0 ? detail : `${state.projectTitle} · ${state.threadTitle}`;
    const data: Record<string, string> = {
      deepLink: state.deepLink,
      environmentId,
      threadId,
    };

    yield* Effect.logInfo("delivering push notification", {
      threadId,
      phase: state.phase,
      targets: targets.length,
    });
    yield* Effect.forEach(
      targets,
      (device) => sendToDevice({ account, accessToken, device, title, body, data }),
      { concurrency: 4, discard: true },
    );
  });

  const notifyThread: FcmPushSink["Service"]["notifyThread"] = (threadId) =>
    notifyThreadUnsafe(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push notification failed", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.withSpan("FcmPushSink.notifyThread"),
    );

  const worker = yield* makeDrainableWorker(notifyThread);

  const start: FcmPushSink["Service"]["start"] = Effect.fn("FcmPushSink.start")(function* () {
    const account = yield* readFcmAccount;
    yield* Effect.logInfo(
      account
        ? "self-hosted push notifications enabled"
        : "self-hosted push notifications standby; no FCM service account configured",
    );
    yield* Effect.forkScoped(
      Stream.runForEach(threads.streamDomainEvents, (event) => {
        if (!shouldPublishAgentAwarenessEvent(event)) {
          return Effect.void;
        }
        return worker.enqueue(event.threadId);
      }),
    );
  });

  return FcmPushSink.of({
    notifyThread,
    start,
  });
});

export const layer = Layer.effect(FcmPushSink, make);
