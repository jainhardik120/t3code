import { useNavigate, useRouterState } from "@tanstack/react-router";

import { cn } from "../../lib/utils";

/**
 * Segmented switch at the top of the sidebar: Agent (threads) vs Chat (ChatGPT).
 * Route-driven — Chat lives under `/chatgpt`, Agent is everything else.
 */
export function ChatModeToggle() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isChat = pathname.startsWith("/chatgpt");

  const base =
    "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors text-muted-foreground";
  const active = "bg-background text-foreground shadow-sm";

  return (
    <div className="mx-[var(--sidebar-content-inset)] mt-1 flex gap-1 rounded-lg bg-muted/60 p-1">
      <button
        type="button"
        onClick={() => void navigate({ to: "/" })}
        className={cn(base, !isChat && active)}
      >
        Agent
      </button>
      <button
        type="button"
        onClick={() => void navigate({ to: "/chatgpt" })}
        className={cn(base, isChat && active)}
      >
        Chat
      </button>
    </div>
  );
}
