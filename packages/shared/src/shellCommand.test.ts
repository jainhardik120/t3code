import { describe, expect, it } from "@effect/vitest";

import { parseShellCommand, splitShellOutputSections, type ShellStep } from "./shellCommand.ts";

function runSteps(steps: ReadonlyArray<ShellStep>) {
  return steps.filter((step): step is Extract<ShellStep, { kind: "run" }> => step.kind === "run");
}

describe("parseShellCommand", () => {
  it("lifts a leading cd into the working directory and labels pipe filters", () => {
    const parsed = parseShellCommand(
      'cd /repo/apps/web; grep -rn "command_execution" src --include=*.ts 2>/dev/null | head -20',
    );
    expect(parsed.cwd).toBe("/repo/apps/web");
    const [search] = runSteps(parsed.steps);
    expect(search?.summary).toBe("Search “command_execution” in src");
    expect(search?.filters.map((filter) => filter.label)).toEqual(["first 20 lines"]);
    expect(search?.redirects).toEqual(["2>/dev/null"]);
  });

  it("keeps connectors between chained steps", () => {
    const parsed = parseShellCommand("cd /repo && pnpm test || echo failed");
    const [test, fallback] = runSteps(parsed.steps);
    expect(test?.connector).toBeNull();
    expect(fallback?.connector).toBe("or");
  });

  it("turns heredoc bodies into highlighted scripts", () => {
    const parsed = parseShellCommand("python3 - <<'EOF'\nimport json\nprint(1)\nEOF\necho done");
    const [script, echo] = runSteps(parsed.steps);
    expect(script?.script).toEqual({ language: "python", code: "import json\nprint(1)" });
    expect(echo?.program).toBe("echo");
  });

  it("summarizes file reads", () => {
    const [read] = runSteps(parseShellCommand("sed -n '40,90p' src/app.ts").steps);
    expect(read?.summary).toBe("Read src/app.ts lines 40–90");
  });

  it("parses commands sent over ssh", () => {
    const [ssh] = runSteps(parseShellCommand('ssh box "cd /srv && ls -la"').steps);
    expect(ssh?.nested?.label).toBe("on box");
    expect(ssh?.nested?.command.cwd).toBe("/srv");
  });

  it("groups subshells, marks the backgrounded step, and names truncations", () => {
    const parsed = parseShellCommand(
      ": > /tmp/cdp/daemon.log; (nohup node /tmp/cdp/daemon.mjs > /tmp/cdp/daemon.log 2>&1 &); sleep 1 & wait",
    );
    const [truncate, detached, sleep, wait] = parsed.steps;
    expect(truncate).toMatchObject({ kind: "run", summary: "Empty /tmp/cdp/daemon.log" });
    expect(detached).toMatchObject({ kind: "block", label: "Detached" });
    const [daemon] = runSteps(detached?.kind === "block" ? detached.body : []);
    expect(daemon).toMatchObject({ program: "node", background: true, connector: null });
    expect(sleep).toMatchObject({ program: "sleep", background: true });
    expect(wait).toMatchObject({ program: "wait", connector: null });
    expect(wait).not.toHaveProperty("background");
  });

  it("nests loop bodies under a block", () => {
    const parsed = parseShellCommand("until curl -sf localhost:3000; do sleep 2; done");
    const [block] = parsed.steps;
    expect(block?.kind).toBe("block");
    if (block?.kind !== "block") return;
    expect(block.label).toBe("Until curl -sf localhost:3000");
    expect(runSteps(block.body).map((step) => step.summary)).toEqual(["Wait 2s"]);
  });
});

describe("splitShellOutputSections", () => {
  it("splits output at echoed section markers", () => {
    const parsed = parseShellCommand(
      'echo "=== boot ==="; getprop boot; echo "=== api ==="; getprop sdk',
    );
    const sections = splitShellOutputSections(parsed, "=== boot ===\n1\n=== api ===\n36\n");
    expect(sections.map((section) => [section.title, section.text.trim()])).toEqual([
      ["boot", "1"],
      ["api", "36"],
    ]);
  });
});
