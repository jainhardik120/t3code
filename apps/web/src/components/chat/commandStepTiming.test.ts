import type { AgentActivityProcess } from "@t3tools/contracts";
import { parseShellCommand } from "@t3tools/shared/shellCommand";
import { describe, expect, it } from "vite-plus/test";

import { matchProcessesToSteps } from "./commandStepTiming";

function proc(pid: number, command: string, ppid = 1): AgentActivityProcess {
  return {
    pid,
    ppid,
    startTimeMs: 0,
    depth: 0,
    name: "",
    command,
    cpuPercent: 0,
    residentBytes: 0,
    runTimeMs: 0,
  };
}

describe("matchProcessesToSteps", () => {
  it("matches through wrappers, inside loops, and by literal arguments", () => {
    const { steps } = parseShellCommand(
      "P=x; timeout 250 adb -s $P install -r /tmp/app.apk 2>&1 | tail -1; for i in 1 2; do grep -q ready /tmp/a.log && break; sleep 1; done; grep -c error /tmp/b.log",
    );
    const adb = proc(1, "timeout 250 adb -s x install -r /tmp/app.apk", 9);
    const sleep = proc(2, "sleep 1");
    const errors = proc(3, "grep -c error /tmp/b.log");
    const node = proc(4, "node server.js");
    const adbChild = proc(5, "adb -s x install -r /tmp/app.apk", 1);
    const matches = matchProcessesToSteps(steps, [adb, sleep, errors, node, adbChild]);
    expect(matches.get(adb)).toBe("0");
    expect(matches.get(sleep)).toBe("1.2");
    expect(matches.get(errors)).toBe("2");
    expect(matches.has(node)).toBe(false);
    // `timeout` and the adb it launched are one run of the step.
    expect(matches.has(adbChild)).toBe(false);
  });
});
