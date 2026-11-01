import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

// Self-hosted push registration: sends this device's native push token to the
// connected server over its authenticated WebSocket. The server persists it and
// pushes agent notifications directly (FCM on Android), bypassing the hosted
// relay entirely.
export function createPushEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    registerToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:push:register-token",
      tag: WS_METHODS.pushRegisterToken,
      scheduler,
    }),
    unregisterToken: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:push:unregister-token",
      tag: WS_METHODS.pushUnregisterToken,
      scheduler,
    }),
  };
}
