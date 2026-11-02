/**
 * Tolerant shell parser for showing agent-written commands to humans. Not a shell:
 * it recognizes the shapes agents write and leaves the rest as raw text, so callers
 * must always offer the raw command alongside.
 */

export interface ShellWord {
  /** Source text, quotes included. */
  readonly raw: string;
  /** Unquoted value, without expansions applied. */
  readonly value: string;
}

export interface ShellScript {
  readonly language: string;
  readonly code: string;
}

export type ShellConnector = "and" | "or" | null;

export interface ShellPipelineStage {
  readonly words: ReadonlyArray<ShellWord>;
  readonly redirects: ReadonlyArray<string>;
  readonly heredoc?: string;
  readonly raw: string;
}

export interface ShellRunStep {
  readonly kind: "run";
  /** How this step relates to the previous one. `null` means sequential. */
  readonly connector: ShellConnector;
  readonly program: string;
  /** Main stage words with wrappers and env prefixes removed. */
  readonly words: ReadonlyArray<ShellWord>;
  readonly env: ReadonlyArray<string>;
  readonly wrappers: ReadonlyArray<string>;
  readonly redirects: ReadonlyArray<string>;
  readonly filters: ReadonlyArray<ShellFilter>;
  readonly summary?: string;
  readonly script?: ShellScript;
  /** Commands run somewhere else: `ssh host "…"`, `bash -c "…"`, `docker exec … sh -c`. */
  readonly nested?: { readonly label: string; readonly command: ParsedShellCommand };
  /** Ended with `&`: the shell moves on without waiting. */
  readonly background?: true;
  readonly raw: string;
}

export interface ShellFilter {
  readonly label: string;
  readonly raw: string;
}

export interface ShellSectionStep {
  readonly kind: "section";
  readonly title: string;
  /** The exact line the echo prints, for locating the section in output. */
  readonly marker: string;
  readonly raw: string;
}

export interface ShellAssignStep {
  readonly kind: "assign";
  readonly connector: ShellConnector;
  readonly assignments: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly background?: true;
  readonly raw: string;
}

export interface ShellBlockStep {
  readonly kind: "block";
  readonly connector: ShellConnector;
  readonly label: string;
  readonly body: ReadonlyArray<ShellStep>;
  readonly elseBody?: ReadonlyArray<ShellStep>;
  readonly background?: true;
  readonly raw: string;
}

export type ShellStep = ShellRunStep | ShellSectionStep | ShellAssignStep | ShellBlockStep;

export interface ParsedShellCommand {
  /** Directory from a leading `cd`, which agents use to set the working directory. */
  readonly cwd?: string;
  /** Variables assigned before the first command. */
  readonly variables: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly steps: ReadonlyArray<ShellStep>;
}

type Token =
  | {
      readonly type: "word";
      readonly word: ShellWord;
      readonly start: number;
      readonly end: number;
    }
  | { readonly type: "op"; readonly op: string; readonly start: number; readonly end: number }
  | {
      readonly type: "heredoc";
      readonly body: string;
      readonly start: number;
      readonly end: number;
    };

const OPERATORS = ["&&", "||", ";;", ";", "|&", "|", "&", "\n"] as const;
const REDIRECT_PATTERN = /^(\d*|&)(>>?|<|>&|<&)(&?\d+|-)?$/;
const REDIRECT_WITH_TARGET = /^(\d*|&)(>>?|<|>&|<&)(.+)$/;

