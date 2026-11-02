import type {
  AgentActivityProcess,
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  describeShellRedirects,
  parseShellCommand,
  splitShellOutputSections,
  type ParsedShellCommand,
  type ShellConnector,
  type ShellStep,
} from "@t3tools/shared/shellCommand";
import { formatDuration as formatElapsedMs } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import { CheckIcon, ChevronRightIcon, CopyIcon, CpuIcon, FolderIcon } from "lucide-react";
import { createContext, Suspense, use, useEffect, useRef, useState, type ReactNode } from "react";

import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { tickTextContent } from "../../lib/tickTextContent";
import { cn } from "../../lib/utils";
import {
  type AgentProcessNode,
  buildAgentProcessTree,
  findCommandProcessNode,
  formatActivityBytes,
  formatActivityCpu,
  useThreadAgentActivity,
} from "../../state/agentActivity";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useTurnItemDetail } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useCommandOutputStreaming } from "./CommandOutputPanel";
import { matchProcessesToSteps } from "./commandStepTiming";
import type { TurnItemSource } from "./timelineRowContext";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type CommandItem = Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>;

interface CommandDetailsDialogProps {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
  readonly source?: TurnItemSource | undefined;
  readonly workspaceRoot: string | undefined;
  readonly onClose: () => void;
}

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

const BACKGROUND_NOTICE = /Output is being written to: \/\S+\.output\b/;
const BACKGROUND_REFRESH_MS = 2_000;

function outputStreams(raw: string) {
  const { stdout, stderr } = readCommandOutput(raw);
  return { stdout: stdout.replace(ANSI_PATTERN, ""), stderr: stderr.replace(ANSI_PATTERN, "") };
}

function outputSections(parsed: ParsedShellCommand, streams: ReturnType<typeof outputStreams>) {
  const stdoutSections =
    streams.stdout.length > 0 ? splitShellOutputSections(parsed, streams.stdout) : [];
  return streams.stderr.trim().length > 0
    ? [...stdoutSections, { title: "stderr", marker: "stderr", text: streams.stderr }]
    : stdoutSections;
}

function highlightCodeHtml(
  highlighter: Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>,
  code: string,
  language: string,
  theme: string,
): string {
  try {
    return highlighter.codeToHtml(code, { lang: language, theme });
  } catch {
    return highlighter.codeToHtml(code, { lang: "text", theme });
  }
}

