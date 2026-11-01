import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  describeShellRedirects,
  parseShellCommand,
  splitShellOutputSections,
  type ParsedShellCommand,
  type ShellConnector,
  type ShellStep,
} from "@t3tools/shared/shellCommand";
import { CheckIcon, ChevronRightIcon, CopyIcon, FolderIcon } from "lucide-react";
import { Suspense, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type CommandItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

interface CommandDetailsDialogProps {
  readonly item: CommandItem;
  readonly environmentId: EnvironmentId | null;
  readonly workspaceRoot: string | undefined;
  readonly onClose: () => void;
}

// oxlint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Claude stores Bash results as a JSON envelope; show its streams, not the wrapper. */
function readCommandOutput(raw: string): { stdout: string; stderr: string } {
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "stdout" in parsed) {
        const { stdout, stderr } = parsed as { stdout?: unknown; stderr?: unknown };
        return {
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        };
      }
    } catch {
      // Not an envelope; fall through to plain text.
    }
  }
  return { stdout: raw, stderr: "" };
}

function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function displayPath(path: string, workspaceRoot: string | undefined) {
  if (path.startsWith("~") || path.startsWith("$")) return path;
  return formatWorkspaceRelativePath(path, workspaceRoot) || path;
}

export function CommandDetailsDialog({
  item,
  environmentId,
  workspaceRoot,
  onClose,
}: CommandDetailsDialogProps) {
  const parsed = useMemo(() => parseShellCommand(item.input), [item.input]);
  const [view, setView] = useState<"parsed" | "raw">("parsed");
  const outputQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : orchestrationEnvironment.commandOutput({
          environmentId,
          input: { threadId: item.threadId, turnItemId: item.id },
        }),
  );
  // Output lands when the command finishes; refetch once it does.
  const { refresh } = outputQuery;
  useEffect(() => {
    if (item.completedAt) refresh();
  }, [item.completedAt, refresh]);

  const streams = useMemo(() => {
    const raw = outputQuery.data?.output;
    if (raw === undefined) return null;
    const { stdout, stderr } = readCommandOutput(raw);
    return { stdout: stdout.replace(ANSI_PATTERN, ""), stderr: stderr.replace(ANSI_PATTERN, "") };
  }, [outputQuery.data?.output]);
  const output =
    streams === null
      ? null
      : [streams.stdout, streams.stderr].filter((text) => text.length > 0).join("\n");
  const sections = useMemo(() => {
    if (streams === null) return [];
    const stdoutSections =
      streams.stdout.length > 0 ? splitShellOutputSections(parsed, streams.stdout) : [];
    return streams.stderr.trim().length > 0
      ? [...stdoutSections, { title: "stderr", marker: "stderr", text: streams.stderr }]
      : stdoutSections;
  }, [parsed, streams]);
  const exitCode = outputQuery.data?.exitCode ?? item.exitCode;
  const running = item.status === "running" || item.status === "pending";
  const failed =
    item.status === "failed" ||
    item.outputIndicatesFailure === true ||
    (exitCode !== undefined && exitCode !== 0);
  const duration = formatDuration(item.startedAt, item.completedAt);
  const firstSummary = parsed.steps.find(
    (step): step is Extract<ShellStep, { kind: "run" }> => step.kind === "run",
  );
  const title = item.title ?? firstSummary?.summary ?? "Command";

  const outputRef = useRef<HTMLDivElement>(null);
  const scrollToSection = (marker: string) => {
    const target = outputRef.current?.querySelector(`[data-marker="${CSS.escape(marker)}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        className="flex h-[min(88vh,60rem)] w-[min(96vw,80rem)] max-w-none flex-col overflow-hidden"
        bottomStickOnMobile={false}
      >
        <div className="flex flex-col gap-1.5 border-b border-border/70 px-5 py-3.5 pe-12">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription render={<div />} className="flex flex-wrap items-center gap-1.5">
            {running ? (
              <Badge variant="info">
                <Spinner className="size-3" /> Running
              </Badge>
            ) : failed ? (
              <Badge variant="error">
                {exitCode !== undefined ? `Exit ${exitCode}` : "Failed"}
              </Badge>
            ) : (
              <Badge variant="success">
                {exitCode !== undefined ? `Exit ${exitCode}` : "Done"}
              </Badge>
            )}
            {duration ? <Badge variant="outline">{duration}</Badge> : null}
            {parsed.cwd ? (
              <Badge variant="outline" title={parsed.cwd}>
                <FolderIcon /> {displayPath(parsed.cwd, workspaceRoot)}
              </Badge>
            ) : null}
          </DialogDescription>
        </div>
        <div className="grid min-h-0 flex-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
          <section className="flex min-h-0 flex-col border-border/70 max-md:border-b md:border-e">
            <PaneHeader
              label="Command"
              copyText={item.input}
              controls={
                <ToggleGroup
                  aria-label="Command view"
                  variant="segmented"
                  size="segmented"
                  value={[view]}
                  onValueChange={(next) => {
                    const value = next[0];
                    if (value === "parsed" || value === "raw") setView(value);
                  }}
                >
                  <Toggle value="parsed">Parsed</Toggle>
                  <Toggle value="raw">Raw</Toggle>
                </ToggleGroup>
              }
            />
            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {view === "raw" ? (
                <CodeBlock code={item.input} language="bash" />
              ) : (
                <ParsedCommandView
                  parsed={parsed}
                  workspaceRoot={workspaceRoot}
                  hideCwd
                  onSectionClick={scrollToSection}
                />
              )}
            </div>
          </section>
          <section className="flex min-h-0 flex-col">
            <PaneHeader
              label="Output"
              copyText={output ?? undefined}
              controls={
                output !== null ? (
                  <span className="text-xs text-muted-foreground">
                    {output.split("\n").length} lines
                  </span>
                ) : null
              }
            />
            <div ref={outputRef} className="min-h-0 flex-1 overflow-auto px-4 py-3">
              <OutputView
                sections={sections}
                pending={outputQuery.isPending}
                running={running}
                error={outputQuery.error}
                empty={output === null || output.trim().length === 0}
              />
            </div>
          </section>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function PaneHeader(props: {
  readonly label: string;
  readonly copyText: string | undefined;
  readonly controls?: ReactNode;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1500 });
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/50 px-4">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
      <div className="ms-auto flex items-center gap-2">
        {props.controls}
        {props.copyText !== undefined ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={`Copy ${props.label.toLowerCase()}`}
            onClick={() => copyToClipboard(props.copyText!, undefined)}
          >
            {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function OutputView(props: {
  readonly sections: ReturnType<typeof splitShellOutputSections>;
  readonly pending: boolean;
  readonly running: boolean;
  readonly error: string | null;
  readonly empty: boolean;
}) {
  if (props.error) return <p className="text-sm text-destructive">{props.error}</p>;
  if (props.empty) {
    if (props.pending)
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5" /> Loading output…
        </p>
      );
    return (
      <p className="text-sm text-muted-foreground">
        {props.running ? "Output appears when the command finishes." : "No output."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {props.sections.map((section, index) => (
        <div
          // Sections are positional slices of one immutable output string.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          data-marker={section.marker ?? undefined}
          className="scroll-mt-2"
        >
          {section.marker !== null ? <SectionHeading title={section.title} /> : null}
          {section.text.trim().length > 0 ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
              {section.text.replace(/^\n+/, "")}
            </pre>
          ) : (
            <p className="text-xs italic text-muted-foreground">(no output)</p>
          )}
        </div>
      ))}
    </div>
  );
}

function SectionHeading(props: { readonly title: string | null; readonly onClick?: () => void }) {
  const content = (
    <>
      <span className="truncate">{props.title || "—"}</span>
      <span className="h-px flex-1 bg-border/70" />
    </>
  );
  const className =
    "mb-1.5 flex w-full items-center gap-2 text-start text-xs font-semibold text-muted-foreground";
  return props.onClick ? (
    <button
      type="button"
      className={cn(className, "hover:text-foreground")}
      onClick={props.onClick}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

const CONNECTOR_LABELS: Record<Exclude<ShellConnector, null>, string> = {
  and: "if ok",
  or: "else",
  background: "in background",
};

function ParsedCommandView(props: {
  readonly parsed: ParsedShellCommand;
  readonly workspaceRoot: string | undefined;
  readonly hideCwd?: boolean;
  readonly onSectionClick: (marker: string) => void;
}) {
  const { parsed } = props;
  const showCwd = parsed.cwd !== undefined && !props.hideCwd;
  return (
    <div className="flex flex-col gap-2">
      {showCwd || parsed.variables.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {showCwd ? (
            <Badge variant="outline" title={parsed.cwd}>
              <FolderIcon /> {displayPath(parsed.cwd!, props.workspaceRoot)}
            </Badge>
          ) : null}
          {parsed.variables.map((variable) => (
            <Badge
              key={variable.name}
              variant="secondary"
              title={`${variable.name}=${variable.value}`}
              className="max-w-full"
            >
              <span className="truncate font-mono">
                {variable.name}={variable.value}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}
      <StepList steps={parsed.steps} onSectionClick={props.onSectionClick} />
    </div>
  );
}

function StepList(props: {
  readonly steps: ReadonlyArray<ShellStep>;
  readonly onSectionClick: (marker: string) => void;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {props.steps.map((step, index) => (
        // Steps are derived from an immutable command string.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index}>
          <StepView step={step} onSectionClick={props.onSectionClick} />
        </li>
      ))}
    </ol>
  );
}

function ConnectorLabel({ connector }: { readonly connector: ShellConnector }) {
  if (connector === null) return null;
  return (
    <span className="me-1.5 shrink-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground/80">
      {CONNECTOR_LABELS[connector]}
    </span>
  );
}

function StepView(props: {
  readonly step: ShellStep;
  readonly onSectionClick: (marker: string) => void;
}) {
  const { step } = props;
  switch (step.kind) {
    case "section":
      return (
        <div className="pt-2">
          <SectionHeading title={step.title} onClick={() => props.onSectionClick(step.marker)} />
        </div>
      );
    case "assign":
      return (
        <div className="flex items-baseline font-mono text-xs text-muted-foreground">
          <ConnectorLabel connector={step.connector} />
          <span className="break-all">
            {step.assignments
              .map((assignment) => `${assignment.name}=${assignment.value}`)
              .join(" ")}
          </span>
        </div>
      );
    case "block":
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline text-sm">
            <ConnectorLabel connector={step.connector} />
            <span className="font-medium text-foreground/90">{step.label}</span>
          </div>
          <div className="ms-1.5 border-s border-border/70 ps-3">
            <StepList steps={step.body} onSectionClick={props.onSectionClick} />
          </div>
          {step.elseBody ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">Otherwise</span>
              <div className="ms-1.5 border-s border-border/70 ps-3">
                <StepList steps={step.elseBody} onSectionClick={props.onSectionClick} />
              </div>
            </>
          ) : null}
        </div>
      );
    case "run":
      return <RunStepView step={step} onSectionClick={props.onSectionClick} />;
  }
}

function RunStepView(props: {
  readonly step: Extract<ShellStep, { kind: "run" }>;
  readonly onSectionClick: (marker: string) => void;
}) {
  const { step } = props;
  const mainCommand = step.words.map((word) => word.raw).join(" ");
  const badges = [...step.wrappers, ...step.env, ...describeShellRedirects(step.redirects)];
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline">
        <ConnectorLabel connector={step.connector} />
        {step.summary ? (
          <span className="min-w-0 text-sm text-foreground">{step.summary}</span>
        ) : step.nested ? (
          <span className="min-w-0 text-sm text-foreground">
            {step.program} {step.nested.label}
          </span>
        ) : (
          <InlineCode code={mainCommand} />
        )}
      </div>
      {step.summary && !step.script ? <InlineCode code={mainCommand} muted /> : null}
      {step.filters.length > 0 || badges.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {step.filters.map((filter, index) => (
            <Badge
              // oxlint-disable-next-line react/no-array-index-key
              key={`f${index}`}
              variant="secondary"
              size="sm"
              title={filter.raw}
            >
              ↳ {filter.label}
            </Badge>
          ))}
          {badges.map((badge, index) => (
            // oxlint-disable-next-line react/no-array-index-key
            <Badge key={`b${index}`} variant="outline" size="sm">
              {badge}
            </Badge>
          ))}
        </div>
      ) : null}
      {step.script ? <ScriptBlock code={step.script.code} language={step.script.language} /> : null}
      {step.nested ? (
        <div className="mt-1 border-s border-border/70 ps-3">
          <ParsedCommandView
            parsed={step.nested.command}
            workspaceRoot={undefined}
            onSectionClick={props.onSectionClick}
          />
        </div>
      ) : null}
    </div>
  );
}

const SCRIPT_PREVIEW_LINES = 24;

function ScriptBlock(props: { readonly code: string; readonly language: string }) {
  const lineCount = props.code.split("\n").length;
  const [open, setOpen] = useState(lineCount <= SCRIPT_PREVIEW_LINES);
  return (
    <div className="mt-0.5 overflow-hidden rounded-md border border-border/60 bg-background/60">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-start text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronRightIcon className={cn("size-3", open && "rotate-90")} />
        {props.language} · {lineCount} {lineCount === 1 ? "line" : "lines"}
      </button>
      {open ? (
        <div className="border-t border-border/50 px-2 py-1.5">
          <CodeBlock code={props.code} language={props.language} />
        </div>
      ) : null}
    </div>
  );
}

function InlineCode(props: { readonly code: string; readonly muted?: boolean }) {
  return (
    <div className={cn("min-w-0", props.muted && "opacity-70")}>
      <CodeBlock code={props.code} language="bash" />
    </div>
  );
}

function CodeBlock(props: { readonly code: string; readonly language: string }) {
  const fallback = (
    <pre className="whitespace-pre-wrap break-words font-mono text-xs">{props.code}</pre>
  );
  return (
    <Suspense fallback={fallback}>
      <HighlightedCode {...props} />
    </Suspense>
  );
}

function HighlightedCode(props: { readonly code: string; readonly language: string }) {
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const html = useMemo(() => {
    try {
      return highlighter.codeToHtml(props.code, { lang: props.language, theme: themeName });
    } catch {
      return highlighter.codeToHtml(props.code, { lang: "text", theme: themeName });
    }
  }, [highlighter, props.code, props.language, themeName]);
  return (
    <div
      className="font-mono text-xs leading-relaxed [&_.shiki]:!bg-transparent [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