/** End of a `$(…)` or `${…}` starting at `start`, skipping nested quotes and substitutions. */
function substitutionEnd(source: string, start: number): number {
  const close = source[start + 1] === "{" ? "}" : ")";
  const open = close === "}" ? "{" : "(";
  let depth = 0;
  let index = start + 1;
  while (index < source.length) {
    const c = source[index]!;
    if (c === "\\") {
      index += 2;
      continue;
    }
    if (c === "'" && close === ")") {
      const end = source.indexOf("'", index + 1);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (c === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 2;
        else if (source[index] === "$" && "({".includes(source[index + 1] ?? "")) {
          index = substitutionEnd(source, index);
        } else index += 1;
      }
      index += 1;
      continue;
    }
    if (c === "$" && "({".includes(source[index + 1] ?? "")) {
      index = substitutionEnd(source, index);
      continue;
    }
    if (c === open) depth += 1;
    if (c === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean; at: number }> = [];
  let index = 0;

  const readHeredocBodies = () => {
    for (const pending of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      const bodyStart = index;
      while (index < source.length) {
        const newline = source.indexOf("\n", index);
        const end = newline === -1 ? source.length : newline;
        const line = source.slice(index, end);
        index = newline === -1 ? source.length : newline + 1;
        const candidate = pending.stripTabs ? line.replace(/^\t+/, "") : line;
        if (candidate.trimEnd() === pending.delimiter) break;
        lines.push(candidate);
      }
      tokens.push({ type: "heredoc", body: lines.join("\n"), start: bodyStart, end: index });
    }
  };

  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\" && source[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "#") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline;
      continue;
    }
    // `(( i++ ))` is arithmetic, not two subshells.
    if (source.startsWith("((", index)) {
      const close = source.indexOf("))", index + 2);
      const end = close === -1 ? source.length : close + 2;
      const raw = source.slice(index, end);
      tokens.push({ type: "word", word: { raw, value: raw }, start: index, end });
      index = end;
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push({ type: "op", op: char, start: index, end: index + 1 });
      index += 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (op) {
      tokens.push({ type: "op", op, start: index, end: index + op.length });
      index += op.length;
      if (op === "\n" && pendingHeredocs.length > 0) readHeredocBodies();
      continue;
    }
    // Heredoc operator: `<<EOF`, `<<-'EOF'`, `<< "EOF"`. Not `<<<` here-strings.
    const heredoc = /^<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(source.slice(index));
    if (heredoc && source[index + 2] !== "<") {
      tokens.push({
        type: "word",
        word: { raw: heredoc[0], value: heredoc[0] },
        start: index,
        end: index + heredoc[0].length,
      });
      pendingHeredocs.push({ delimiter: heredoc[3]!, stripTabs: heredoc[1] === "-", at: index });
      index += heredoc[0].length;
      continue;
    }
    const start = index;
    let value = "";
    while (index < source.length) {
      const c = source[index]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ")") break;
      // `arr=(a b)` keeps its list inside the word.
      if (c === "(" && value.endsWith("=")) {
        const close = source.indexOf(")", index);
        const end = close === -1 ? source.length : close + 1;
        value += source.slice(index, end);
        index = end;
        continue;
      }
      if (c === ";" || c === "|" || c === "&") {
        // `2>&1` and `&>` keep their `&` inside the word.
        const prev = source[index - 1];
        if (!(c === "&" && (prev === ">" || prev === "<" || source[index + 1] === ">"))) break;
      }
      if (c === "\\" && index + 1 < source.length) {
        if (source[index + 1] !== "\n") value += source[index + 1];
        index += 2;
        continue;
      }
      if (c === "'") {
        const close = source.indexOf("'", index + 1);
        const end = close === -1 ? source.length : close;
        value += source.slice(index + 1, end);
        index = end + 1;
        continue;
      }
      if (c === '"') {
        index += 1;
        while (index < source.length && source[index] !== '"') {
          if (source[index] === "\\" && index + 1 < source.length) {
            const next = source[index + 1]!;
            value += '"\\$`\n'.includes(next) ? next : `\\${next}`;
            index += 2;
            continue;
          }
          if (source[index] === "$" && "({".includes(source[index + 1] ?? "")) {
            const end = substitutionEnd(source, index);
            value += source.slice(index, end);
            index = end;
            continue;
          }
          value += source[index];
          index += 1;
        }
        index += 1;
        continue;
      }
      if (c === "$" && (source[index + 1] === "(" || source[index + 1] === "{")) {
        const end = substitutionEnd(source, index);
        value += source.slice(index, end);
        index = end;
        continue;
      }
      // `name() { …; }` defines a function; keep `name()` as one word.
      if (c === "(" && source[index + 1] === ")" && value.length > 0) {
        value += "()";
        index += 2;
        continue;
      }
      value += c;
      index += 1;
    }
    if (index > start) {
      tokens.push({
        type: "word",
        word: { raw: source.slice(start, index), value },
        start,
        end: index,
      });
    } else {
      // A lone character we cannot classify; skip it rather than loop.
      index += 1;
    }
  }
  return tokens;
}

interface RawStatement {
  readonly connector: ShellConnector;
  readonly stages: ShellPipelineStage[];
  readonly raw: string;
  /** `(` and `)` of a subshell, carried as empty statements. */
  readonly group?: "open" | "close";
  background?: true;
}

