// Client to the local ChatGPT connector daemon over its Unix socket. Each call opens a
// short-lived client, so the service stays stateless.
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import { NodeSocket } from "@effect/platform-node";

import {
  type ConnectorAccount,
  type ConnectorConversationDetail,
  type ConnectorConversationSummary,
  ConnectorClientGroup,
  type ConnectorPing,
  type ConnectorSearchResults,
  type ConnectorSendEvent,
  type ConnectorSyncStatus,
} from "./connectorProtocol.ts";

/** Any failure reaching or talking to the connector daemon. */
export class ChatGptConnectorError extends Data.TaggedError("ChatGptConnectorError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const connectorSocketPath = (): string => {
  const home = process.env.HOME ?? ".";
  return process.env.CHATGPT_CONNECTOR_SOCKET ?? `${home}/.chatgpt-connector/connector.sock`;
};

export interface ListConversationsInput {
  readonly accountId?: string | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
  readonly includeArchived?: boolean | undefined;
}

export class ChatGptConnector extends Context.Service<
  ChatGptConnector,
  {
    readonly ping: () => Effect.Effect<ConnectorPing, ChatGptConnectorError>;
    readonly listAccounts: () => Effect.Effect<
      ReadonlyArray<ConnectorAccount>,
      ChatGptConnectorError
    >;
    readonly syncStatus: (
      accountId?: string,
    ) => Effect.Effect<ReadonlyArray<ConnectorSyncStatus>, ChatGptConnectorError>;
    readonly listConversations: (
      input: ListConversationsInput,
    ) => Effect.Effect<
      { items: ReadonlyArray<ConnectorConversationSummary>; total: number },
      ChatGptConnectorError
    >;
    readonly search: (input: {
      readonly text: string;
      readonly limit?: number | undefined;
      readonly rerank?: boolean | undefined;
    }) => Effect.Effect<ConnectorSearchResults, ChatGptConnectorError>;
    readonly getConversation: (
      conversationId: string,
    ) => Effect.Effect<ConnectorConversationDetail, ChatGptConnectorError>;
    readonly send: (input: {
      readonly accountId?: string | undefined;
      readonly conversationId?: string | undefined;
      readonly text: string;
    }) => Stream.Stream<ConnectorSendEvent, ChatGptConnectorError>;
  }
>()("t3/chatgpt/ChatGptConnector") {}

const make = Effect.sync(() => {
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(NodeSocket.layerNet({ path: connectorSocketPath() })),
    Layer.provide(RpcSerialization.layerNdjson),
  );

  // Any transport/protocol/domain failure collapses to one T3-facing error so
  // handlers can degrade the ChatGPT surface gracefully when the daemon is down.
  const run = <A, E>(
    use: (
      client: RpcClient.FromGroup<typeof ConnectorClientGroup, RpcClientError.RpcClientError>,
    ) => Effect.Effect<A, E>,
  ): Effect.Effect<A, ChatGptConnectorError> =>
    Effect.scoped(RpcClient.make(ConnectorClientGroup).pipe(Effect.flatMap(use))).pipe(
      Effect.provide(protocol),
      Effect.mapError((cause) => new ChatGptConnectorError({ detail: String(cause), cause })),
    );

  // A streaming call keeps its client/connection alive for the stream's lifetime
  // (unwrapScoped ties the scope to the stream), collapsing failures the same way.
  const runStream = <A, E>(
    use: (
      client: RpcClient.FromGroup<typeof ConnectorClientGroup, RpcClientError.RpcClientError>,
    ) => Stream.Stream<A, E>,
  ): Stream.Stream<A, ChatGptConnectorError> =>
    Stream.unwrap(RpcClient.make(ConnectorClientGroup).pipe(Effect.map(use))).pipe(
      Stream.provide(protocol),
      Stream.mapError((cause) => new ChatGptConnectorError({ detail: String(cause), cause })),
    );

  return ChatGptConnector.of({
    ping: Effect.fn("ChatGptConnector.ping")(() => run((c) => c["connector.ping"]())),
    listAccounts: Effect.fn("ChatGptConnector.listAccounts")(() =>
      run((c) => c["connector.listAccounts"]()),
    ),
    syncStatus: Effect.fn("ChatGptConnector.syncStatus")((accountId) =>
      run((c) => c["connector.syncStatus"](accountId ? { accountId } : {})),
    ),
    listConversations: Effect.fn("ChatGptConnector.listConversations")((input) =>
      run((c) => c["connector.listConversations"](input)),
    ),
    search: Effect.fn("ChatGptConnector.search")((input) =>
      run((c) => c["connector.search"](input)),
    ),
    getConversation: Effect.fn("ChatGptConnector.getConversation")((conversationId) =>
      run((c) => c["connector.getConversation"]({ conversationId })),
    ),
    send: (input) =>
      runStream((c) =>
        c["connector.send"]({
          ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
          ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
          text: input.text,
        }),
      ),
  });
});

export const layer = Layer.effect(ChatGptConnector, make);
