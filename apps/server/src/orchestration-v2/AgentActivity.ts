// Per-thread processes: the Claude adapter sets T3CODE_THREAD_ID on its CLI and descendants
// inherit it via /proc/<pid>/environ; the agent's systemd scope also catches processes it
// detached or that rewrote their environment (Chrome). Shared provider servers stay untagged.
// Without /proc (macOS, Windows) nothing is attributed.
import type {
  AgentActivityProcess,
  AgentActivitySnapshot,
  AgentActivityThread,
  AgentActivityUsage,
  HostResourcesSnapshot,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ResourceTelemetryProcess,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const AGENT_THREAD_ENV_VAR = "T3CODE_THREAD_ID";

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
  {
    readonly read: Effect.Effect<AgentActivitySnapshot, AgentActivityReadError>;
    /** Signals a process in an agent scope; None when the pid is not one, so callers can fall back. */
    readonly signalScopedProcess: (input: {
      readonly pid: number;
      readonly startTimeMs: number;
      readonly signal: ServerProcessSignal;
    }) => Effect.Effect<Option.Option<ServerSignalProcessResult>>;
  }
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
// USER_HZ is 100 on every mainstream Linux build and is not exposed to Node.
const CLOCK_TICKS_PER_SECOND = 100;

type ActivityProcess = Pick<
  ResourceTelemetryProcess,
  | "identity"
  | "ppid"
  | "category"
  | "name"
  | "command"
  | "cpuPercent"
  | "residentBytes"
  | "runTimeMs"
>;

/** Fields of `/proc/<pid>/stat`; the name is parenthesized and may contain spaces. */
export function parseProcStat(text: string) {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (![ppid, cpuTicks, startTicks].every(Number.isFinite)) return null;
  return { name: text.slice(open + 1, close), ppid, cpuTicks, startTicks };
}

/** Matches the native monitor, which reports start times in whole seconds. */
export function procStartTimeMs(bootTimeSeconds: number, startTicks: number): number {
  return (bootTimeSeconds + Math.floor(startTicks / CLOCK_TICKS_PER_SECOND)) * 1_000;
}

/**
 * A scope holds one thread's agent, so its untagged members belong to that thread:
 * Chrome overwrites its environment, so its tag is unreadable. Scopes with no
 * tagged member, or several owners, are left as tagged.
 */
export function withScopeOwners(
  scopes: ReadonlyArray<{ readonly pids: ReadonlyArray<number> }>,
  tags: ReadonlyMap<number, string | null>,
): Map<number, string | null> {
  const owned = new Map(tags);
  for (const scope of scopes) {
    const owners = new Set(scope.pids.flatMap((pid) => tags.get(pid) ?? []));
    const [owner] = owners;
    if (owners.size !== 1 || owner === undefined) continue;
    for (const pid of scope.pids) if ((owned.get(pid) ?? null) === null) owned.set(pid, owner);
  }
  return owned;
}

function emptyUsage(): { cpuPercent: number; residentBytes: number; processCount: number } {
  return { cpuPercent: 0, residentBytes: 0, processCount: 0 };
}

function addUsage(
  usage: { cpuPercent: number; residentBytes: number; processCount: number },
  process: ActivityProcess,
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
  processes: ReadonlyArray<ActivityProcess>,
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
  readonly processes: ReadonlyArray<ActivityProcess>;
  readonly tags: ReadonlyMap<number, string | null>;
  readonly sessions: ReadonlyArray<ProviderSessionManager.LiveProviderSession>;
}): AgentActivitySnapshot {
  const counted = input.processes.filter((process) => COUNTED_CATEGORIES.has(process.category));
  const owners = attributeProcesses(counted, input.tags);
  const total = emptyUsage();
  const unattributed = emptyUsage();
  const owned = new Map<string, ActivityProcess[]>();
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

  // A shared session (Codex app-server) lists every thread it serves.
  const sessionByThread = new Map(
    input.sessions.flatMap((session) => session.threadIds.map((id) => [id, session] as const)),
  );
  const projectTitles = new Map(input.projects.map((project) => [project.id, project.title]));
  const threads: AgentActivityThread[] = [];
  for (const thread of input.threads) {
    const processes = owned.get(thread.id) ?? [];
    const session = sessionByThread.get(thread.id);
    if (!isActiveThread(thread) && processes.length === 0 && session === undefined) continue;
    const usage = emptyUsage();
    for (const process of processes) addUsage(usage, process);
    const ownedPids = new Set(processes.map((process) => process.identity.pid));
    const depthOf = (process: ActivityProcess): number => {
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
      session:
        session === undefined
          ? null
          : {
              busy: session.busy,
              releaseAt:
                session.releaseAtMs === null ? null : DateTime.makeUnsafe(session.releaseAtMs),
              pinned: session.pinned,
            },
      usage: roundUsage(usage),
      processes: processes
        .toSorted((left, right) => left.identity.startTimeMs - right.identity.startTimeMs)
        .map((process): AgentActivityProcess => ({
          pid: process.identity.pid,
          startTimeMs: process.identity.startTimeMs,
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

const make = Effect.fn("makeAgentActivity")(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const hostResources = yield* HostResources.HostResources;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const agentScope = yield* AgentScope;
  // Environments are fixed at exec, so a process identity's tag never changes.
  const tagCache = new Map<string, string | null>();

  const readTag = (process: ActivityProcess) => {
    const key = `${process.identity.pid}:${process.identity.startTimeMs}`;
    const cached = tagCache.get(key);
    if (cached !== undefined) return Effect.succeed(cached);
    return fileSystem.readFile(`/proc/${process.identity.pid}/environ`).pipe(
      Effect.map((bytes) => threadTagFromEnviron(new TextDecoder().decode(bytes))),
      Effect.orElseSucceed(() => null),
      Effect.tap((tag) => Effect.sync(() => tagCache.set(key, tag))),
    );
  };

  const readProcText = (pid: number, file: string) =>
    fileSystem.readFileString(`/proc/${pid}/${file}`).pipe(Effect.option);
  const bootTimeSeconds = yield* Effect.cached(
    fileSystem.readFileString("/proc/stat").pipe(
      Effect.option,
      Effect.map((text) =>
        Option.flatMap(text, (value) => {
          const match = /^btime (\d+)$/m.exec(value);
          return match ? Option.some(Number(match[1])) : Option.none();
        }),
      ),
    ),
  );
  const readStat = Effect.fn("AgentActivity.readStat")(function* (pid: number) {
    const boot = yield* bootTimeSeconds;
    const text = yield* readProcText(pid, "stat");
    if (Option.isNone(boot) || Option.isNone(text)) return null;
    const stat = parseProcStat(text.value);
    return stat === null
      ? null
      : { ...stat, startTimeMs: procStartTimeMs(boot.value, stat.startTicks) };
  });
  const cpuSamples = new Map<string, { cpuTicks: number; atMs: number }>();

  const sampleProcess = (pid: number, nowMs: number) =>
    Effect.all([readStat(pid), readProcText(pid, "status"), readProcText(pid, "cmdline")]).pipe(
      Effect.map(([stat, status, cmdline]): ActivityProcess | null => {
        if (stat === null) return null;
        const key = `${pid}:${stat.startTimeMs}`;
        const previous = cpuSamples.get(key);
        cpuSamples.set(key, { cpuTicks: stat.cpuTicks, atMs: nowMs });
        const elapsedMs = previous === undefined ? 0 : nowMs - previous.atMs;
        const rssKb = Option.match(status, {
          onNone: () => 0,
          onSome: (text) => Number(/^VmRSS:\s+(\d+)/m.exec(text)?.[1] ?? 0),
        });
        return {
          identity: { pid, startTimeMs: stat.startTimeMs },
          ppid: stat.ppid,
          category: "server-child",
          name: stat.name,
          command: Option.match(cmdline, {
            onNone: () => stat.name,
            onSome: (text) => text.replaceAll("\0", " ").trim() || stat.name,
          }),
          cpuPercent:
            previous !== undefined && elapsedMs > 0
              ? (((stat.cpuTicks - previous.cpuTicks) * 1_000) /
                  CLOCK_TICKS_PER_SECOND /
                  elapsedMs) *
                100
              : 0,
          residentBytes: rssKb * 1024,
          runTimeMs: Math.max(0, nowMs - stat.startTimeMs),
        };
      }),
    );

  // Parents outside every scope that are not reapers moved themselves out, as Chrome's
  // browser process does into its own app scope; they still belong to the scope's thread.
  const escapedParents = Effect.fn("AgentActivity.escapedParents")(function* (
    members: ReadonlyArray<{ readonly pid: number; readonly ppid: number }>,
    excluded: ReadonlySet<number>,
  ) {
    const candidates = [...new Set(members.map((member) => member.ppid))].filter(
      (pid) => pid > 1 && !excluded.has(pid),
    );
    const stats = yield* Effect.forEach(candidates, (pid) =>
      readStat(pid).pipe(Effect.map((stat) => ({ pid, stat }))),
    );
    return stats.flatMap(({ pid, stat }) =>
      stat !== null && stat.name !== "systemd" ? [pid] : [],
    );
  });

  /** Scope members the server-tree telemetry misses, plus their escaped parents. */
  const readDetachedProcesses = Effect.fn("AgentActivity.readDetachedProcesses")(function* (
    known: ReadonlySet<number>,
    nowMs: number,
  ) {
    const scopes = yield* agentScope.scopeProcesses;
    const scopePids = new Set(scopes.flatMap((scope) => scope.pids));
    const sampled = yield* Effect.forEach(
      [...scopePids].filter((pid) => !known.has(pid)),
      (pid) => sampleProcess(pid, nowMs),
      { concurrency: 16 },
    );
    const members = sampled.filter((process) => process !== null);
    const parents = yield* escapedParents(
      members.map((member) => ({ pid: member.identity.pid, ppid: member.ppid })),
      new Set([...known, ...scopePids]),
    );
    const parentProcesses = (yield* Effect.forEach(parents, (pid) =>
      sampleProcess(pid, nowMs),
    )).filter((process) => process !== null);
    const detached = [...members, ...parentProcesses];
    const live = new Set(
      detached.map((process) => `${process.identity.pid}:${process.identity.startTimeMs}`),
    );
    for (const key of cpuSamples.keys()) if (!live.has(key)) cpuSamples.delete(key);
    const parentScope = new Map(
      parentProcesses.map((parent) => [
        parent.identity.pid,
        scopes.find((scope) =>
          members.some(
            (member) =>
              member.ppid === parent.identity.pid && scope.pids.includes(member.identity.pid),
          ),
        ),
      ]),
    );
    return {
      detached,
      scopes: scopes.map((scope) => ({
        pids: [...scope.pids, ...parents.filter((pid) => parentScope.get(pid) === scope)],
      })),
    };
  });

  const read: AgentActivity["Service"]["read"] = Effect.gen(function* () {
    const snapshot = yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
    const { detached, scopes } =
      platform === "linux"
        ? yield* readDetachedProcesses(
            new Set(snapshot.processes.map((process) => process.identity.pid)),
            DateTime.toEpochMillis(yield* DateTime.now),
          )
        : { detached: [], scopes: [] };
    const processes = [...snapshot.processes, ...detached];
    const children = processes.filter((process) => CHILD_CATEGORIES.has(process.category));
    const environTags = new Map<number, string | null>();
    if (platform === "linux") {
      yield* Effect.forEach(
        children,
        (child) =>
          readTag(child).pipe(Effect.map((tag) => environTags.set(child.identity.pid, tag))),
        { concurrency: 16, discard: true },
      );
      const live = new Set(
        children.map((child) => `${child.identity.pid}:${child.identity.startTimeMs}`),
      );
      for (const key of tagCache.keys()) if (!live.has(key)) tagCache.delete(key);
    }
    const tags = withScopeOwners(scopes, environTags);
    const [shell, projects, host, readAt, sessions] = yield* Effect.all([
      threadManagement.getShellSnapshot({ location: "active" }),
      projectStore.listShells(),
      hostResources.read,
      DateTime.now,
      providerSessions.liveSessions,
    ]);
    return buildAgentActivitySnapshot({
      readAt,
      host,
      threads: shell.threads,
      projects,
      processes,
      tags,
      sessions,
    });
  }).pipe(Effect.mapError((cause) => new AgentActivityReadError({ cause })));

  const signalScopedProcess: AgentActivity["Service"]["signalScopedProcess"] = Effect.fn(
    "AgentActivity.signalScopedProcess",
  )(function* (input) {
    if (platform !== "linux" || input.pid === process.pid) return Option.none();
    const scopePids = (yield* agentScope.scopeProcesses).flatMap((scope) => scope.pids);
    const inScope =
      scopePids.includes(input.pid) ||
      (yield* Effect.forEach(scopePids, readStat)).some((stat) => stat?.ppid === input.pid);
    if (!inScope) return Option.none();
    const stat = yield* readStat(input.pid);
    // Orphans' parent is the user manager; never offer it as an escaped parent.
    if (stat?.name === "systemd") return Option.none();
    if (stat === null || stat.startTimeMs !== input.startTimeMs) {
      return Option.some({
        pid: input.pid,
        signal: input.signal,
        signaled: false,
        message: Option.some(
          `Process ${input.pid} no longer matches the selected process identity.`,
        ),
      });
    }
    return Option.some(
      yield* Effect.try(() => process.kill(input.pid, input.signal)).pipe(
        Effect.as({
          pid: input.pid,
          signal: input.signal,
          signaled: true,
          message: Option.none(),
        }),
        Effect.catch((error) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some(error.message),
          }),
        ),
      ),
    );
  });

  return AgentActivity.of({ read, signalScopedProcess });
});

export const layer = Layer.effect(AgentActivity, make());