function splitStatements(source: string, tokens: ReadonlyArray<Token>): RawStatement[] {
  const statements: RawStatement[] = [];
  let connector: ShellConnector = null;
  let stages: ShellPipelineStage[] = [];
  let words: ShellWord[] = [];
  let redirects: string[] = [];
  let heredoc: string | undefined;
  let stageStart = -1;
  let stageEnd = -1;
  let statementStart = -1;
  let statementEnd = -1;

  const flushStage = () => {
    if (words.length === 0 && redirects.length === 0) return;
    stages.push({
      words,
      redirects,
      ...(heredoc === undefined ? {} : { heredoc }),
      raw: source.slice(stageStart, stageEnd).trim(),
    });
    words = [];
    redirects = [];
    heredoc = undefined;
    stageStart = -1;
  };
  const flushStatement = (next: ShellConnector) => {
    flushStage();
    if (stages.length > 0) {
      statements.push({
        connector,
        stages,
        raw: source.slice(statementStart, statementEnd).trim(),
      });
      connector = next;
    } else if (next !== null) {
      connector = next;
    }
    stages = [];
    statementStart = -1;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.type === "op") {
      if (token.op === "|" || token.op === "|&") {
        flushStage();
        continue;
      }
      if (token.op === "(" || token.op === ")") {
        const pending = connector;
        flushStatement(null);
        statements.push({
          connector: token.op === "(" ? pending : null,
          stages: [],
          raw: token.op,
          group: token.op === "(" ? "open" : "close",
        });
        connector = null;
        continue;
      }
      const count = statements.length;
      flushStatement(token.op === "&&" ? "and" : token.op === "||" ? "or" : null);
      // `&` backgrounds what came before it, including a just-closed subshell.
      if (token.op === "&") {
        const last = statements.at(-1);
        if (last && (statements.length > count || last.group === "close")) last.background = true;
      }
      continue;
    }
    if (token.type === "heredoc") {
      // Bodies belong to the statement that opened them, which may already be flushed.
      const owner = stages.length > 0 || words.length > 0 ? null : statements.at(-1);
      if (owner) {
        const lastStage = owner.stages.findLast((stage) => stage.raw.includes("<<"));
        if (lastStage) (lastStage as { heredoc?: string }).heredoc = token.body;
      } else {
        heredoc = token.body;
      }
      continue;
    }
    if (statementStart === -1) statementStart = token.start;
    if (stageStart === -1) stageStart = token.start;
    statementEnd = token.end;
    stageEnd = token.end;
    const { word } = token;
    if (word.raw.startsWith("<<")) {
      redirects.push(word.raw);
      continue;
    }
    if (REDIRECT_PATTERN.test(word.raw) && !/^\d+$/.test(word.raw)) {
      const target = tokens[i + 1];
      if (!word.raw.includes("&") && target?.type === "word") {
        redirects.push(`${word.raw}${target.word.value}`);
        statementEnd = target.end;
        stageEnd = target.end;
        i += 1;
      } else {
        redirects.push(word.raw);
      }
      continue;
    }
    if (REDIRECT_WITH_TARGET.test(word.raw) && !word.raw.includes("=")) {
      redirects.push(word.raw);
      continue;
    }
    words.push(word);
  }
  flushStatement(null);
  return statements;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const SECTION_DECORATION = /^\s*([=\-#*~]{2,}|>{2,})\s*(.*?)\s*\1?\s*$/;

function stripWrappers(words: ReadonlyArray<ShellWord>) {
  const env: string[] = [];
  const wrappers: string[] = [];
  let rest = [...words];
  for (;;) {
    const first = rest[0];
    if (!first) break;
    if (ASSIGNMENT.test(first.raw) && rest.length > 1) {
      env.push(first.raw);
      rest = rest.slice(1);
      continue;
    }
    if (first.value === "timeout" && rest[1]) {
      let at = 1;
      while (rest[at]?.value.startsWith("-")) at += 1;
      wrappers.push(`timeout ${rest[at]?.value ?? ""}`.trim());
      rest = rest.slice(at + 1);
      continue;
    }
    if (["sudo", "nohup", "time", "exec", "command", "builtin"].includes(first.value)) {
      if (first.value === "command" && rest[1]?.value.startsWith("-")) break;
      if (first.value !== "command" && first.value !== "builtin") wrappers.push(first.value);
      rest = rest.slice(1);
      continue;
    }
    if (first.value === "env" && rest.length > 1) {
      rest = rest.slice(1);
      while (rest[0] && ASSIGNMENT.test(rest[0].raw)) {
        env.push(rest[0].raw);
        rest = rest.slice(1);
      }
      continue;
    }
    break;
  }
  return { env, wrappers, words: rest };
}

function programName(word: ShellWord | undefined): string {
  if (!word) return "";
  const value = word.value;
  return value.includes("/") && !value.startsWith("$")
    ? value.slice(value.lastIndexOf("/") + 1)
    : value;
}

/** Positional arguments with flags removed. Flags in `valueFlags` consume the next word. */
function positionals(words: ReadonlyArray<ShellWord>, valueFlags: ReadonlyArray<string> = []) {
  const result: string[] = [];
  let endOfFlags = false;
  for (let i = 0; i < words.length; i += 1) {
    const value = words[i]!.value;
    if (!endOfFlags && value === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && value.startsWith("-") && value.length > 1) {
      if (valueFlags.includes(value)) i += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}

function hasFlag(words: ReadonlyArray<ShellWord>, ...flags: string[]) {
  return words.some(
    (word) =>
      flags.includes(word.value) ||
      (word.value.startsWith("-") &&
        !word.value.startsWith("--") &&
        flags.some((flag) => flag.length === 2 && word.value.slice(1).includes(flag[1]!))),
  );
}

function lineCountFlag(words: ReadonlyArray<ShellWord>): string | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const value = words[i]!.value;
    const short = /^-(\d+)$/.exec(value);
    if (short) return short[1];
    if (value === "-n" || value === "-c") return words[i + 1]?.value;
    const glued = /^-n(\+?\d+)$/.exec(value);
    if (glued) return glued[1];
  }
  return undefined;
}

function quoteForLabel(value: string, max = 48): string {
  const single = value.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

const SCRIPT_LANGUAGES: Record<string, string> = {
  python: "python",
  python3: "python",
  node: "javascript",
  bun: "typescript",
  deno: "typescript",
  ruby: "ruby",
  perl: "perl",
  psql: "sql",
  sqlite3: "sql",
  mysql: "sql",
  bash: "bash",
  sh: "bash",
  zsh: "bash",
};

const EXTENSION_LANGUAGES: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  json: "json",
  sh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  toml: "toml",
  html: "html",
  css: "css",
};

function languageForPath(path: string | undefined): string {
  const extension = path?.split(".").pop()?.toLowerCase();
  return (extension && EXTENSION_LANGUAGES[extension]) || "text";
}

function describeFilter(stage: ShellPipelineStage): ShellFilter {
  const { words } = stripWrappers(stage.words);
  const program = programName(words[0]);
  const args = words.slice(1);
  const raw = stage.raw;
  const count = lineCountFlag(args);
  switch (program) {
    case "head":
      return { label: count ? `first ${count} lines` : "first lines", raw };
    case "tail":
      if (hasFlag(args, "-f")) return { label: "follow", raw };
      return {
        label: count?.startsWith("+")
          ? `from line ${count.slice(1)}`
          : count
            ? `last ${count} lines`
            : "last lines",
        raw,
      };
    case "grep":
    case "rg":
    case "egrep": {
      const pattern = grepPattern(args);
      if (hasFlag(args, "-c")) return { label: `count “${quoteForLabel(pattern ?? "")}”`, raw };
      if (hasFlag(args, "-q")) return { label: `has “${quoteForLabel(pattern ?? "")}”`, raw };
      if (hasFlag(args, "-v")) return { label: `without “${quoteForLabel(pattern ?? "")}”`, raw };
      return { label: `matching “${quoteForLabel(pattern ?? "")}”`, raw };
    }
    case "wc":
      return { label: hasFlag(args, "-l") ? "count lines" : "count", raw };
    case "sort":
      return { label: hasFlag(args, "-u") ? "sort unique" : "sort", raw };
    case "uniq":
      return { label: hasFlag(args, "-c") ? "count duplicates" : "unique", raw };
    case "cut":
      return { label: "cut columns", raw };
    case "tr":
      return { label: "translate chars", raw };
    case "cat":
      return { label: "cat", raw };
    case "tee":
      return { label: `save to ${positionals(args).join(" ")}`.trim(), raw };
    case "xargs":
      return {
        label: `each → ${words
          .slice(1)
          .map((word) => word.value)
          .filter((v) => !v.startsWith("-"))
          .join(" ")}`,
        raw,
      };
    default:
      return { label: quoteForLabel(raw, 40), raw };
  }
}

function grepPattern(args: ReadonlyArray<ShellWord>): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i]!.value;
    if (value === "-e" || value === "--regexp") return args[i + 1]?.value;
    if (value.startsWith("--regexp=")) return value.slice("--regexp=".length);
  }
  return positionals(args, [
    "-A",
    "-B",
    "-C",
    "-m",
    "-g",
    "--glob",
    "-t",
    "--type",
    "--include",
    "--exclude",
    "-f",
    "--max-count",
  ])[0];
}

