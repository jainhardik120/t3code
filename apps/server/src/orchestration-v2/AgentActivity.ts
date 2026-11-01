/**
 * Live view of what agents are doing: running threads, their background work,
 * and the CPU/memory of the processes each thread owns.
 *
 * Adapters that run one provider process per thread (Claude) launch it with
 * `T3CODE_THREAD_ID` in its environment. Shared provider servers (Codex
 * app-server, OpenCode) serve many threads, so they stay untagged and count
 * as shared. Everything the agent spawns (shell commands, dev servers,
 * subagent CLIs) inherits it, so reading `/proc/<pid>/environ` attributes a
 * whole process tree to its thread without the adapters tracking PIDs. A
 * process without the variable inherits its parent's thread. Where `/proc`
 * is unavailable (macOS, Windows) every child process is unattributed.
 */
import type {
  AgentActivityProcess,
  AgentActivitySnapshot,
  AgentActivityThread,
  AgentActivityUsage,
  HostResourcesSnapshot,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ResourceTelemetryProcess,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export const AGENT_THREAD_ENV_VAR = "T3CODE_THREAD_ID";

export class AgentActivityReadError extends Schema.TaggedError<AgentActivityReadError>()(
  "AgentActivityReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read agent activity.";
  }
}

export class AgentActivity extends Context.Service<
  AgentActivity,
  { readonly read: Effect.Effect<AgentActivitySnapshot, AgentActivityReadError> }
>()("t3/orchestration-v2/AgentActivity") {}

const COUNTED_CATEGORIES = new Set([
  "server",
  "resource-monitor",
  "server-child",
  "provider-root",
  "terminal-root",
]);
const CHILD_CATEGORIES = new Set(["server-child", "provider-root", "terminal-root"]);
const MAX_COMMAND_LENGTH = 1000;

function emptyUsage(): { cpuPercent: number; residentBytes: number; processCount: number } {
  return { cpuPercent: 0, residentBytes: 0, processCount: 0 };
}

function addUsage(
  usage: { cpuPercent: number; residentBytes: number; processCount: number },
  process: ResourceTelemetryProcess,
) {
  usage.cpuPercent += process.cpuPercent;
  usage.residentBytes += process.residentBytes;
  usage.processCount += 1;
}

function roundUsage(usage: AgentActivityUsage): AgentActivityUsage {
  return { ...usage, cpuPercent: Math.round(usage.cpuPercent * 10) / 10 };
}

/** Thread tag from a raw `/proc/<pid>/environ` buffer (NUL-separated). */
export function threadTagFromEnviron(environ: string): string | null {
  const prefix = `${AGENT_THREAD_ENV_VAR}=`;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length) || null;
  }
  return null;
}

/**
 * Assigns each child process to a thread: its own tag, else its nearest
 * tagged ancestor within the server's tree.
 */
export function attributeProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  tags: ReadonlyMap<number, string | null>,
): Map<number, string | null> {
  const byPid = new Map(processes.map((process) => [process.identity.pid, process]));
  const owners = new Map<number, string | null>();
  const resolve = (pid: number, seen: Set<number>): string | null => {
    const known = owners.get(pid);
    if (known !== undefined) return known;
    const process = byPid.get(pid);
    if (!process || !CHILD_CATEGORIES.has(process.category) || seen.has(pid)) return null;
    seen.add(pid);
    const owner = tags.get(pid) ?? resolve(process.ppid, seen);
    owners.set(pid, owner);
    return owner;
  };
  for (const process of processes) resolve(process.identity.pid, new Set());
  return owners;
}

function isActiveThread(thread: OrchestrationV2ThreadShell): boolean {
  return (
    thread.archivedAt === null &&
    (thread.activityRunStatus != null ||
      thread.activeRunId !== null ||
      (thread.pendingBackgroundTasks?.length ?? 0) > 0)
  );
}

