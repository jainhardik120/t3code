// ChatGPT connector state. The connector is one local daemon the server proxies to, so these
// atoms target the primary environment instead of merging every connected one.
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  ChatGptConversationDetail,
  ChatGptConversationPage,
  ChatGptGetConversationInput,
  ChatGptListConversationsInput,
  ChatGptOverview,
  ChatGptSearchInput,
  ChatGptSearchResults,
  ChatGptSendEvent,
  ChatGptSendInput,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { useAtomCommand } from "./use-atom-command";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const primaryEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  const presentations = get(environmentPresentations.presentationsAtom);
  for (const [environmentId] of presentations) return environmentId;
  return null;
});

/** The conversation currently open in the main pane (chosen from the sidebar). */
export const selectedChatIdAtom = Atom.make(null as string | null);

/** When a chat is opened from a search hit, the message to scroll to/highlight. */
export const targetMessageIdAtom = Atom.make(null as string | null);

export interface OverviewState {
  readonly waiting: boolean;
  readonly error: string | null;
  readonly overview: ChatGptOverview | null;
}

const overviewAtom = Atom.make((get): OverviewState => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return { waiting: false, error: "No environment connected.", overview: null };
  }
  const result = get(serverEnvironment.chatgptOverview({ environmentId, input: undefined }));
  return {
    waiting: result.waiting,
    error:
      result._tag === "Failure"
        ? "The ChatGPT connector isn’t reachable. Is the daemon running?"
        : null,
    overview: Option.getOrNull(AsyncResult.value(result)),
  };
}).pipe(Atom.withLabel("web-chatgpt:overview"));

export const useChatGptOverview = (): OverviewState => useAtomValue(overviewAtom);

export interface SearchState {
  readonly waiting: boolean;
  readonly error: string | null;
  readonly results: ChatGptSearchResults | null;
}

const searchAtom = Atom.family((key: string) =>
  Atom.make((get): SearchState => {
    const environmentId = get(primaryEnvironmentIdAtom);
    const parsed = JSON.parse(key) as { text: string; limit: number };
    if (environmentId === null || parsed.text.length === 0) {
      return { waiting: false, error: null, results: null };
    }
    const input = {
      text: parsed.text as ChatGptSearchInput["text"],
      limit: parsed.limit as ChatGptSearchInput["limit"],
    };
    const result = get(serverEnvironment.chatgptSearch({ environmentId, input }));
    return {
      waiting: result.waiting,
      error: result._tag === "Failure" ? "Search failed." : null,
      results: Option.getOrNull(AsyncResult.value(result)),
    };
  }).pipe(Atom.withLabel(`web-chatgpt:search:${key}`)),
);

export const useChatGptSearch = (text: string, limit = 20): SearchState => {
  const key = JSON.stringify({ text: text.trim(), limit });
  return useAtomValue(searchAtom(key));
};

export interface ConversationsState {
  readonly waiting: boolean;
  readonly error: string | null;
  readonly page: ChatGptConversationPage | null;
}

const conversationsAtom = Atom.family((key: string) =>
  Atom.make((get): ConversationsState => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null) return { waiting: false, error: null, page: null };
    const parsed = JSON.parse(key) as { limit: number; offset: number };
    const input = {
      limit: parsed.limit as NonNullable<ChatGptListConversationsInput["limit"]>,
      offset: parsed.offset as NonNullable<ChatGptListConversationsInput["offset"]>,
    };
    const result = get(serverEnvironment.chatgptConversations({ environmentId, input }));
    return {
      waiting: result.waiting,
      error: result._tag === "Failure" ? "Couldn’t load conversations." : null,
      page: Option.getOrNull(AsyncResult.value(result)),
    };
  }).pipe(Atom.withLabel(`web-chatgpt:conversations:${key}`)),
);

export const useChatGptConversations = (limit = 100, offset = 0): ConversationsState => {
  const key = JSON.stringify({ limit, offset });
  return useAtomValue(conversationsAtom(key));
};

export interface ConversationState {
  readonly waiting: boolean;
  readonly error: string | null;
  readonly detail: ChatGptConversationDetail | null;
}

const conversationAtom = Atom.family((conversationId: string) =>
  Atom.make((get): ConversationState => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null || conversationId.length === 0) {
      return { waiting: false, error: null, detail: null };
    }
    const input = {
      conversationId: conversationId as ChatGptGetConversationInput["conversationId"],
    };
    const result = get(serverEnvironment.chatgptConversation({ environmentId, input }));
    return {
      waiting: result.waiting,
      error: result._tag === "Failure" ? "Couldn’t open this conversation." : null,
      detail: Option.getOrNull(AsyncResult.value(result)),
    };
  }).pipe(Atom.withLabel(`web-chatgpt:conversation:${conversationId}`)),
);

export const useChatGptConversation = (conversationId: string | null): ConversationState =>
  useAtomValue(conversationAtom(conversationId ?? ""));

