// Mirror of the separately installed ChatGPT connector's socket RPC contract
// (~/code/chatgpt-connector); method names must match its `connector.*`.
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

export class ConnectorSearchError extends Schema.TaggedError<ConnectorSearchError>()(
  "SearchError",
  {
    reason: Schema.Literals(["embed", "query", "rerank"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class ConnectorStoreError extends Schema.TaggedError<ConnectorStoreError>()("StoreError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// ChatGPT returns timestamps as either epoch seconds or ISO strings depending on
// the endpoint/account; accept both on the wire.
const Timestamp = Schema.NullOr(Schema.Union([Schema.Number, Schema.String]));

export const ConnectorPing = Schema.Struct({
  protocolVersion: Schema.Number,
  daemonVersion: Schema.String,
});
export type ConnectorPing = typeof ConnectorPing.Type;

export const ConnectorSyncStatus = Schema.Struct({
  accountId: Schema.String,
  running: Schema.Boolean,
  lastSyncedAt: Schema.NullOr(Schema.String),
  conversations: Schema.Number,
  detailedConversations: Schema.Number,
  messages: Schema.Number,
  chunks: Schema.Number,
  embeddedChunks: Schema.Number,
});
export type ConnectorSyncStatus = typeof ConnectorSyncStatus.Type;

export const ConnectorAccount = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  label: Schema.String,
  structure: Schema.String,
  plan: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(Schema.String),
  conversationCount: Schema.Number,
  authValidAt: Schema.NullOr(Schema.Number),
});
export type ConnectorAccount = typeof ConnectorAccount.Type;

export const ConnectorConversationSummary = Schema.Struct({
  id: Schema.String,
  accountId: Schema.String,
  title: Schema.String,
  snippet: Schema.NullOr(Schema.String),
  gizmoId: Schema.NullOr(Schema.String),
  createTime: Timestamp,
  updateTime: Timestamp,
  isArchived: Schema.Boolean,
  isStarred: Schema.Boolean,
  model: Schema.NullOr(Schema.String),
});
export type ConnectorConversationSummary = typeof ConnectorConversationSummary.Type;

export const ConnectorSearchHit = Schema.Struct({
  chunkId: Schema.Number,
  conversationId: Schema.String,
  messageId: Schema.String,
  accountId: Schema.String,
  title: Schema.String,
  role: Schema.String,
  snippet: Schema.String,
  createTime: Timestamp,
  score: Schema.Number,
});
export type ConnectorSearchHit = typeof ConnectorSearchHit.Type;

export const ConnectorSearchResults = Schema.Struct({
  hits: Schema.Array(ConnectorSearchHit),
  tookMs: Schema.Number,
});
export type ConnectorSearchResults = typeof ConnectorSearchResults.Type;

export const ConnectorMessage = Schema.Struct({
  id: Schema.String,
  conversationId: Schema.String,
  accountId: Schema.String,
  role: Schema.String,
  author: Schema.NullOr(Schema.String),
  createTime: Timestamp,
  position: Schema.Number,
  content: Schema.String,
  assets: Schema.Array(Schema.Unknown),
});
export type ConnectorMessage = typeof ConnectorMessage.Type;

export const ConnectorConversationDetail = Schema.Struct({
  summary: ConnectorConversationSummary,
  messages: Schema.Array(ConnectorMessage),
});
export type ConnectorConversationDetail = typeof ConnectorConversationDetail.Type;

export class ConnectorAccountNotFoundError extends Schema.TaggedError<ConnectorAccountNotFoundError>()(
  "AccountNotFoundError",
  { accountId: Schema.String },
) {}

export class ConnectorSendError extends Schema.TaggedError<ConnectorSendError>()("SendError", {
  accountId: Schema.String,
  reason: Schema.Literals(["auth", "send", "store"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const PingRpc = Rpc.make("connector.ping", { success: ConnectorPing });

const ListAccountsRpc = Rpc.make("connector.listAccounts", {
  success: Schema.Array(ConnectorAccount),
  error: ConnectorStoreError,
});

const SyncStatusRpc = Rpc.make("connector.syncStatus", {
  payload: Schema.Struct({ accountId: Schema.optional(Schema.String) }),
  success: Schema.Array(ConnectorSyncStatus),
  error: ConnectorStoreError,
});

const ListConversationsRpc = Rpc.make("connector.listConversations", {
  payload: Schema.Struct({
    accountId: Schema.optional(Schema.String),
    offset: Schema.optional(Schema.Int),
    limit: Schema.optional(Schema.Int),
    includeArchived: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    items: Schema.Array(ConnectorConversationSummary),
    total: Schema.Int,
  }),
  error: ConnectorStoreError,
});

const SearchRpc = Rpc.make("connector.search", {
  payload: Schema.Struct({
    text: Schema.String,
    limit: Schema.optional(Schema.Int),
    rerank: Schema.optional(Schema.Boolean),
  }),
  success: ConnectorSearchResults,
  error: ConnectorSearchError,
});

const GetConversationRpc = Rpc.make("connector.getConversation", {
  payload: Schema.Struct({ conversationId: Schema.String }),
  success: ConnectorConversationDetail,
  error: Schema.Union([ConnectorAccountNotFoundError, ConnectorStoreError]),
});

export const ConnectorSendEvent = Schema.Struct({
  content: Schema.String,
  done: Schema.Boolean,
  conversationId: Schema.NullOr(Schema.String),
});
export type ConnectorSendEvent = typeof ConnectorSendEvent.Type;

const SendRpc = Rpc.make("connector.send", {
  payload: Schema.Struct({
    accountId: Schema.optional(Schema.String),
    conversationId: Schema.optional(Schema.String),
    text: Schema.String,
  }),
  success: ConnectorSendEvent,
  error: Schema.Union([ConnectorAccountNotFoundError, ConnectorSendError, ConnectorStoreError]),
  stream: true,
});

export const ConnectorClientGroup = RpcGroup.make(
  PingRpc,
  ListAccountsRpc,
  SyncStatusRpc,
  ListConversationsRpc,
  SearchRpc,
  GetConversationRpc,
  SendRpc,
);
