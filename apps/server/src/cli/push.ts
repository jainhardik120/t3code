import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { FileSystem } from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import { Argument, Command, GlobalFlag } from "effect/unstable/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { FCM_SERVICE_ACCOUNT_SECRET } from "../push/config.ts";
import { parseServiceAccount } from "../push/FcmClient.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

class PushCliError extends Data.TaggedError("PushCliError")<{ readonly message: string }> {}

const setFcmCredentialsCommand = Command.make("set-fcm-credentials", {
  ...authLocationFlags,
  path: Argument.String("path").pipe(
    Argument.withDescription(
      "Path to a Google service-account JSON file (with the Firebase Cloud Messaging API enabled).",
    ),
  ),
}).pipe(
  Command.withDescription(
    "Store the Firebase service-account credentials used to send Android push notifications.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem;
        const json = yield* fileSystem
          .readFileString(flags.path)
          .pipe(
            Effect.mapError(
              (cause) =>
                new PushCliError({ message: `Failed to read ${flags.path}: ${cause.message}` }),
            ),
          );
        // Validate before storing so a malformed file fails loudly here rather
        // than silently disabling push at runtime.
        yield* parseServiceAccount(json).pipe(
          Effect.mapError((error) => new PushCliError({ message: error.message })),
        );
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.set(FCM_SERVICE_ACCOUNT_SECRET, new TextEncoder().encode(json));
        yield* Console.log(
          "Stored FCM service-account credentials. Android push notifications are now enabled.\n",
        );
      }).pipe(
        Effect.provide(
          EnvironmentAuth.runtimeLayer.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      );
    }),
  ),
);

const clearFcmCredentialsCommand = Command.make("clear-fcm-credentials", {
  ...authLocationFlags,
}).pipe(
  Command.withDescription("Remove stored Firebase credentials and disable Android push."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* secrets.remove(FCM_SERVICE_ACCOUNT_SECRET);
        yield* Console.log("Cleared FCM service-account credentials. Android push is disabled.\n");
      }).pipe(
        Effect.provide(
          EnvironmentAuth.runtimeLayer.pipe(
            Layer.provide(ServerConfig.layer(config)),
            Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
          ),
        ),
      );
    }),
  ),
);

export const pushCommand = Command.make("push").pipe(
  Command.withDescription("Manage self-hosted push notifications."),
  Command.withSubcommands([setFcmCredentialsCommand, clearFcmCredentialsCommand]),
);