/** The page size the sidebar browses with — kept in sync so sends can refresh it. */
const CHATGPT_BROWSE_LIMIT = 200;

export interface SendResultState {
  readonly ok: boolean;
  readonly conversationId: string | null;
  readonly error: string | null;
}

/**
 * The send currently in flight, if any — the optimistic user message plus the
 * assistant reply as it streams. The page renders these bubbles live; they're
 * cleared once the persisted conversation (which then contains the same turns)
 * lands. `targetConversationId` is the chat being continued, or null for a new one.
 */
export interface PendingSend {
  /** Identifies this send so a slow prior persist can't clobber a newer one. */
  readonly sendId: number;
  readonly targetConversationId: string | null;
  readonly conversationId: string | null;
  readonly userText: string;
  readonly assistantText: string;
  readonly done: boolean;
}

export const pendingSendAtom = Atom.make<PendingSend | null>(null);

let sendCounter = 0;

/**
 * Send a message to ChatGPT, streaming the reply. The connector drives the real
 * composer and streams the assistant text back token-by-token; each delta updates
 * {@link pendingSendAtom} so the UI renders it live. On completion it refreshes the
 * open conversation, the browse list, and the overview so the persisted turns land.
 */
export const useChatGptSend = (): {
  readonly send: (input: {
    readonly conversationId: string | null;
    readonly text: string;
  }) => Promise<SendResultState>;
} => {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const registry = useContext(RegistryContext);
  const setPending = useAtomSet(pendingSendAtom);
  const setSelectedChatId = useAtomSet(selectedChatIdAtom);
  const dispatch = useAtomCommand(serverEnvironment.chatgptSend, { reportFailure: false });

  const send = async (input: {
    readonly conversationId: string | null;
    readonly text: string;
  }): Promise<SendResultState> => {
    if (environmentId === null) {
      return { ok: false, conversationId: null, error: "No environment connected." };
    }
    const text = input.text.trim();
    if (text.length === 0) return { ok: false, conversationId: null, error: "Message is empty." };

    const sendId = ++sendCounter;
    const mine = (prev: PendingSend | null): prev is PendingSend =>
      prev !== null && prev.sendId === sendId;

    setPending({
      sendId,
      targetConversationId: input.conversationId,
      conversationId: input.conversationId,
      userText: text,
      assistantText: "",
      done: false,
    });
    let resolvedConversationId: string | null = input.conversationId;

    const result = await dispatch({
      environmentId,
      input: {
        ...(input.conversationId
          ? {
              conversationId: input.conversationId as NonNullable<
                ChatGptSendInput["conversationId"]
              >,
            }
          : {}),
        text: text as ChatGptSendInput["text"],
      },
      onEvent: (event: ChatGptSendEvent) => {
        if (event.conversationId) resolvedConversationId = event.conversationId;
        setPending((prev) =>
          mine(prev)
            ? {
                ...prev,
                ...(event.content.length > 0 ? { assistantText: event.content } : {}),
                ...(event.conversationId ? { conversationId: event.conversationId } : {}),
                done: event.done,
              }
            : prev,
        );
      },
    });

    if (result._tag === "Failure") {
      setPending((prev) => (mine(prev) ? null : prev));
      return {
        ok: false,
        conversationId: null,
        error: "Couldn’t send. Is the connector daemon running and the account signed in?",
      };
    }

    // `dispatch` resolves once the stream completes — i.e. after the connector
    // has re-fetched and persisted the turns. So the refreshed queries below see
    // the new messages, and switching to a fresh chat won't flash an empty pane.
    const finalConversationId = resolvedConversationId;
    if (finalConversationId !== null) {
      registry.refresh(
        serverEnvironment.chatgptConversation({
          environmentId,
          input: {
            conversationId: finalConversationId as ChatGptGetConversationInput["conversationId"],
          },
        }),
      );
    }
    registry.refresh(
      serverEnvironment.chatgptConversations({
        environmentId,
        input: {
          limit: CHATGPT_BROWSE_LIMIT as NonNullable<ChatGptListConversationsInput["limit"]>,
          offset: 0 as NonNullable<ChatGptListConversationsInput["offset"]>,
        },
      }),
    );
    registry.refresh(serverEnvironment.chatgptOverview({ environmentId, input: undefined }));

    // A brand-new chat: switch the pane to it now that it's persisted.
    if (input.conversationId === null && finalConversationId !== null) {
      setSelectedChatId(finalConversationId);
    }

    // Keep the streamed bubbles up until the persisted refetch lands, then clear
    // (only if a newer send hasn't taken over).
    setPending((prev) => (mine(prev) ? { ...prev, done: true } : prev));
    setTimeout(() => setPending((prev) => (mine(prev) ? null : prev)), 1000);

    return { ok: true, conversationId: finalConversationId, error: null };
  };

  return { send };
};