function lineCount(text: string): string {
  const count = text.split("\n").length;
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(
  startedAt: DateTime.Utc | null,
  completedAt: DateTime.Utc | null,
): string | null {
  if (!startedAt || !completedAt) return null;
  const ms = DateTime.toEpochMillis(completedAt) - DateTime.toEpochMillis(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function flattenProcessNodes(nodes: ReadonlyArray<AgentProcessNode>): AgentActivityProcess[] {
  return nodes.flatMap((node) => [node.process, ...flattenProcessNodes(node.children)]);
}

interface StepTiming {
  /** Start of the step's live process, or null once none is running. */
  readonly runningSinceMs: number | null;
  /** Observed run time of its finished processes; samples arrive every few seconds. */
  readonly finishedMs: number;
  readonly runs: number;
}

interface ObservedProcess {
  readonly path: string;
  readonly startMs: number;
  readonly lastSeenMs: number;
}

const StepTimingCtx = createContext<ReadonlyMap<string, StepTiming>>(new Map());

function stepTimings(
  observed: ReadonlyMap<string, ObservedProcess>,
  liveKeys: ReadonlySet<string>,
): Map<string, StepTiming> {
  const timings = new Map<string, StepTiming>();
  for (const [key, process] of observed) {
    const current = timings.get(process.path) ?? { runningSinceMs: null, finishedMs: 0, runs: 0 };
    const live = liveKeys.has(key);
    timings.set(process.path, {
      runningSinceMs: live
        ? Math.min(current.runningSinceMs ?? process.startMs, process.startMs)
        : current.runningSinceMs,
      finishedMs:
        current.finishedMs + (live ? 0 : Math.max(0, process.lastSeenMs - process.startMs)),
      runs: current.runs + 1,
    });
  }
  return timings;
}

function displayPath(path: string, workspaceRoot: string | undefined) {
  if (path.startsWith("~") || path.startsWith("$")) return path;
  return formatWorkspaceRelativePath(path, workspaceRoot) || path;
}

export function CommandDetailsDialog({
  projectedItem,
  environmentId,
  workspaceRoot,
  source,
  onClose,
}: CommandDetailsDialogProps) {
  const wireItem = projectedItem.item as CommandItem;
  // The wire projection withholds command output; fetch the full item when it did.
  const fetches = turnItemNeedsDetailFetch(wireItem);
  const detail = useTurnItemDetail(
    fetches
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(wireItem),
        }
      : null,
    source?.detail,
  );
  const fetchedItem = detail.data?.item;
  const item = fetchedItem?.type === "command_execution" ? fetchedItem : wireItem;
  const parsed = parseShellCommand(item.input);
  const [view, setView] = useState<"parsed" | "raw">("parsed");
  // Claude's run_in_background returns a notice; the real output keeps growing in a task file.
  const isBackground = item.output !== undefined && BACKGROUND_NOTICE.test(item.output);
  const background = useEnvironmentQuery(
    isBackground
      ? orchestrationEnvironment.backgroundCommandOutput({
          environmentId,
          input: { threadId: projectedItem.sourceThreadId, itemId: projectedItem.sourceItemId },
        })
      : null,
  );
  const refreshBackground = background.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads a file on the host that grows while the dialog is open
  useEffect(() => {
    if (!isBackground) return;
    const timer = window.setInterval(refreshBackground, BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [isBackground, refreshBackground]);
  const backgroundText = background.data?.text;
  const running = item.status === "running" || item.status === "pending";
  const streaming = useCommandOutputStreaming(environmentId) || source?.commandOutput !== undefined;
  // Unpersisted tail of a foreground command, streamed until it settles.
  const liveInput = { threadId: projectedItem.sourceThreadId, itemId: projectedItem.sourceItemId };
  const live = useEnvironmentQuery(
    running && streaming
      ? source?.commandOutput
        ? source.commandOutput(liveInput)
        : orchestrationEnvironment.v2.commandOutput({ environmentId, input: liveInput })
      : null,
  );
  const liveText = running ? live.data?.output.text || undefined : undefined;
  const rawOutput = backgroundText ?? liveText ?? item.output;
  const streams = rawOutput === undefined ? null : outputStreams(rawOutput);
  const output =
    streams === null
      ? null
      : [streams.stdout, streams.stderr].filter((text) => text.length > 0).join("\n");
  const sections = streams === null ? [] : outputSections(parsed, streams);
  const exitCode = item.exitCode;
  // Background commands keep running after their tool call returns, so look regardless of status.
  const activity = useThreadAgentActivity(environmentId, projectedItem.sourceThreadId);
  const processNode =
    activity === null
      ? null
      : findCommandProcessNode(buildAgentProcessTree(activity.processes), item.input);
  const stepProcesses = processNode
    ? matchProcessesToSteps(parsed.steps, flattenProcessNodes(processNode.children))
    : new Map<AgentActivityProcess, string>();
  // Steps leave no record of their own; remember each process seen while the dialog is open.
  const [observed, setObserved] = useState<{
    readonly readAtMs: number | null;
    readonly processes: ReadonlyMap<string, ObservedProcess>;
  }>({ readAtMs: null, processes: new Map() });
  if (activity !== null && activity.readAtMs !== observed.readAtMs) {
    const processes = new Map(observed.processes);
    for (const [process, path] of stepProcesses) {
      const key = `${process.pid}:${process.startTimeMs}`;
      processes.set(key, {
        path,
        startMs: observed.processes.get(key)?.startMs ?? activity.readAtMs - process.runTimeMs,
        lastSeenMs: activity.readAtMs,
      });
    }
    setObserved({ readAtMs: activity.readAtMs, processes });
  }
  const timings = stepTimings(
    observed.processes,
    new Set([...stepProcesses.keys()].map((process) => `${process.pid}:${process.startTimeMs}`)),
  );
  const startedAtMs = item.startedAt ? DateTime.toEpochMillis(item.startedAt) : null;
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
  // Follow growing output like a terminal, unless the reader scrolled up.
  const followTailRef = useRef(true);
  const growingText = backgroundText ?? liveText;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the scroll container pinned to new output
  useEffect(() => {
    const element = outputRef.current;
    if (growingText === undefined || element === null) return;
    if (followTailRef.current) element.scrollTop = element.scrollHeight;
  }, [growingText]);
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
            ) : isBackground ? (
              // The tool call returned at once; the command itself keeps running detached.
              <Badge variant="info">Running in background</Badge>
            ) : failed ? (
              <Badge variant="error">
                {exitCode !== undefined ? `Exit ${exitCode}` : "Failed"}
              </Badge>
            ) : (
              <Badge variant="success">
                {exitCode !== undefined ? `Exit ${exitCode}` : "Done"}
              </Badge>
            )}
            {duration && !isBackground ? <Badge variant="outline">{duration}</Badge> : null}
            {running && startedAtMs !== null ? (
              <Badge variant="outline">
                <span
                  ref={tickTextContent(
                    (nowMs) => formatElapsedMs(Math.max(0, nowMs - startedAtMs)),
                    true,
                  )}
                  className="tabular-nums"
                />
              </Badge>
            ) : null}
            {processNode ? (
              <Badge variant="outline">
                <CpuIcon /> {formatActivityCpu(processNode.total.cpuPercent)} ·{" "}
                {formatActivityBytes(processNode.total.residentBytes)}
                {processNode.total.count > 1 ? ` · ${processNode.total.count} processes` : ""}
              </Badge>
            ) : null}
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
                <StepTimingCtx value={timings}>
                  <ParsedCommandView
                    parsed={parsed}
                    workspaceRoot={workspaceRoot}
                    hideCwd
                    onSectionClick={scrollToSection}
                  />
                </StepTimingCtx>
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
                    {background.data
                      ? `live file · ${formatFileSize(background.data.sizeBytes)}${background.data.truncated ? " · showing the end" : ""}`
                      : liveText !== undefined
                        ? `live · ${lineCount(output)}${live.data?.output.truncated ? " · showing the end" : ""}`
                        : lineCount(output)}
                  </span>
                ) : null
              }
            />
            <div
              ref={outputRef}
              className="min-h-0 flex-1 overflow-auto px-4 py-3"
              onScroll={(event) => {
                const element = event.currentTarget;
                followTailRef.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 40;
              }}
            >
              <OutputView
                sections={sections}
                pending={fetches && item === wireItem && detail.isPending}
                running={running}
                streaming={streaming}
                error={fetches && item === wireItem ? detail.error : null}
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
  readonly streaming: boolean;
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
        {props.running
          ? props.streaming
            ? "Waiting for output…"
            : "Output appears when the command finishes."
          : "No output."}
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
      <span className="truncate">{props.title || "(untitled)"}</span>
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
  readonly pathPrefix?: string;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {props.steps.map((step, index) => (
        // Steps are derived from an immutable command string.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index}>
          <StepView
            step={step}
            path={`${props.pathPrefix ?? ""}${index}`}
            onSectionClick={props.onSectionClick}
          />
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
  readonly path: string;
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
            {step.label === "Detached" ? (
              <span className="ms-2 text-xs text-muted-foreground">
                keeps running after the command returns
              </span>
            ) : null}
            {step.background ? (
              <Badge variant="outline" size="sm" className="ms-2">
                in background
              </Badge>
            ) : null}
          </div>
          <div className="ms-1.5 border-s border-border/70 ps-3">
            <StepList
              steps={step.body}
              pathPrefix={`${props.path}.`}
              onSectionClick={props.onSectionClick}
            />
          </div>
          {step.elseBody ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">Otherwise</span>
              <div className="ms-1.5 border-s border-border/70 ps-3">
                <StepList
                  steps={step.elseBody}
                  pathPrefix={`${props.path}.e`}
                  onSectionClick={props.onSectionClick}
                />
              </div>
            </>
          ) : null}
        </div>
      );
    case "run":
      return <RunStepView step={step} path={props.path} onSectionClick={props.onSectionClick} />;
  }
}