export function buildAgentActivitySnapshot(input: {
  readonly readAt: DateTime.Utc;
  readonly host: HostResourcesSnapshot;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly tags: ReadonlyMap<number, string | null>;
}): AgentActivitySnapshot {
  const counted = input.processes.filter((process) => COUNTED_CATEGORIES.has(process.category));
  const owners = attributeProcesses(counted, input.tags);
  const total = emptyUsage();
  const unattributed = emptyUsage();
  const owned = new Map<string, ResourceTelemetryProcess[]>();
  for (const process of counted) {
    addUsage(total, process);
    if (!CHILD_CATEGORIES.has(process.category)) continue;
    const owner = owners.get(process.identity.pid) ?? null;
    if (owner === null) {
      addUsage(unattributed, process);
      continue;
    }
    const list = owned.get(owner) ?? [];
    list.push(process);
    owned.set(owner, list);
  }

  const projectTitles = new Map(input.projects.map((project) => [project.id, project.title]));
  const threads: AgentActivityThread[] = [];
  for (const thread of input.threads) {
    const processes = owned.get(thread.id) ?? [];
    if (!isActiveThread(thread) && processes.length === 0) continue;
    const usage = emptyUsage();
    for (const process of processes) addUsage(usage, process);
    const ownedPids = new Set(processes.map((process) => process.identity.pid));
    const depthOf = (process: ResourceTelemetryProcess): number => {
      let depth = 0;
      let parent = process.ppid;
      while (ownedPids.has(parent)) {
        depth += 1;
        parent = processes.find((candidate) => candidate.identity.pid === parent)?.ppid ?? 0;
        if (depth > 64) break;
      }
      return depth;
    };
    threads.push({
      threadId: thread.id,
      projectId: thread.projectId,
      projectTitle: projectTitles.get(thread.projectId) ?? "",
      title: thread.title,
      providerInstanceId: thread.providerInstanceId,
      model: thread.modelSelection.model,
      status: thread.status,
      runStatus: thread.activityRunStatus ?? null,
      runStartedAt: thread.activityRunStartedAt ?? thread.latestRunStartedAt ?? null,
      waitingOnUser: thread.pendingRuntimeRequest !== null,
      backgroundTasks: thread.pendingBackgroundTasks ?? [],
      usage: roundUsage(usage),
      processes: processes
        .toSorted((left, right) => left.identity.startTimeMs - right.identity.startTimeMs)
        .map((process): AgentActivityProcess => ({
          pid: process.identity.pid,
          ppid: process.ppid,
          depth: depthOf(process),
          name: process.name,
          command: process.command.slice(0, MAX_COMMAND_LENGTH),
          cpuPercent: Math.round(process.cpuPercent * 10) / 10,
          residentBytes: process.residentBytes,
          runTimeMs: process.runTimeMs,
        })),
    });
  }
  threads.sort(
    (left, right) =>
      Number(right.runStatus !== null) - Number(left.runStatus !== null) ||
      right.usage.cpuPercent - left.usage.cpuPercent,
  );

  return {
    readAt: input.readAt,
    host: input.host,
    total: roundUsage(total),
    unattributed: roundUsage(unattributed),
    threads,
  };
}

export const make = Effect.fn("makeAgentActivity")(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const hostResources = yield* HostResources.HostResources;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  // Environments are fixed at exec, so a process identity's tag never changes.
  const tagCache = new Map<string, string | null>();

  const readTag = (process: ResourceTelemetryProcess) => {
    const key = `${process.identity.pid}:${process.identity.startTimeMs}`;
    const cached = tagCache.get(key);
    if (cached !== undefined) return Effect.succeed(cached);
    return fileSystem.readFile(`/proc/${process.identity.pid}/environ`).pipe(
      Effect.map((bytes) => threadTagFromEnviron(new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => null),
      Effect.tap((tag) => Effect.sync(() => tagCache.set(key, tag))),
    );
  };

  const read: AgentActivity["Service"]["read"] = Effect.gen(function* () {
    const snapshot = yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
    const children = snapshot.processes.filter((process) => CHILD_CATEGORIES.has(process.category));
    const tags = new Map<number, string | null>();
    if (platform === "linux") {
      yield* Effect.forEach(
        children,
        (child) => readTag(child).pipe(Effect.map((tag) => tags.set(child.identity.pid, tag))),
        { concurrency: 16, discard: true },
      );
      const live = new Set(
        children.map((child) => `${child.identity.pid}:${child.identity.startTimeMs}`),
      );
      for (const key of tagCache.keys()) if (!live.has(key)) tagCache.delete(key);
    }
    const [shell, projects, host, readAt] = yield* Effect.all([
      threadManagement.getShellSnapshot({ location: "active" }),
      projectStore.listShells(),
      hostResources.read,
      DateTime.now,
    ]);
    return buildAgentActivitySnapshot({
      readAt,
      host,
      threads: shell.threads,
      projects,
      processes: snapshot.processes,
      tags,
    });
  }).pipe(Effect.mapError((cause) => new AgentActivityReadError({ cause })));

  return AgentActivity.of({ read });
});

export const layer = Layer.effect(AgentActivity, make());
