import type { AgentActivityProcess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { agentShellCommand, buildAgentProcessTree, findCommandProcessNode } from "./agentActivity";

function proc(pid: number, ppid: number, command: string, residentBytes = 1): AgentActivityProcess {
  return {
    pid,
    ppid,
    startTimeMs: 0,
    depth: 0,
    name: command.split(" ")[0] ?? "",
    command,
    cpuPercent: 1,
    residentBytes,
    runTimeMs: 0,
  };
}

const CLAUDE_SHELL =
  "/bin/bash -c source /home/u/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && eval 'pgrep -af '\\''sleep 900'\\'' || true' < /dev/null && pwd -P >| /tmp/claude-1d68-cwd";

describe("agentShellCommand", () => {
  it("unwraps Claude's eval and plain sh -c, and ignores other processes", () => {
    expect(agentShellCommand(proc(1, 0, CLAUDE_SHELL))).toBe("pgrep -af 'sleep 900' || true");
    expect(agentShellCommand(proc(2, 0, "/bin/bash -lc pnpm test"))).toBe("pnpm test");
    expect(agentShellCommand(proc(3, 0, "node server.js"))).toBeNull();
  });
});

describe("findCommandProcessNode", () => {
  it("finds the shell running a command and totals its subtree", () => {
    const tree = buildAgentProcessTree([
      proc(10, 1, "claude --model haiku"),
      proc(11, 10, CLAUDE_SHELL, 4),
      proc(12, 11, "pgrep -af sleep 900", 6),
    ]);
    const node = findCommandProcessNode(tree, "  pgrep -af 'sleep 900' || true\n");
    expect(node?.process.pid).toBe(11);
    expect(node?.total).toMatchObject({ residentBytes: 10, count: 2 });
    expect(findCommandProcessNode(tree, "ls")).toBeNull();
  });
});
