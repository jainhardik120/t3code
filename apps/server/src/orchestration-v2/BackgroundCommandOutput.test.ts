import { describe, expect, it } from "@effect/vitest";

import { backgroundOutputPath } from "./BackgroundCommandOutput.ts";

const TASK =
  "/tmp/claude-1000/-home-me/b8b26c9c-5fef-4e57-ad10-70e9fcb4e98c/tasks/b0xjyj2of.output";

describe("backgroundOutputPath", () => {
  it("reads the task file from Claude's background notice", () => {
    expect(
      backgroundOutputPath(
        `Command running in background with ID: b0xjyj2of. Output is being written to: ${TASK}. You will be notified when it completes.`,
      ),
    ).toBe(TASK);
  });

  it("refuses paths outside Claude's task directories", () => {
    for (const path of [
      "/etc/passwd.output",
      "/tmp/claude-1000/-home-me/session/tasks/../../../../etc/x.output",
      "/home/me/.ssh/tasks/id.output",
    ]) {
      expect(backgroundOutputPath(`Output is being written to: ${path}.`)).toBeNull();
    }
    expect(backgroundOutputPath("plain command output")).toBeNull();
  });
});