function describeRedirect(redirect: string): string | null {
  if (redirect.startsWith("<<")) return null;
  if (redirect === "2>&1" || redirect === "|&") return "stderr → stdout";
  if (/^(2>\/dev\/null)$/.test(redirect)) return "stderr hidden";
  if (/^(&>|>|1>)\/dev\/null$/.test(redirect) || redirect === ">/dev/null") return "output hidden";
  if (/^&>\/dev\/null$/.test(redirect)) return "output hidden";
  const write = /^(\d*)(>>?)(.+)$/.exec(redirect);
  if (write)
    return `${write[1] === "2" ? "stderr " : ""}${write[2] === ">>" ? "append" : "write"} → ${write[3]}`;
  const read = /^<(.+)$/.exec(redirect);
  if (read) return `input ← ${read[1]}`;
  return redirect;
}

/** Human-facing labels for redirects, dropping heredoc markers. */
export function describeShellRedirects(redirects: ReadonlyArray<string>): string[] {
  return redirects.map(describeRedirect).filter((label): label is string => label !== null);
}

function inlineScriptFlag(program: string): string | undefined {
  if (program.startsWith("python") || ["bash", "sh", "zsh", "perl", "ruby"].includes(program))
    return "-c";
  if (["node", "bun", "deno"].includes(program)) return "-e";
  return undefined;
}

