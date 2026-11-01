import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CpuIcon, LoaderCircleIcon, PowerIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import type { AgentActivitySummary } from "../../state/agentActivity";
import { useForceStopThread } from "../chat/useForceStopThread";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Memory and CPU of the thread's agent process tree, with a stop control on hover. */
export function SidebarThreadActivity(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly summary: AgentActivitySummary;
}) {
  const { canForceStop, stoppingThreadId, forceStopThread } = useForceStopThread(
    props.environmentId,
  );
  const stopping = stoppingThreadId === props.threadId;
  const description = `${props.summary.processCount} agent ${props.summary.processCount === 1 ? "process" : "processes"}${props.summary.warm ? ", kept warm after the last turn" : ""}`;

  return (
    <span className="inline-flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "inline-flex items-center gap-1 font-mono tabular-nums",
                props.summary.warm && "text-muted-foreground/70",
              )}
            />
          }
        >
          <CpuIcon aria-hidden className="size-3 shrink-0" />
          {props.summary.label}
        </TooltipTrigger>
        <TooltipPopup side="top">{description}</TooltipPopup>
      </Tooltip>
      {canForceStop ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Stop agent processes"
                disabled={stoppingThreadId !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void forceStopThread(props.threadId);
                }}
                className={cn(
                  "inline-flex cursor-pointer items-center rounded-sm p-0.5 text-muted-foreground opacity-0 outline-none hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-any-hover/sidebar-row:opacity-100",
                  stopping && "opacity-100",
                )}
              />
            }
          >
            {stopping ? (
              <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
            ) : (
              <PowerIcon aria-hidden className="size-3" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">Stop the agent and its processes</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
