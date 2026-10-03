import { useNavigate } from "@tanstack/react-router";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  selectedChatIdAtom,
  targetMessageIdAtom,
  useChatGptConversations,
  useChatGptOverview,
  useChatGptSearch,
} from "../../state/chatgpt";
import { Input } from "../ui/input";
import { SidebarContent } from "../ui/sidebar";
import { SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { ChatModeToggle } from "./ChatModeToggle";
import { formatChatTime } from "./chatgptFormat";

function ChatRow({
  title,
  subtitle,
  time,
  active,
  onClick,
}: {
  readonly title: string;
  readonly subtitle: string | null;
  readonly time: string;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent",
        active && "bg-sidebar-accent",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm text-sidebar-foreground">{title}</span>
        {time && <span className="shrink-0 text-[10px] text-muted-foreground">{time}</span>}
      </div>
      {subtitle && (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>
      )}
    </button>
  );
}

export function ChatGptSidebar() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useAtom(selectedChatIdAtom);
  const setTargetMessage = useAtomSet(targetMessageIdAtom);

  const { overview } = useChatGptOverview();
  const account = overview?.accounts[0];
  const status = overview?.status[0];

  const search = useChatGptSearch(query);
  const browse = useChatGptConversations(200);

  const open = (id: string, messageId: string | null) => {
    setSelectedId(id);
    setTargetMessage(messageId);
    void navigate({ to: "/chatgpt" });
  };

  const rows =
    query.length > 0
      ? (search.results?.hits ?? []).map((h) => ({
          key: `${h.chunkId}`,
          id: h.conversationId,
          messageId: h.messageId,
          title: h.title,
          subtitle: h.snippet,
          time: formatChatTime(h.createTime),
        }))
      : (browse.page?.items ?? []).map((c) => ({
          key: c.id,
          id: c.id,
          messageId: null,
          title: c.title,
          subtitle: c.snippet,
          time: formatChatTime(c.updateTime),
        }));

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <ChatModeToggle />
      <div className="px-[var(--sidebar-content-inset)] pt-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setQuery(draft.trim());
            }}
            placeholder="Search chats…"
            className="h-8 pl-8 text-sm"
            aria-label="Search ChatGPT history"
          />
        </div>
        {account && status && (
          <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
            {account.email} ·{" "}
            {status.detailedConversations < status.conversations
              ? `loaded ${status.detailedConversations.toLocaleString()}/${status.conversations.toLocaleString()} chats`
              : `${status.conversations.toLocaleString()} chats`}
          </p>
        )}
      </div>
      <SidebarContent className="px-[var(--sidebar-content-inset)] py-2">
        {query.length > 0 && search.waiting && search.results === null && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Searching…</p>
        )}
        {query.length > 0 && search.results && search.results.hits.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">No matches.</p>
        )}
        {query.length === 0 && browse.page === null && (
          <p className="px-2 py-1 text-xs text-muted-foreground">Loading chats…</p>
        )}
        <div className="flex flex-col gap-0.5">
          {rows.map((row) => (
            <ChatRow
              key={row.key}
              title={row.title}
              subtitle={row.subtitle}
              time={row.time}
              active={row.id === selectedId}
              onClick={() => open(row.id, row.messageId)}
            />
          ))}
        </div>
      </SidebarContent>
    </>
  );
}
