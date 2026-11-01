/**
 * ChatGPT RPC handlers — proxy the web-facing contract to the connector daemon
 * and map its results/errors onto the contract types. Each handler requires the
 * {@link ChatGptConnector} service, which the server runtime provides.
 *
 * @module chatgpt/handlers
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import {
  type ChatGptAccount,
  type ChatGptConversationPage,
  type ChatGptConversationSummary,
  type ChatGptGetConversationInput,
  type ChatGptListConversationsInput,
  type ChatGptMessage,
  ChatGptConnectorError,
  type ChatGptOverview,
  type ChatGptSearchHit,
  type ChatGptSearchInput,
  type ChatGptSearchResults,
  type ChatGptSendEvent,
  type ChatGptSendInput,
  type ChatGptSyncStatus,
} from "@t3tools/contracts";

import {
  ChatGptConnector,
  type ChatGptConnectorError as ConnectorError,
} from "./ChatGptConnector.ts";
import type {
  ConnectorAccount,
  ConnectorConversationSummary,
  ConnectorMessage,
  ConnectorSearchHit,
  ConnectorSyncStatus,
} from "./connectorProtocol.ts";

const isUnavailable = (detail: string): boolean =>
  /ECONNREFUSED|ENOENT|connect|refused|no such file/i.test(detail);

const toContractError = (e: ConnectorError): ChatGptConnectorError =>
  new ChatGptConnectorError({
    reason: isUnavailable(e.detail) ? "unavailable" : "failed",
    detail: e.detail.length > 0 ? e.detail : "connector error",
  });

const toAccount = (a: ConnectorAccount): ChatGptAccount => ({
  id: a.id as ChatGptAccount["id"],
  email: a.email as ChatGptAccount["email"],
  label: a.label as ChatGptAccount["label"],
  structure: a.structure as ChatGptAccount["structure"],
  plan: a.plan as ChatGptAccount["plan"],
  lastSyncedAt: a.lastSyncedAt,
  conversationCount: a.conversationCount as ChatGptAccount["conversationCount"],
  authValidAt: a.authValidAt,
});

const toStatus = (s: ConnectorSyncStatus): ChatGptSyncStatus => ({
  accountId: s.accountId as ChatGptSyncStatus["accountId"],
  running: s.running,
  lastSyncedAt: s.lastSyncedAt,
  conversations: s.conversations as ChatGptSyncStatus["conversations"],
  detailedConversations: s.detailedConversations as ChatGptSyncStatus["detailedConversations"],
  messages: s.messages as ChatGptSyncStatus["messages"],
  chunks: s.chunks as ChatGptSyncStatus["chunks"],
  embeddedChunks: s.embeddedChunks as ChatGptSyncStatus["embeddedChunks"],
});

const toSummary = (c: ConnectorConversationSummary): ChatGptConversationSummary => ({
  id: c.id as ChatGptConversationSummary["id"],
  accountId: c.accountId as ChatGptConversationSummary["accountId"],
  title: c.title,
  snippet: c.snippet,
  gizmoId: c.gizmoId,
  createTime: c.createTime,
  updateTime: c.updateTime,
  isArchived: c.isArchived,
  isStarred: c.isStarred,
  model: c.model,
});

const toHit = (h: ConnectorSearchHit): ChatGptSearchHit => ({
  chunkId: h.chunkId as ChatGptSearchHit["chunkId"],
  conversationId: h.conversationId as ChatGptSearchHit["conversationId"],
  messageId: h.messageId as ChatGptSearchHit["messageId"],
  accountId: h.accountId as ChatGptSearchHit["accountId"],
  title: h.title,
  role: h.role as ChatGptSearchHit["role"],
  snippet: h.snippet,
  createTime: h.createTime,
  score: h.score,
});

const toMessage = (m: ConnectorMessage): ChatGptMessage => ({
  id: m.id as ChatGptMessage["id"],
  conversationId: m.conversationId as ChatGptMessage["conversationId"],
  accountId: m.accountId as ChatGptMessage["accountId"],
  role: m.role as ChatGptMessage["role"],
  author: m.author,
  createTime: m.createTime,
  position: m.position as ChatGptMessage["position"],
  content: m.content,
});

export const chatgptGetOverview: Effect.Effect<
  ChatGptOverview,
  ChatGptConnectorError,
  ChatGptConnector
> = Effect.gen(function* () {
  const connector = yield* ChatGptConnector;
  const accounts = yield* connector.listAccounts();
  const status = yield* connector.syncStatus();
  return { accounts: accounts.map(toAccount), status: status.map(toStatus) };
}).pipe(Effect.mapError(toContractError));

export const chatgptListConversations = Effect.fn("chatgptListConversations")(function* (
  input: ChatGptListConversationsInput,
) {
  const connector = yield* ChatGptConnector;
  const page = yield* connector.listConversations(input);
  return {
    items: page.items.map(toSummary),
    total: page.total as ChatGptConversationPage["total"],
  };
}, Effect.mapError(toContractError));

export const chatgptSearch = Effect.fn("chatgptSearch")(function* (input: ChatGptSearchInput) {
  const connector = yield* ChatGptConnector;
  const results = yield* connector.search(input);
  return {
    hits: results.hits.map(toHit),
    tookMs: results.tookMs as ChatGptSearchResults["tookMs"],
  };
}, Effect.mapError(toContractError));

export const chatgptGetConversation = Effect.fn("chatgptGetConversation")(function* (
  input: ChatGptGetConversationInput,
) {
  const connector = yield* ChatGptConnector;
  const detail = yield* connector.getConversation(input.conversationId);
  return { summary: toSummary(detail.summary), messages: detail.messages.map(toMessage) };
}, Effect.mapError(toContractError));

export const chatgptSend = (
  input: ChatGptSendInput,
): Stream.Stream<ChatGptSendEvent, ChatGptConnectorError, ChatGptConnector> =>
  Stream.unwrap(
    ChatGptConnector.pipe(
      Effect.map((connector) =>
        connector
          .send({
            ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
            ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
            text: input.text,
          })
          .pipe(
            Stream.map((e): ChatGptSendEvent => ({
              content: e.content,
              done: e.done,
              conversationId: e.conversationId as ChatGptSendEvent["conversationId"],
            })),
            Stream.mapError(toContractError),
          ),
      ),
    ),
  );