function StepTimingBadge({ timing }: { readonly timing: StepTiming }) {
  const { runningSinceMs, runs } = timing;
  // Activity is sampled every few seconds, so only a single long run gets a ticking timer;
  // repeated short runs (loop bodies) would keep ticking after each one exits.
  const label =
    runs > 1
      ? runningSinceMs === null
        ? `${runs} runs${timing.finishedMs >= 3_000 ? ` · ≈${formatElapsedMs(timing.finishedMs)}` : ""}`
        : `running · run ${runs}`
      : null;
  return (
    <Badge
      variant={runningSinceMs === null ? "outline" : "info"}
      size="sm"
      className="order-last ms-auto shrink-0"
    >
      {label ??
        (runningSinceMs === null ? (
          `≈${formatElapsedMs(timing.finishedMs)}`
        ) : (
          <span
            ref={tickTextContent(
              (nowMs) => `running ${formatElapsedMs(Math.max(0, nowMs - runningSinceMs))}`,
              true,
            )}
            className="tabular-nums"
          />
        ))}
    </Badge>
  );
}

function RunStepView(props: {
  readonly step: Extract<ShellStep, { kind: "run" }>;
  readonly path: string;
  readonly onSectionClick: (marker: string) => void;
}) {
  const { step } = props;
  const timing = use(StepTimingCtx).get(props.path);
  const mainCommand = step.words.map((word) => word.raw).join(" ");
  const badges = [
    ...(step.background ? ["in background"] : []),
    ...step.wrappers,
    ...step.env,
    ...describeShellRedirects(step.redirects),
  ];
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="flex min-w-0 items-baseline">
        <ConnectorLabel connector={step.connector} />
        {timing ? <StepTimingBadge timing={timing} /> : null}
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
              // oxlint-disable-next-line react/no-array-index-key -- filters come from an immutable command string
              key={`f${index}`}
              variant="secondary"
              size="sm"
              title={filter.raw}
            >
              ↳ {filter.label}
            </Badge>
          ))}
          {badges.map((badge, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- badges come from an immutable command string
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
  const resolvedTheme = useRenderedAppearance();
  const themeName = resolveDiffThemeName(resolvedTheme);
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const html = highlightCodeHtml(highlighter, props.code, props.language, themeName);
  return (
    <div
      className="font-mono text-xs leading-relaxed [&_.shiki]:!bg-transparent [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
