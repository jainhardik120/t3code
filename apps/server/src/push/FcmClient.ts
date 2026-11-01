// @effect-diagnostics nodeBuiltinImport:off - RS256 signing of the Google service-account JWT needs node:crypto.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export class FcmError extends Data.TaggedError("FcmError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// Minimal view of a Google service-account JSON; only the fields required to
// mint an FCM HTTP v1 access token.
const FcmServiceAccountJson = Schema.Struct({
  project_id: Schema.String,
  client_email: Schema.String,
  private_key: Schema.String,
  token_uri: Schema.optional(Schema.String),
});

export interface FcmServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly tokenUri: string;
}

const decodeServiceAccountJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FcmServiceAccountJson),
);

export const parseServiceAccount = (json: string): Effect.Effect<FcmServiceAccount, FcmError> =>
  decodeServiceAccountJson(json).pipe(
    Effect.map((account): FcmServiceAccount => ({
      projectId: account.project_id,
      clientEmail: account.client_email,
      privateKey: account.private_key,
      tokenUri: account.token_uri ?? DEFAULT_TOKEN_URI,
    })),
    Effect.mapError(
      (cause) => new FcmError({ message: "Invalid FCM service-account JSON.", cause }),
    ),
  );

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// RS256-signed JWT bearer assertion for the Google OAuth2 token exchange.
function signServiceAccountJwt(account: FcmServiceAccount, nowSeconds: number): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: account.tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = NodeCrypto.createSign("RSA-SHA256")
    .update(signingInput)
    .sign(account.privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

export interface FcmAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export const mintAccessToken = (
  account: FcmServiceAccount,
): Effect.Effect<FcmAccessToken, FcmError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const assertion = yield* Effect.try({
      try: () => signServiceAccountJwt(account, Math.floor(nowMs / 1_000)),
      catch: (cause) => new FcmError({ message: "Failed to sign FCM service-account JWT.", cause }),
    });
    const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* HttpClientRequest.post(account.tokenUri).pipe(
      HttpClientRequest.bodyUrlParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GoogleTokenResponse)),
      Effect.mapError((cause) => new FcmError({ message: "FCM token exchange failed.", cause })),
    );
    return {
      accessToken: response.access_token,
      expiresAtMs: nowMs + response.expires_in * 1_000,
    };
  });

export interface FcmMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data: Record<string, string>;
  readonly androidChannelId: string;
}

export interface FcmSendResult {
  readonly ok: boolean;
  readonly status: number;
  // FCM 404 means the registration token is no longer valid and should be
  // dropped so the server stops trying to reach a dead install.
  readonly unregistered: boolean;
}

export const sendMessage = (input: {
  readonly accessToken: string;
  readonly projectId: string;
  readonly message: FcmMessage;
}): Effect.Effect<FcmSendResult, FcmError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = `https://fcm.googleapis.com/v1/projects/${input.projectId}/messages:send`;
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(input.accessToken),
      HttpClientRequest.bodyJson({
        message: {
          token: input.message.token,
          notification: {
            title: input.message.title,
            body: input.message.body,
          },
          data: input.message.data,
          android: {
            priority: "high",
            notification: {
              channel_id: input.message.androidChannelId,
            },
          },
        },
      }),
      Effect.flatMap(httpClient.execute),
      Effect.mapError((cause) => new FcmError({ message: "FCM send request failed.", cause })),
    );
    const status = response.status;
    return {
      ok: status >= 200 && status < 300,
      status,
      unregistered: status === 404,
    };
  });
