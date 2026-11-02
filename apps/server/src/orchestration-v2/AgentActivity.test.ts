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
  parseProcStat,
  procStartTimeMs,
  threadTagFromEnviron,
  withScopeOwners,
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

describe("parseProcStat", () => {
  it("reads ppid, cpu ticks and start ticks past a name with spaces and parens", () => {
    const stat =
      "20735 (next-server (v16.3.8)) S 20718 20674 20674 0 -1 4194304 1 0 0 0 1200 300 0 0 20 0 11 0 3601234 1 2 3";
    expect(parseProcStat(stat)).toEqual({
      name: "next-server (v16.3.8)",
      ppid: 20718,
      cpuTicks: 1500,
      startTicks: 3601234,
    });
    expect(parseProcStat("garbage")).toBeNull();
    // Whole seconds, like the native monitor, so kill identities match.
    expect(procStartTimeMs(1_793_570_000, 3601234)).toBe((1_793_570_000 + 36012) * 1000);
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
      proc(6, 99, "server-child"), // detached dev server, re-parented to the user manager
      proc(7, 6, "server-child"), // its worker
    ];
    const owners = attributeProcesses(
      processes,
      new Map([
        [2, "t-1"],
        [3, null],
        [4, null],
        [5, null],
        [6, "t-1"],
        [7, null],
      ]),
    );
    expect(owners.get(2)).toBe("t-1");
    expect(owners.get(4)).toBe("t-1");
    expect(owners.get(5)).toBeNull();
    expect(owners.get(7)).toBe("t-1");
    expect(owners.has(1)).toBe(false);
  });
});

describe("withScopeOwners", () => {
  it("gives untagged scope members the scope's thread and leaves ambiguous scopes alone", () => {
    const tags = withScopeOwners(
      [
        { pids: [10, 11, 12] }, // claude (tagged), chrome renderer and escaped browser (untagged)
        { pids: [20, 21] }, // shared app-server: nobody tagged
        { pids: [30, 31, 32] }, // two owners
      ],
      new Map([
        [10, "t-1"],
        [11, null],
        [20, null],
        [30, "t-2"],
        [31, "t-3"],
      ]),
    );
    expect(tags.get(11)).toBe("t-1");
    expect(tags.get(12)).toBe("t-1");
    expect(tags.get(21)).toBeUndefined();
    expect(tags.get(32)).toBeUndefined();
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
        thread("idle-warm"),
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
      sessions: [
        {
          providerSessionId: "session-1" as never,
          threadIds: ["idle-warm" as never],
          busy: false,
          releaseAtMs: DateTime.toEpochMillis(NOW) + 60_000,
          pinned: false,
        },
      ],
    });

    expect(snapshot.threads.map((entry) => entry.threadId)).toEqual([
      "running",
      "idle-with-process",
      "idle-warm",
    ]);
    expect(snapshot.threads[2]!.session?.releaseAt).toEqual(DateTime.add(NOW, { minutes: 1 }));
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
