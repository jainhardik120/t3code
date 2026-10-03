import { useAtomValue } from "@effect/atom-react";
import { Loader2Icon, MessageSquareTextIcon, SendIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  pendingSendAtom,
  selectedChatIdAtom,
  targetMessageIdAtom,
  useChatGptConversation,
  useChatGptSend,
} from "../../state/chatgpt";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { formatChatTime } from "./chatgptFormat";

const ROLE_LABEL: Record<string, string> = {
  user: "You",
  assistant: "ChatGPT",
  system: "System",
  tool: "Tool",
};

function Composer({ conversationId }: { readonly conversationId: string | null }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { send } = useChatGptSend();
  const pending = useAtomValue(pendingSendAtom);
  const inputRef = useRef<HTMLInputElement>(null);

  // Disabled only while a reply is actively streaming; re-enables the moment the
  // reply finishes (the persist that follows happens in the background).
  const streaming = pending !== null && !pending.done;

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || streaming) return;
    setDraft("");
    setError(null);
    void send({ conversationId, text }).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setDraft(text);
      }
      inputRef.current?.focus();
    });
  };

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="mx-auto flex max-w-3xl items-center gap-2"
      >
        <Input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={streaming ? "Waiting for ChatGPT…" : "Message ChatGPT…"}
          className="flex-1"
          aria-label="Message ChatGPT"
          disabled={streaming}
        />
        <button
          type="submit"
          disabled={streaming || draft.trim().length === 0}
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity",
            (streaming || draft.trim().length === 0) && "opacity-50",
          )}
          aria-label="Send"
        >
          {streaming ? <Loader2Icon className="size-4 animate-spin" /> : <SendIcon className="size-4" />}
        </button>
      </form>
      {error && <p className="mx-auto mt-1.5 max-w-3xl text-xs text-destructive">{error}</p>}
    </div>
  );
}

const messageDomId = (id: string) => `chatgpt-msg-${id}`;

function MessageTurn({
  role,
  content,
  time,
  domId,
  highlighted,
  streaming,
}: {
  readonly role: string;
  readonly content: string;
  readonly time?: string | undefined;
  readonly domId?: string | undefined;
  readonly highlighted?: boolean;
  readonly streaming?: boolean;
}) {
  return (
    <div {...(domId ? { id: domId } : {})} className="group flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{ROLE_LABEL[role] ?? role}</span>
        {time && <span className="text-[10px] text-muted-foreground">· {time}</span>}
        {content.length > 0 && (
          <MessageCopyButton
            text={content}
            variant="ghost"
            className="ml-auto opacity-0 transition-opacity group-hover:opacity-100"
          />
        )}
      </div>
      <div
        className={cn(
          "rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-colors",
          role === "user" ? "bg-accent/60" : "bg-card",
          highlighted && "ring-2 ring-primary/60",
        )}
      >
        {content.length > 0 ? (
          <ChatMarkdown text={content} cwd={undefined} lineBreaks={role === "user"} />
        ) : (
          <span className="text-sm text-muted-foreground">Thinking…</span>
        )}
        {streaming && (
          <span className="ml-0.5 inline-block h-3.5 w-[3px] translate-y-0.5 animate-pulse rounded-full bg-foreground/60" />
        )}
      </div>
    </div>
  );
}

/** The in-flight send, rendered live from the streamed deltas. */
function PendingTurns({
  contextConversationId,
  persistedLastUserText,
}: {
  readonly contextConversationId: string | null;
  readonly persistedLastUserText: string | null;
}) {
  const pending = useAtomValue(pendingSendAtom);
  const anchorRef = useRef<HTMLDivElement>(null);

  const relevant =
    pending !== null &&
    (contextConversationId === null
      ? pending.targetConversationId === null
      : contextConversationId === pending.targetConversationId ||
        contextConversationId === pending.conversationId);

  // Follow the reply as it streams.
  useEffect(() => {
    if (relevant) anchorRef.current?.scrollIntoView({ block: "end" });
  }, [relevant, pending?.assistantText]);

  if (pending === null || !relevant) return null;
  // Once the persisted conversation already carries this exchange, defer to it.
  if (persistedLastUserText !== null && persistedLastUserText === pending.userText) return null;
  return (
    <>
      <MessageTurn role="user" content={pending.userText} />
      <MessageTurn role="assistant" content={pending.assistantText} streaming={!pending.done} />
      <div ref={anchorRef} />
    </>
  );
}

function ConversationView({ conversationId }: { readonly conversationId: string }) {
  const { detail, waiting, error } = useChatGptConversation(conversationId);
  const targetMessageId = useAtomValue(targetMessageIdAtom);

  // When opened from a search hit, scroll the matched message into view.
  useEffect(() => {
    if (detail === null || targetMessageId === null) return;
    const el = document.getElementById(messageDomId(targetMessageId));
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [detail, targetMessageId]);

  if (error) return <p className="p-6 text-sm text-destructive">{error}</p>;
  if (detail === null) {
    return <p className="p-6 text-sm text-muted-foreground">{waiting ? "Opening…" : "Not found."}</p>;
  }
  const lastUserText =
    [...detail.messages].reverse().find((m) => m.role === "user")?.content ?? null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
      {detail.messages.map((message) => (
        <MessageTurn
          key={message.id}
          domId={messageDomId(message.id)}
          role={message.role}
          content={message.content}
          time={formatChatTime(message.createTime) || undefined}
          highlighted={message.id === targetMessageId}
        />
      ))}
      <PendingTurns contextConversationId={conversationId} persistedLastUserText={lastUserText} />
    </div>
  );
}

export function ChatGptPage() {
  const conversationId = useAtomValue(selectedChatIdAtom);
  const pending = useAtomValue(pendingSendAtom);
  const { detail } = useChatGptConversation(conversationId);
  const title = conversationId ? (detail?.summary.title ?? "ChatGPT") : "ChatGPT";
  const newChatStreaming =
    conversationId === null && pending !== null && pending.targetConversationId === null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {!isElectron && (
          <header
            className={cn(
              "workspace-topbar px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <WorkspaceBreadcrumb ariaLabel="ChatGPT breadcrumb">
              <WorkspaceBreadcrumbItem current>{title}</WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </header>
        )}

        {conversationId === null ? (
          <>
            {newChatStreaming ? (
              <ScrollArea className="min-h-0 flex-1">
                <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
                  <PendingTurns contextConversationId={null} persistedLastUserText={null} />
                </div>
              </ScrollArea>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                <MessageSquareTextIcon className="size-10 opacity-50" />
                <p className="text-sm">Pick a conversation from the sidebar, or start a new one below.</p>
              </div>
            )}
            <Composer conversationId={null} />
          </>
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <ConversationView conversationId={conversationId} />
            </ScrollArea>
            <Composer conversationId={conversationId} />
          </>
        )}
      </div>
    </SidebarInset>
  );
}
