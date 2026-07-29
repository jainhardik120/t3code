import { createPushEnvironmentAtoms } from "@t3tools/client-runtime/state/push";

import { connectionAtomRuntime } from "../connection/runtime";

export const pushEnvironment = createPushEnvironmentAtoms(connectionAtomRuntime);
