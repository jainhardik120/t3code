import type { AgentActivityProcess } from "@t3tools/contracts";
import type { ShellStep } from "@t3tools/shared/shellCommand";

type RunStep = Extract<ShellStep, { kind: "run" }>;

/** Run steps keyed by their position (`2`, `3.0`), descending into blocks. */
function flattenRunSteps(
  steps: ReadonlyArray<ShellStep>,
  prefix = "",
): Array<{ path: string; step: RunStep }> {
  return steps.flatMap((step, index) => {
    const path = `${prefix}${index}`;
    if (step.kind === "run") return [{ path, step }];
    if (step.kind !== "block") return [];
    return [
      ...flattenRunSteps(step.body, `${path}.`),
      ...flattenRunSteps(step.elseBody ?? [], `${path}.e`),
    ];
  });
}

const WRAPPERS = new Set(["nohup", "setsid", "nice", "env", "stdbuf", "time", "timeout"]);

/** A process's argv with launch wrappers (`timeout 250`, `nohup`, `env X=1`) removed. */
function commandWords(process: AgentActivityProcess): string[] {
  const words = process.command.split(/\s+/).filter(Boolean);
  let index = 0;
  while (index < words.length) {
    const word = words[index]!;
    const name = word.split("/").pop()!;
    if (WRAPPERS.has(name)) {
      const isTimeout = name === "timeout";
      index += 1;
      // timeout's duration, env's assignments, and wrapper flags precede the command.
      const isPrefixArgument = (arg: string) =>
        arg.startsWith("-") || arg.includes("=") || (isTimeout && /^\d/.test(arg));
      while (index < words.length && isPrefixArgument(words[index]!)) index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

/**
 * Which step each process is running: same program, preferring the step whose
 * literal arguments it carries. Expanded `$vars` cannot be compared, so they are skipped.
 */
export function matchProcessesToSteps(
  steps: ReadonlyArray<ShellStep>,
  processes: ReadonlyArray<AgentActivityProcess>,
): Map<AgentActivityProcess, string> {
  const runSteps = flattenRunSteps(steps);
  const matches = new Map<AgentActivityProcess, string>();
  for (const process of processes) {
    const words = commandWords(process);
    const program = words[0]?.split("/").pop();
    if (program === undefined) continue;
    const argv = new Set(words);
    let best: { path: string; score: number } | undefined;
    for (const { path, step } of runSteps) {
      if (step.program !== program) continue;
      const score = step.words
        .slice(1)
        .filter((word) => !word.value.includes("$") && argv.has(word.value)).length;
      if (best === undefined || score > best.score) best = { path, score };
    }
    if (best !== undefined) matches.set(process, best.path);
  }
  // A wrapper (`timeout`) and the program it launched are one run of the step.
  const pathByPid = new Map([...matches].map(([process, path]) => [process.pid, path]));
  for (const [process, path] of matches) {
    if (pathByPid.get(process.ppid) === path) matches.delete(process);
  }
  return matches;
}