function summarize(
  program: string,
  words: ReadonlyArray<ShellWord>,
  stage: ShellPipelineStage,
): Pick<ShellRunStep, "summary" | "script" | "nested"> {
  const args = words.slice(1);
  const scriptLanguage =
    SCRIPT_LANGUAGES[program] ?? (program.startsWith("python") ? "python" : undefined);

  if (stage.heredoc !== undefined) {
    if (program === "cat" || program === "tee") {
      const target =
        stage.redirects.map((redirect) => /^>>?(.+)$/.exec(redirect)?.[1]).find(Boolean) ??
        positionals(args)[0];
      return {
        summary: target ? `Write ${target}` : "Inline text",
        script: { language: languageForPath(target), code: stage.heredoc },
      };
    }
    const viaSsh = program === "ssh" || program === "docker" || program === "kubectl";
    const innerLanguage = viaSsh
      ? (Object.entries(SCRIPT_LANGUAGES).find(([name]) =>
          words.some((word) => word.value.split(/\s+/).includes(name)),
        )?.[1] ?? "bash")
      : (scriptLanguage ?? "text");
    return {
      summary: `${scriptTitle(innerLanguage)} script`,
      script: { language: innerLanguage, code: stage.heredoc },
    };
  }

  const inlineFlag = inlineScriptFlag(program);
  if (inlineFlag) {
    const flagIndex = args.findIndex(
      (word) => word.value === inlineFlag || word.value === `-l${inlineFlag.slice(1)}`,
    );
    const code = flagIndex === -1 ? undefined : args[flagIndex + 1]?.value;
    if (code !== undefined) {
      if (scriptLanguage === "bash") {
        return { nested: { label: program, command: parseShellCommand(code) } };
      }
      return {
        summary: `${scriptTitle(scriptLanguage ?? "text")} snippet`,
        script: { language: scriptLanguage ?? "text", code },
      };
    }
  }

  switch (program) {
    case "cd":
      return { summary: `Go to ${args[0]?.value ?? "~"}` };
    case "sed": {
      const files = positionals(args, ["-e", "-f"]);
      const expr = files.shift();
      const range = expr ? /^(\d+)(?:,(\d+|\$))?p$/.exec(expr) : null;
      if (hasFlag(args, "-n") && range) {
        const file = files.join(" ");
        return {
          summary: range[2]
            ? `Read ${file} lines ${range[1]}–${range[2] === "$" ? "end" : range[2]}`
            : `Read ${file} line ${range[1]}`,
        };
      }
      if (hasFlag(args, "-i")) return { summary: `Edit ${files.join(" ")}` };
      return {};
    }
    case "cat":
    case "bat":
    case "less": {
      const files = positionals(args);
      return files.length > 0 ? { summary: `Read ${files.join(", ")}` } : {};
    }
    case "head":
    case "tail": {
      const files = positionals(args, ["-n", "-c"]);
      const count = lineCountFlag(args);
      if (files.length === 0) return {};
      const where = program === "head" ? "first" : "last";
      return {
        summary: `Read ${count ? `${where} ${count} lines of` : `${where} lines of`} ${files.join(", ")}`,
      };
    }
    case "grep":
    case "rg":
    case "egrep": {
      const pattern = grepPattern(args);
      const rest = positionals(args, [
        "-A",
        "-B",
        "-C",
        "-m",
        "-g",
        "--glob",
        "-t",
        "--type",
        "--include",
        "--exclude",
        "-f",
        "--max-count",
      ]);
      const paths = rest.slice(rest.indexOf(pattern ?? "") + 1);
      return {
        summary: `Search “${quoteForLabel(pattern ?? "")}”${paths.length > 0 ? ` in ${paths.join(", ")}` : ""}`,
      };
    }
    case "ls":
      return { summary: `List ${positionals(args).join(", ") || "."}` };
    case "find":
    case "fd":
      return { summary: `Find in ${positionals(args)[0] ?? "."}` };
    case "sleep":
      return {
        summary: `Wait ${args[0]?.value ?? ""}${/^\d+$/.test(args[0]?.value ?? "") ? "s" : ""}`,
      };
    case "mkdir":
      return { summary: `Create ${positionals(args).join(", ")}` };
    case "rm":
      return { summary: `Delete ${positionals(args).join(", ")}` };
    case "cp":
    case "mv": {
      const paths = positionals(args, ["-t"]);
      const target = paths.pop();
      return {
        summary: `${program === "cp" ? "Copy" : "Move"} ${paths.join(", ")} → ${target ?? ""}`,
      };
    }
    case "curl": {
      const method =
        args
          .map((word, i) =>
            word.value === "-X" || word.value === "--request" ? args[i + 1]?.value : undefined,
          )
          .find(Boolean) ??
        (hasFlag(args, "-d") || args.some((word) => word.value.startsWith("--data"))
          ? "POST"
          : "GET");
      const url = positionals(args, [
        "-X",
        "--request",
        "-H",
        "--header",
        "-d",
        "--data",
        "--data-raw",
        "-o",
        "-w",
        "-u",
        "-b",
        "-c",
        "-m",
        "--max-time",
        "-F",
        "--connect-timeout",
      ]).find((value) => /^(https?:\/\/|localhost|\$|\d)/.test(value));
      return { summary: `${method} ${url ?? ""}`.trim() };
    }
    case "ssh": {
      const rest = positionals(args, ["-i", "-p", "-o", "-l", "-J", "-F", "-L", "-R"]);
      const host = rest[0];
      const remote = rest.slice(1).join(" ");
      if (host && remote)
        return { nested: { label: `on ${host}`, command: parseShellCommand(remote) } };
      return host ? { summary: `Connect to ${host}` } : {};
    }
    case "docker": {
      const sub = args[0]?.value;
      if (sub === "exec") {
        const rest = positionals(args.slice(1), ["-u", "--user", "-w", "--workdir", "-e", "--env"]);
        const container = rest[0];
        const inner = rest.slice(1);
        if (container && inner.length > 0) {
          const innerProgram = inner[0]!;
          const innerFlag = inlineScriptFlag(innerProgram);
          const flagAt = innerFlag ? inner.indexOf(innerFlag) : -1;
          if (
            flagAt !== -1 &&
            inner[flagAt + 1] !== undefined &&
            SCRIPT_LANGUAGES[innerProgram] === "bash"
          ) {
            return {
              nested: { label: `in ${container}`, command: parseShellCommand(inner[flagAt + 1]!) },
            };
          }
          return { summary: `In ${container}: ${quoteForLabel(inner.join(" "), 60)}` };
        }
      }
      return {};
    }
    default:
      return {};
  }
}

