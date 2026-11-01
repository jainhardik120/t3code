import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ShellThreadStatus,
} from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

/**
 * What agents are doing right now, with the processes each thread owns.
 * Built for glanceable local monitors (the GNOME panel extension) that poll
 * `GET /api/orchestration/activity`; keep it small enough to poll every few seconds.
 */
export const AgentActivityUsage = Schema.Struct({
  cpuPercent: Schema.Number,
  residentBytes: NonNegativeInt,
  processCount: NonNegativeInt,
});
export type AgentActivityUsage = typeof AgentActivityUsage.Type;

export const AgentActivityProcess = Schema.Struct({
  pid: PositiveInt,
  /** With pid, identifies the process for server.signalProcess. */
  startTimeMs: NonNegativeInt,
  ppid: NonNegativeInt,
  /** Depth below the thread's root process; 0 is the provider process itself. */
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  cpuPercent: Schema.Number,
  residentBytes: NonNegativeInt,
  runTimeMs: NonNegativeInt,
});
export type AgentActivityProcess = typeof AgentActivityProcess.Type;

/** The provider session T3 keeps warm between turns; released after it sits idle. */
export const AgentActivitySession = Schema.Struct({
  busy: Schema.Boolean,
  releaseAt: Schema.NullOr(Schema.DateTimeUtc),
  /** Held past the idle timeout because background work is still running. */
  pinned: Schema.Boolean,
});
export type AgentActivitySession = typeof AgentActivitySession.Type;

export const AgentActivityThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  status: OrchestrationV2ShellThreadStatus,
  /** Set while a run is active: preparing, starting, running or waiting. */
  runStatus: Schema.NullOr(Schema.String),
  runStartedAt: Schema.NullOr(Schema.DateTimeUtc),
  /** The agent is blocked on an approval or a question for the user. */
  waitingOnUser: Schema.Boolean,
  backgroundTasks: Schema.Array(OrchestrationV2PendingBackgroundTask),
  session: Schema.NullOr(AgentActivitySession),
  usage: AgentActivityUsage,
  processes: Schema.Array(AgentActivityProcess),
});
export type AgentActivityThread = typeof AgentActivityThread.Type;

export const AgentActivitySnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  host: HostResourcesSnapshot,
  /** Every process in the server's tree, including the server itself. */
  total: AgentActivityUsage,
  /** Child processes no thread claims (shared provider servers, tooling). */
  unattributed: AgentActivityUsage,
  threads: Schema.Array(AgentActivityThread),
});
export type AgentActivitySnapshot = typeof AgentActivitySnapshot.Type;
