import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  type AgentActivityProcess,
  type AgentActivityThread,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { serverEnvironment } from "./server";
import { useEnvironmentScope } from "./session";

export type AgentActivityThreadSample = AgentActivityThread & { readonly readAtMs: number };

const EMPTY_THREAD_ATOM = Atom.make<AgentActivityThreadSample | null>(null).pipe(
  Atom.withLabel("web-agent-activity:empty"),
);
const EMPTY_SUMMARY_ATOM = Atom.make<AgentActivitySummary | null>(null).pipe(
  Atom.withLabel("web-agent-activity-summary:empty"),
);

const activityKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}\u0000${threadId}`;

function parseActivityKey(key: string) {
  const [environmentId, threadId] = key.split("\u0000") as [EnvironmentId, ThreadId];
  return { environmentId, threadId };
}

const threadActivityAtomFamily = Atom.family((key: string) => {
  const { environmentId, threadId } = parseActivityKey(key);
  return Atom.make((get) => {
    const snapshot = Option.getOrNull(
      AsyncResult.value(get(serverEnvironment.agentActivity({ environmentId, input: {} }))),
    );
    const thread = snapshot?.threads.find((candidate) => candidate.threadId === threadId);
    // The sample time lets views show "releases in" without reading the clock during render.
    return thread === undefined || snapshot === null
      ? null
      : { ...thread, readAtMs: DateTime.toEpochMillis(snapshot.readAt) };
  }).pipe(Atom.withLabel(`web-agent-activity:${key}`));
});

/** What a sidebar row shows. Compared by value so rows skip renders on unchanged ticks. */
export interface AgentActivitySummary {
  readonly label: string;
  readonly processCount: number;
  readonly warm: boolean;
}

const summaryAtomFamily = Atom.family((key: string) => {
  let previous: AgentActivitySummary | null = null;
  return Atom.make((get) => {
    const thread = get(threadActivityAtomFamily(key));
    const next =
      thread === null || thread.usage.processCount === 0
        ? null
        : {
            label: `${formatActivityBytes(thread.usage.residentBytes)} · ${formatActivityCpu(thread.usage.cpuPercent)}`,
            processCount: thread.usage.processCount,
            warm: thread.runStatus === null,
          };
    if (
      previous !== null &&
      next !== null &&
      previous.label === next.label &&
      previous.processCount === next.processCount &&
      previous.warm === next.warm
    ) {
      return previous;
    }
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`web-agent-activity-summary:${key}`));
});

/** Live process tree and warm-session state for one thread; re-samples every few seconds. */
export function useThreadAgentActivity(environmentId: EnvironmentId, threadId: ThreadId) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useAtomValue(
    canRead ? threadActivityAtomFamily(activityKey(environmentId, threadId)) : EMPTY_THREAD_ATOM,
  );
}

export function useThreadAgentActivitySummary(environmentId: EnvironmentId, threadId: ThreadId) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return useAtomValue(
    canRead ? summaryAtomFamily(activityKey(environmentId, threadId)) : EMPTY_SUMMARY_ATOM,
  );
}

export function formatActivityBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function formatActivityCpu(percent: number): string {
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

/** "releases in 24m" for a warm session, null while a turn runs. */
export function formatSessionRelease(thread: AgentActivityThread, nowMs: number): string | null {
  const releaseAt = thread.session?.releaseAt;
  if (!releaseAt || thread.session?.busy) return null;
  const minutes = Math.max(0, Math.round((DateTime.toEpochMillis(releaseAt) - nowMs) / 60_000));
  const when = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return thread.session.pinned ? `kept for background work, up to ${when}` : `releases in ${when}`;
}

/**
 * T3's launcher leaves a subshell that kills the agent's process group if the server goes
 * away (process/agentScope.ts). Signaling it stops the agent; Stop does that cleanly.
 */
export function isAgentGuardProcess(process: AgentActivityProcess): boolean {
  return process.command.includes("kill -TERM 0") && process.command.includes("trap ''");
}

/** Agent shells wrap each command in a snapshot loader; show the command itself. */
export function agentProcessLabel(process: AgentActivityProcess): string {
  if (isAgentGuardProcess(process)) return "T3 process guard";
  const command = process.command || process.name;
  const evaled = /\beval '((?:[^']|'\\'')*)'/.exec(command);
  if (evaled) return `$ ${evaled[1]!.replaceAll("'\\''", "'")}`;
  if (/^(\S*\/)?claude(\s|$)/.test(command)) {
    const model = /--model\s+(\S+)/.exec(command)?.[1];
    return model ? `claude · ${model.replace(/^claude-/, "")}` : "claude";
  }
  const npx = /npm exec (\S+)/.exec(command)?.[1];
  if (npx) return `mcp: ${npx.replace(/@[^@/]*$/, "")}`;
  const [bin = "", ...rest] = command.split(/\s+/);
  return [bin.split("/").pop(), ...rest].join(" ");
}

export interface AgentProcessNode {
  readonly process: AgentActivityProcess;
  readonly children: ReadonlyArray<AgentProcessNode>;
  /** This process plus every descendant. */
  readonly total: {
    readonly cpuPercent: number;
    readonly residentBytes: number;
    readonly count: number;
  };
}

/** Nests a thread's processes by parent pid; processes whose parent is not listed become roots. */
export function buildAgentProcessTree(
  processes: ReadonlyArray<AgentActivityProcess>,
): ReadonlyArray<AgentProcessNode> {
  const pids = new Set(processes.map((process) => process.pid));
  const childrenOf = new Map<number, AgentActivityProcess[]>();
  for (const process of processes) {
    if (!pids.has(process.ppid) || process.ppid === process.pid) continue;
    const siblings = childrenOf.get(process.ppid) ?? [];
    siblings.push(process);
    childrenOf.set(process.ppid, siblings);
  }
  const build = (process: AgentActivityProcess, seen: ReadonlySet<number>): AgentProcessNode => {
    const nextSeen = new Set(seen).add(process.pid);
    const children = (childrenOf.get(process.pid) ?? [])
      .filter((child) => !nextSeen.has(child.pid))
      .map((child) => build(child, nextSeen));
    return {
      process,
      children,
      total: children.reduce(
        (sum, child) => ({
          cpuPercent: sum.cpuPercent + child.total.cpuPercent,
          residentBytes: sum.residentBytes + child.total.residentBytes,
          count: sum.count + child.total.count,
        }),
        { cpuPercent: process.cpuPercent, residentBytes: process.residentBytes, count: 1 },
      ),
    };
  };
  return processes
    .filter((process) => !pids.has(process.ppid) || process.ppid === process.pid)
    .map((process) => build(process, new Set()));
}
