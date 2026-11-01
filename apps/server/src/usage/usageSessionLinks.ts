/**
 * Links transcript sessions back to the T3 threads that drove them.
 *
 * The usage scan only ever sees the provider CLI's own session id, which is
 * enough to attribute cost but not to open anything. This module resolves that
 * id to a thread so the UI can label a session and link to it.
 *
 * The mapping lives in `provider_session_runtime.resume_cursor_json`: T3 stores
 * the id it passes to `claude --resume`, and that is exactly the transcript's
 * `sessionId`. `projection_thread_sessions.provider_session_id` looks like the
 * natural home for it but is never populated.
 *
 * One row per thread, holding only the current cursor, so a thread that has
 * moved on to a newer session no longer resolves its older ones. Sessions
 * started outside T3 Code never resolve at all. Both are expected: the link is
 * an enrichment, and a session without one still reports its usage.
 *
 * Pure, so the resolution rules are testable without a database.
 *
 * @module usageSessionLinks
 */
import type { UsageSummary } from "@t3tools/contracts";

export interface ThreadLabel {
  readonly threadId: string;
  readonly threadTitle: string | null;
}

/**
 * Reads the provider session id out of a stored resume cursor.
 *
 * The cursor is persisted as opaque JSON, so its shape is checked rather than
 * trusted: a driver that stores something else must yield no link instead of a
 * bogus one.
 */
export function resumeSessionId(resumeCursor: unknown): string | null {
  if (typeof resumeCursor !== "object" || resumeCursor === null) return null;
  const resume = (resumeCursor as Record<string, unknown>)["resume"];
  return typeof resume === "string" && resume.length > 0 ? resume : null;
}

/**
 * Builds the session id → thread lookup.
 *
 * Later runtimes win a contested session id. Two threads claiming one id would
 * mean a resumed session was forked between them; attributing it to the most
 * recently seen thread matches what the user would click through to.
 */
export function buildSessionLinks(
  runtimes: readonly { readonly threadId: string; readonly resumeCursor: unknown }[],
  titleByThreadId: ReadonlyMap<string, string>,
): ReadonlyMap<string, ThreadLabel> {
  const links = new Map<string, ThreadLabel>();
  for (const runtime of runtimes) {
    const sessionId = resumeSessionId(runtime.resumeCursor);
    if (sessionId === null) continue;
    links.set(sessionId, {
      threadId: runtime.threadId,
      threadTitle: titleByThreadId.get(runtime.threadId) ?? null,
    });
  }
  return links;
}

/** Returns the summary with every resolvable session labelled. */
export function attachSessionLinks(
  summary: UsageSummary,
  links: ReadonlyMap<string, ThreadLabel>,
): UsageSummary {
  if (links.size === 0 || summary.sessions === undefined) return summary;
  return {
    ...summary,
    sessions: summary.sessions.map((session) => {
      const link = links.get(session.sessionId);
      return link === undefined
        ? session
        : { ...session, threadId: link.threadId, threadTitle: link.threadTitle };
    }),
  };
}
