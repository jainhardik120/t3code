import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ResourceTelemetryProcess,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  attributeProcesses,
  buildAgentActivitySnapshot,
  threadTagFromEnviron,
} from "./AgentActivity.ts";

const NOW = DateTime.makeUnsafe("2026-11-01T06:00:00.000Z");

function proc(
  pid: number,
  ppid: number,
  category: ResourceTelemetryProcess["category"],
  cpuPercent = 1,
): ResourceTelemetryProcess {
  return {
    identity: { pid, startTimeMs: pid * 10 },
    ppid,
    childPids: [],
    depth: 0,
    name: `p${pid}`,
    command: `cmd ${pid}`,
    status: "S",
    category,
    cpuPercent,
    cpuTimeMs: 0,
    residentBytes: 1000,
    peakResidentBytes: 1000,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    ioSemantics: "unavailable",
    runTimeMs: 5000,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  } as ResourceTelemetryProcess;
}

function thread(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    providerInstanceId: "claudeAgent",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    status: "idle",
    activeRunId: null,
    activityRunStatus: null,
    activityRunStartedAt: null,
    latestRunStartedAt: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    archivedAt: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
}

const projects = [{ id: "project-1", title: "T3 Code" }] as unknown as OrchestrationProjectShell[];
const host = {
  sampledAt: 0,
  cpuUtilization: 0.5,
  cpuCount: 8,
  availableMemoryBytes: 1,
  totalMemoryBytes: 2,
};

describe("threadTagFromEnviron", () => {
  it("reads the thread id from a NUL-separated environment", () => {
    expect(threadTagFromEnviron("HOME=/h\0T3CODE_THREAD_ID=t-1\0PATH=/bin")).toBe("t-1");
    expect(threadTagFromEnviron("HOME=/h\0PATH=/bin")).toBeNull();
  });
});

describe("attributeProcesses", () => {
  it("gives untagged descendants their nearest tagged ancestor's thread", () => {
    const processes = [
      proc(1, 0, "server"),
      proc(2, 1, "server-child"), // claude, tagged
      proc(3, 2, "server-child"), // bash, env cleared
      proc(4, 3, "server-child"), // pnpm, inherits through bash
      proc(5, 1, "server-child"), // shared helper, untagged
    ];
    const owners = attributeProcesses(
      processes,
      new Map([
        [2, "t-1"],
        [3, null],
        [4, null],
        [5, null],
      ]),
    );
    expect(owners.get(2)).toBe("t-1");
    expect(owners.get(4)).toBe("t-1");
    expect(owners.get(5)).toBeNull();
    expect(owners.has(1)).toBe(false);
  });
});

describe("buildAgentActivitySnapshot", () => {
  it("lists running threads and threads that still own processes, with their usage", () => {
    const snapshot = buildAgentActivitySnapshot({
      readAt: NOW,
      host,
      projects,
      threads: [
        thread("running", { activityRunStatus: "running", activeRunId: "run-1" as never }),
        thread("idle-with-process"),
        thread("idle"),
      ],
      processes: [
        proc(1, 0, "server", 2),
        proc(2, 1, "server-child", 10),
        proc(3, 2, "server-child", 5),
        proc(4, 1, "server-child", 7),
        proc(5, 1, "server-child", 1),
      ],
      tags: new Map([
        [2, "running"],
        [3, null],
        [4, "idle-with-process"],
        [5, null],
      ]),
    });

    expect(snapshot.threads.map((entry) => entry.threadId)).toEqual([
      "running",
      "idle-with-process",
    ]);
    const running = snapshot.threads[0]!;
    expect(running.usage).toEqual({ cpuPercent: 15, residentBytes: 2000, processCount: 2 });
    expect(running.processes.map((entry) => [entry.pid, entry.depth])).toEqual([
      [2, 0],
      [3, 1],
    ]);
    expect(running.projectTitle).toBe("T3 Code");
    expect(snapshot.unattributed).toEqual({ cpuPercent: 1, residentBytes: 1000, processCount: 1 });
    expect(snapshot.total.processCount).toBe(5);
  });
});