function scriptTitle(language: string): string {
  const titles: Record<string, string> = {
    python: "Python",
    javascript: "JavaScript",
    typescript: "TypeScript",
    sql: "SQL",
    bash: "Shell",
    ruby: "Ruby",
    perl: "Perl",
  };
  return titles[language] ?? "Inline";
}

function sectionTitle(step: RawStatement): { title: string; marker: string } | undefined {
  if (step.stages.length !== 1) return undefined;
  const stage = step.stages[0]!;
  const words = stage.words;
  if (programName(words[0]) !== "echo" && programName(words[0]) !== "printf") return undefined;
  const args = words.slice(1).filter((word) => !/^-[neE]+$/.test(word.value));
  if (args.length === 0 || stage.redirects.some((redirect) => !redirect.includes("&")))
    return undefined;
  const marker = args
    .map((word) => word.value)
    .join(" ")
    .replace(/\\n/g, "")
    .trim();
  const decorated = SECTION_DECORATION.exec(marker);
  if (!decorated) return undefined;
  const title = decorated[2]!.replace(/[=\-#*~>]{2,}\s*$/, "").trim();
  return { title, marker };
}

const BLOCK_OPENERS = new Set(["for", "while", "until", "if"]);
const BLOCK_CLOSERS = new Set(["done", "fi"]);

function firstValue(statement: RawStatement): string | undefined {
  return statement.stages[0]?.words[0]?.value;
}

/** Drops a leading keyword word (`do`, `then`, `else`) from a statement. */
function dropKeyword(statement: RawStatement): RawStatement | null {
  const [first, ...rest] = statement.stages;
  if (!first) return null;
  const words = first.words.slice(1);
  if (words.length === 0 && rest.length === 0 && first.redirects.length === 0) return null;
  const keyword = first.words[0]!.raw;
  return {
    connector: statement.connector,
    stages:
      words.length === 0
        ? rest
        : [{ ...first, words, raw: first.raw.slice(keyword.length).trim() }, ...rest],
    raw: statement.raw.slice(keyword.length).trim(),
  };
}

function buildSteps(
  statements: RawStatement[],
  cursor: { index: number },
  stopAt: ReadonlySet<string>,
): ShellStep[] {
  const steps: ShellStep[] = [];
  while (cursor.index < statements.length) {
    const statement = statements[cursor.index]!;
    const head = firstValue(statement);
    if (head !== undefined && stopAt.has(head)) return steps;
    if (statement.group === "close") {
      if (stopAt.has(")")) return steps;
      cursor.index += 1;
      continue;
    }
    cursor.index += 1;

    if (statement.group === "open") {
      const body = buildSteps(statements, cursor, new Set([")"]));
      const close = statements[cursor.index];
      if (close?.group === "close") cursor.index += 1;
      // `(cmd &)` is the usual way to detach: the subshell exits and the command is orphaned.
      const last = body.at(-1);
      const detached = last !== undefined && last.kind !== "section" && last.background === true;
      steps.push({
        kind: "block",
        connector: statement.connector,
        label: detached ? "Detached" : "Subshell",
        body,
        ...(close?.background ? { background: true as const } : {}),
        raw: statement.raw,
      });
      continue;
    }

    if (head !== undefined && BLOCK_OPENERS.has(head)) {
      steps.push(buildBlock(head, statement, statements, cursor));
      continue;
    }
    if (head === "do" || head === "then" || head === "else") {
      const rest = dropKeyword(statement);
      if (rest) {
        statements.splice(cursor.index, 0, rest);
      }
      continue;
    }
    steps.push(buildStep(statement));
  }
  return steps;
}

function buildBlock(
  keyword: string,
  header: RawStatement,
  statements: RawStatement[],
  cursor: { index: number },
): ShellBlockStep {
  const headerWords = header.stages[0]!.words.slice(1)
    .map((word) => word.raw)
    .join(" ");
  const label =
    keyword === "for"
      ? `For each ${headerWords}`
      : keyword === "while"
        ? `While ${headerWords}`
        : keyword === "until"
          ? `Until ${headerWords}`
          : `If ${headerWords}`;
  const closer = keyword === "if" ? "fi" : "done";
  const body = buildSteps(
    statements,
    cursor,
    new Set([closer, ...(keyword === "if" ? ["else", "elif"] : [])]),
  );
  let elseBody: ShellStep[] | undefined;
  const next = statements[cursor.index];
  if (keyword === "if" && next && (firstValue(next) === "else" || firstValue(next) === "elif")) {
    cursor.index += 1;
    const rest = dropKeyword(next);
    if (rest) statements.splice(cursor.index, 0, rest);
    elseBody = buildSteps(statements, cursor, new Set(["fi"]));
  }
  const end = statements[cursor.index];
  const closed = end !== undefined && BLOCK_CLOSERS.has(firstValue(end) ?? "");
  if (closed) cursor.index += 1;
  return {
    kind: "block",
    connector: header.connector,
    label: quoteForLabel(label, 120),
    body,
    ...(elseBody ? { elseBody } : {}),
    ...(closed && end.background ? { background: true as const } : {}),
    raw: header.raw,
  };
}

function buildStep(statement: RawStatement): ShellStep {
  const section = sectionTitle(statement);
  if (section) return { kind: "section", ...section, raw: statement.raw };

  const [main, ...rest] = statement.stages;
  const allAssignments =
    statement.stages.length === 1 &&
    main!.words.length > 0 &&
    main!.words.every((word) => ASSIGNMENT.test(word.raw));
  if (allAssignments) {
    return {
      kind: "assign",
      connector: statement.connector,
      assignments: main!.words.map((word) => {
        const match = ASSIGNMENT.exec(word.value)!;
        return { name: match[1]!, value: match[2]! };
      }),
      ...(statement.background ? { background: true as const } : {}),
      raw: statement.raw,
    };
  }
  const background = statement.background ? { background: true as const } : {};
  // `: > file` empties the file.
  const truncated =
    main!.words.length === 1 && main!.words[0]!.value === ":" && rest.length === 0
      ? main!.redirects.map((redirect) => /^>(.+)$/.exec(redirect)?.[1]).find(Boolean)
      : undefined;
  if (truncated !== undefined) {
    return {
      kind: "run",
      connector: statement.connector,
      program: ":",
      words: [{ raw: statement.raw, value: statement.raw }],
      env: [],
      wrappers: [],
      redirects: [],
      filters: [],
      summary: `Empty ${truncated}`,
      ...background,
      raw: statement.raw,
    };
  }

  const { env, wrappers, words } = stripWrappers(main!.words);
  const program = programName(words[0]);
  const stage = { ...main!, words };
  return {
    kind: "run",
    connector: statement.connector,
    program,
    words,
    env,
    wrappers,
    redirects: [...main!.redirects, ...rest.flatMap((filter) => filter.redirects)],
    filters: rest.map(describeFilter),
    ...summarize(program, words, stage),
    ...background,
    raw: statement.raw,
  };
}

export function parseShellCommand(source: string): ParsedShellCommand {
  const statements = splitStatements(source, tokenize(source));
  const steps = buildSteps(statements, { index: 0 }, new Set());

  let cwd: string | undefined;
  const variables: Array<{ name: string; value: string }> = [];
  let leading = 0;
  for (const step of steps) {
    if (step.kind === "assign" && step.connector !== "or") {
      variables.push(...step.assignments);
      leading += 1;
      continue;
    }
    if (
      cwd === undefined &&
      step.kind === "run" &&
      step.program === "cd" &&
      step.words.length === 2 &&
      step.filters.length === 0 &&
      step.connector !== "or"
    ) {
      cwd = step.words[1]!.value;
      leading += 1;
      continue;
    }
    break;
  }
  const remaining = steps.slice(leading);
  const first = remaining[0];
  return {
    ...(cwd === undefined ? {} : { cwd }),
    variables,
    steps:
      first && first.kind !== "section" && first.connector !== null
        ? [{ ...first, connector: null } as ShellStep, ...remaining.slice(1)]
        : remaining,
  };
}

export interface ShellOutputSection {
  /** Title of the matching section step, or null for output before any marker. */
  readonly title: string | null;
  readonly marker: string | null;
  readonly text: string;
}

function collectMarkers(steps: ReadonlyArray<ShellStep>, into: string[]) {
  for (const step of steps) {
    if (step.kind === "section") into.push(step.marker);
    if (step.kind === "block") {
      collectMarkers(step.body, into);
      if (step.elseBody) collectMarkers(step.elseBody, into);
    }
    if (step.kind === "run" && step.nested) collectMarkers(step.nested.command.steps, into);
  }
}

/** Splits output at the lines printed by the command's section markers. */
export function splitShellOutputSections(
  parsed: ParsedShellCommand,
  output: string,
): ShellOutputSection[] {
  const markers: string[] = [];
  collectMarkers(parsed.steps, markers);
  const titles = new Map<string, string>();
  for (const step of parsed.steps) if (step.kind === "section") titles.set(step.marker, step.title);
  const markerSet = new Set(markers);
  const sections: ShellOutputSection[] = [];
  let current: { title: string | null; marker: string | null; lines: string[] } = {
    title: null,
    marker: null,
    lines: [],
  };
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (markerSet.has(trimmed)) {
      if (current.marker !== null || current.lines.some((value) => value.trim().length > 0)) {
        sections.push({
          title: current.title,
          marker: current.marker,
          text: current.lines.join("\n"),
        });
      }
      const decorated = SECTION_DECORATION.exec(trimmed);
      current = {
        title: titles.get(trimmed) ?? decorated?.[2]?.trim() ?? trimmed,
        marker: trimmed,
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }
  sections.push({
    title: current.title,
    marker: current.marker,
    text: current.lines.join("\n").replace(/\n+$/, ""),
  });
  return sections;
}
