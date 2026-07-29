import type { EnvironmentId, OrchestrationThread } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { threadPagination } from "./threadPagination";
import { useAtomCommand } from "./use-atom-command";

type Message = OrchestrationThread["messages"][number];
type Activity = OrchestrationThread["activities"][number];

function dedupeById<T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export interface ThreadOlderMessages {
  readonly olderMessages: ReadonlyArray<Message>;
  readonly olderActivities: ReadonlyArray<Activity>;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly loadOlder: () => void;
}

/**
 * Manages the "load older messages" pages for a windowed thread as local UI
 * state. The streaming thread machine owns the latest window + live tail; this
 * hook prepends older pages fetched on scroll-up. The cursor is the oldest
 * message currently held; an empty/half page marks end-of-history.
 */
export function useThreadOlderMessages(
  environmentId: EnvironmentId | null,
  detail: OrchestrationThread | null,
): ThreadOlderMessages {
  const loadOlderCommand = useAtomCommand(threadPagination.loadOlderMessages, {
    reportFailure: false,
  });
  const [olderMessages, setOlderMessages] = useState<ReadonlyArray<Message>>([]);
  const [olderActivities, setOlderActivities] = useState<ReadonlyArray<Activity>>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const threadIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const threadId = detail?.id ?? null;

  // Reset accumulated pages when the selected thread changes.
  useEffect(() => {
    if (threadId !== threadIdRef.current) {
      threadIdRef.current = threadId;
      setOlderMessages([]);
      setOlderActivities([]);
      setHasMore(true);
      setLoading(false);
      inFlightRef.current = false;
    }
  }, [threadId]);

  const oldestMessageId = olderMessages[0]?.id ?? detail?.messages[0]?.id ?? null;

  const loadOlder = useCallback(() => {
    if (!environmentId || !detail || !hasMore || inFlightRef.current || !oldestMessageId) {
      return;
    }
    inFlightRef.current = true;
    setLoading(true);
    void (async () => {
      const result = await loadOlderCommand({
        environmentId,
        input: { threadId: detail.id, beforeMessageId: oldestMessageId },
      });
      inFlightRef.current = false;
      setLoading(false);
      if (AsyncResult.isFailure(result)) {
        return;
      }
      Option.match(result.value, {
        onNone: () => {
          // Transient fetch failure: leave hasMore so a later scroll retries.
        },
        onSome: (page) => {
          if (page.messages.length === 0) {
            setHasMore(false);
            return;
          }
          setOlderMessages((prev) => dedupeById([...page.messages, ...prev]));
          setOlderActivities((prev) => dedupeById([...page.activities, ...prev]));
          setHasMore(page.hasMoreBefore);
        },
      });
    })();
  }, [environmentId, detail, hasMore, oldestMessageId, loadOlderCommand]);

  return { olderMessages, olderActivities, hasMore, loading, loadOlder };
}
