/**
 * ChatGPT connector contract (web ↔ server).
 *
 * The server proxies these to the locally-installed connector daemon over its
 * Unix socket. Ids are plain strings on the wire (the connector brands them
 * internally). When the daemon is absent or unhealthy the calls fail with
 * {@link ChatGptConnectorError} so the UI can degrade gracefully.
 *
 * @module chatgpt
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

// ChatGPT returns timestamps as epoch seconds or ISO strings depending on the
// endpoint/account; the connector passes them through unchanged.
const ChatGptTimestamp = Schema.NullOr(Schema.Union([Schema.Number, Schema.String]));

export const ChatGptAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  structure: TrimmedNonEmptyString,
  plan: Schema.NullOr(TrimmedNonEmptyString),
  lastSyncedAt: Schema.NullOr(Schema.String),
  conversationCount: NonNegativeInt,
  authValidAt: Schema.NullOr(Schema.Number),
});
export type ChatGptAccount = typeof ChatGptAccount.Type;

export const ChatGptSyncStatus = Schema.Struct({
  accountId: TrimmedNonEmptyString,
  running: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(Schema.String),
  conversations: NonNegativeInt,
  detailedConversations: NonNegativeInt,
  messages: NonNegativeInt,
  chunks: NonNegativeInt,
  embeddedChunks: NonNegativeInt,
});
export type ChatGptSyncStatus = typeof ChatGptSyncStatus.Type;

/** Everything the ChatGPT landing view needs in one call. */
export const ChatGptOverview = Schema.Struct({
  accounts: Schema.Array(ChatGptAccount),
  status: Schema.Array(ChatGptSyncStatus),
});
export type ChatGptOverview = typeof ChatGptOverview.Type;

export const ChatGptConversationSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  title: Schema.String,
  snippet: Schema.NullOr(Schema.String),
  gizmoId: Schema.NullOr(Schema.String),
  createTime: ChatGptTimestamp,
  updateTime: ChatGptTimestamp,
  isArchived: Schema.Boolean,
  isStarred: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
});
export type ChatGptConversationSummary = typeof ChatGptConversationSummary.Type;

export const ChatGptListConversationsInput = Schema.Struct({
  accountId: Schema.optional(TrimmedNonEmptyString),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
  includeArchived: Schema.optional(Schema.Boolean),
});
export type ChatGptListConversationsInput = typeof ChatGptListConversationsInput.Type;

export const ChatGptMessage = Schema.Struct({
  id: TrimmedNonEmptyString,
  conversationId: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  role: TrimmedNonEmptyString,
  author: Schema.NullOr(Schema.String),
  createTime: ChatGptTimestamp,
  position: NonNegativeInt,
  content: Schema.String,
});
export type ChatGptMessage = typeof ChatGptMessage.Type;

export const ChatGptConversationDetail = Schema.Struct({
  summary: ChatGptConversationSummary,
  messages: Schema.Array(ChatGptMessage),
});
export type ChatGptConversationDetail = typeof ChatGptConversationDetail.Type;

export const ChatGptGetConversationInput = Schema.Struct({
  conversationId: TrimmedNonEmptyString,
});
export type ChatGptGetConversationInput = typeof ChatGptGetConversationInput.Type;

export const ChatGptConversationPage = Schema.Struct({
  items: Schema.Array(ChatGptConversationSummary),
  total: NonNegativeInt,
});
export type ChatGptConversationPage = typeof ChatGptConversationPage.Type;

export const ChatGptSendInput = Schema.Struct({
  accountId: Schema.optional(TrimmedNonEmptyString),
  /** Continue an existing chat, or omit to start a new one. */
  conversationId: Schema.optional(TrimmedNonEmptyString),
  text: TrimmedNonEmptyString,
});
export type ChatGptSendInput = typeof ChatGptSendInput.Type;

/**
 * A streamed send event: `delta` snapshots (done=false) carry the growing reply
 * text; the final `done=true` event carries the (possibly new) conversation id.
 */
export const ChatGptSendEvent = Schema.Struct({
  content: Schema.String,
  done: Schema.Boolean,
  conversationId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ChatGptSendEvent = typeof ChatGptSendEvent.Type;

export const ChatGptSearchInput = Schema.Struct({
  text: TrimmedNonEmptyString,
  limit: Schema.optional(NonNegativeInt),
  rerank: Schema.optional(Schema.Boolean),
});
export type ChatGptSearchInput = typeof ChatGptSearchInput.Type;

export const ChatGptSearchHit = Schema.Struct({
  chunkId: NonNegativeInt,
  conversationId: TrimmedNonEmptyString,
  messageId: TrimmedNonEmptyString,
  accountId: TrimmedNonEmptyString,
  title: Schema.String,
  role: TrimmedNonEmptyString,
  snippet: Schema.String,
  createTime: ChatGptTimestamp,
  score: Schema.Number,
});
export type ChatGptSearchHit = typeof ChatGptSearchHit.Type;

export const ChatGptSearchResults = Schema.Struct({
  hits: Schema.Array(ChatGptSearchHit),
  tookMs: NonNegativeInt,
});
export type ChatGptSearchResults = typeof ChatGptSearchResults.Type;

export class ChatGptConnectorError extends Schema.TaggedError<ChatGptConnectorError>()(
  "ChatGptConnectorError",
  {
    /** `unavailable` - the daemon isn't reachable; `failed` - it errored. */
    reason: Schema.Literals(["unavailable", "failed"]),
    detail: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `ChatGPT connector ${this.reason}: ${this.detail}`;
  }
}
