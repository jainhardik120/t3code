import { createThreadPaginationAtoms } from "@t3tools/client-runtime/state/threads";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadPagination = createThreadPaginationAtoms(connectionAtomRuntime);
