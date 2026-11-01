import { useAtomValue } from "@effect/atom-react";
import type {
  AgentActivityProcess,
  EnvironmentId,
  ServerProcessSignal,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import {
  ChevronRightIcon,
  CpuIcon,
  LoaderCircleIcon,
  PowerIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import {
  agentProcessLabel,
  type AgentProcessNode,
  buildAgentProcessTree,
  formatActivityBytes,
  formatActivityCpu,
  formatSessionRelease,
  isAgentGuardProcess,
  useThreadAgentActivity,
} from "../../state/agentActivity";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { useForceStopThread } from "./useForceStopThread";

const processKey = (process: AgentActivityProcess) => `${process.pid}:${process.startTimeMs}`;
const DEFAULT_EXPANDED_DEPTH = 1;

/** The agent's live process tree: what it costs and a way to stop it. Hidden while none run. */
export function ThreadProcessesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const activity = useThreadAgentActivity(props.environmentId, props.threadId);
  const { canForceStop, stoppingThreadId, forceStopThread } = useForceStopThread(
    props.environmentId,
  );
  const canSignal = useAtomValue(
    serverEnvironment.signalProcess.permissionAtom(props.environmentId),
  );
  const signalProcess = useAtomCommand(serverEnvironment.signalProcess, {
    label: "agent process signal",
  });
  const [signalingKey, setSignalingKey] = useState<string | null>(null);
  // Collapsed past the agent's direct children; a click overrides the default per process.
  const [expandedOverrides, setExpandedOverrides] = useState<ReadonlyMap<string, boolean>>(
    () => new Map(),
  );

  if (activity === null || activity.processes.length === 0) return null;

  const signal = async (process: AgentActivityProcess, signalName: ServerProcessSignal) => {
    if (signalingKey !== null) return;
    setSignalingKey(processKey(process));
    const result = await signalProcess({
      environmentId: props.environmentId,
      input: { pid: process.pid, startTimeMs: process.startTimeMs, signal: signalName },
    });
    setSignalingKey(null);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop the process",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (!result.value.signaled && Option.isSome(result.value.message)) {
      toastManager.add(stackedThreadToast({ type: "info", title: result.value.message.value }));
    }
  };

  const toggle = (key: string, expanded: boolean) =>
    setExpandedOverrides((current) => new Map(current).set(key, !expanded));
  const visibleRows: Array<{ node: AgentProcessNode; treeDepth: number; expanded: boolean }> = [];
  const walk = (nodes: ReadonlyArray<AgentProcessNode>, treeDepth: number) => {
    for (const node of nodes) {
      const expanded =
        expandedOverrides.get(processKey(node.process)) ?? treeDepth < DEFAULT_EXPANDED_DEPTH;
      visibleRows.push({ node, treeDepth, expanded });
      if (expanded) walk(node.children, treeDepth + 1);
    }
  };
  walk(buildAgentProcessTree(activity.processes), 0);

  const release = formatSessionRelease(activity, activity.readAtMs);
  const status = activity.runStatus !== null ? "running" : (release ?? "idle");

  return (
    <ThreadDetailsSection
      headingId="thread-details-processes-heading"
      title={`Agent processes · ${formatActivityBytes(activity.usage.residentBytes)} · ${formatActivityCpu(activity.usage.cpuPercent)}`}
      actions={
        canForceStop ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone="destructive"
                  aria-label="Stop the agent and its processes"
                  disabled={stoppingThreadId !== null}
                  onClick={() => void forceStopThread(props.threadId)}
                />
              }
            >
              {stoppingThreadId === props.threadId ? (
                <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
              ) : (
                <PowerIcon aria-hidden className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="left">
              Stop the agent and every process it started. The thread resumes on your next message.
            </TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      <p className="mb-1 px-2.5 text-2xs text-muted-foreground">
        {activity.usage.processCount} {activity.usage.processCount === 1 ? "process" : "processes"}{" "}
        · {status}
      </p>
      <ul data-thread-processes-list className="m-0 max-h-72 list-none overflow-y-auto p-0">
        {visibleRows.map(({ node, treeDepth, expanded }) => {
          const { process } = node;
          const key = processKey(process);
          const busy = signalingKey === key;
          const guard = isAgentGuardProcess(process);
          const signalable = canSignal && !guard;
          const hasChildren = node.children.length > 0;
          const showTotal = hasChildren && !expanded;
          return (
            <li key={key} className="group relative flex items-center rounded-lg">
              <ThreadDetailsControl
                size="sm"
                variant="ghost"
                part="row"
                multiline
                {...(hasChildren
                  ? {
                      "aria-expanded": expanded,
                      onClick: () => toggle(key, expanded),
                    }
                  : {})}
              >
                <span
                  className="flex shrink-0 items-center"
                  style={{ paddingInlineStart: `${Math.min(treeDepth, 6) * 0.75}rem` }}
                >
                  {hasChildren ? (
                    <ChevronRightIcon
                      aria-hidden
                      className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, expanded && "rotate-90")}
                    />
                  ) : (
                    <CpuIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  )}
                </span>
                <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5", signalable && "pe-12")}>
                  <span
                    className={cn(
                      "truncate text-xs leading-4",
                      guard ? "text-muted-foreground" : "font-mono text-foreground/85",
                    )}
                  >
                    {agentProcessLabel(process)}
                  </span>
                  <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
                    {showTotal
                      ? `${formatActivityCpu(node.total.cpuPercent)} · ${formatActivityBytes(node.total.residentBytes)} · ${node.total.count} processes`
                      : `${formatActivityCpu(process.cpuPercent)} · ${formatActivityBytes(process.residentBytes)} · pid ${process.pid}`}
                    {guard ? " · stops the agent if T3 exits" : ""}
                  </span>
                </span>
              </ThreadDetailsControl>
              {signalable ? (
                <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          aria-label={`Interrupt pid ${process.pid}`}
                          disabled={signalingKey !== null}
                          onClick={() => void signal(process, "SIGINT")}
                        />
                      }
                    >
                      {busy ? (
                        <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
                      ) : (
                        <SquareIcon aria-hidden className="size-3 fill-current" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup side="left">Interrupt (SIGINT)</TooltipPopup>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <ThreadDetailsControl
                          size="icon-xs"
                          variant="ghost"
                          part="icon"
                          tone="destructive"
                          aria-label={`Kill pid ${process.pid}`}
                          disabled={signalingKey !== null}
                          onClick={() => void signal(process, "SIGKILL")}
                        />
                      }
                    >
                      <XIcon aria-hidden className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="left">Kill (SIGKILL)</TooltipPopup>
                  </Tooltip>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
