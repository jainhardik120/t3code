import { describe, expect, it } from "@effect/vitest";
import type { UsageDay, UsageSessionBucket, UsageSummary } from "@t3tools/contracts";

import { attachSessionLinks, buildSessionLinks, resumeSessionId } from "./usageSessionLinks.ts";

function session(overrides: Partial<UsageSessionBucket> = {}): UsageSessionBucket {
  return {
    sessionId: "claude-session",
    projectPath: "/home/dev/alpha",
    provider: "claude",
    models: ["claude-fable-5"],
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 1,
      cacheCreationTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    costUsd: 1,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    firstDay: "2026-08-07" as UsageDay,
    lastDay: "2026-08-07" as UsageDay,
    threadId: null,
    threadTitle: null,
    ...overrides,
  };
}

function summary(sessions: readonly UsageSessionBucket[]): UsageSummary {
  return {
    contractVersion: 4,
    readAt: "2026-08-07T00:00:00.000Z",
    timeZone: "UTC",
    sinceDay: "2026-08-01" as UsageDay,
    untilDay: "2026-08-31" as UsageDay,
    buckets: [],
    projects: [],
    sessions,
    sources: [],
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  };
}

describe("resumeSessionId", () => {
  it("reads the resume id from a stored cursor", () => {
    expect(resumeSessionId({ threadId: "t1", resume: "session-a", turnCount: 1 })).toBe(
      "session-a",
    );
  });

  it("yields nothing for a cursor that does not carry one", () => {
    // The cursor is opaque JSON, so anything unexpected must produce no link
    // rather than a bogus one.
    expect(resumeSessionId(null)).toBeNull();
    expect(resumeSessionId("session-a")).toBeNull();
    expect(resumeSessionId({})).toBeNull();
    expect(resumeSessionId({ resume: "" })).toBeNull();
    expect(resumeSessionId({ resume: 42 })).toBeNull();
  });
});

describe("buildSessionLinks", () => {
  it("maps resumable sessions to their thread and title", () => {
    const links = buildSessionLinks(
      [
        { threadId: "t1", resumeCursor: { resume: "session-a" } },
        { threadId: "t2", resumeCursor: null },
      ],
      new Map([["t1", "Fix the parser"]]),
    );

    expect(links.get("session-a")).toEqual({ threadId: "t1", threadTitle: "Fix the parser" });
    expect(links.size).toBe(1);
  });

  it("keeps a thread whose title is unknown", () => {
    const links = buildSessionLinks(
      [{ threadId: "t1", resumeCursor: { resume: "session-a" } }],
      new Map(),
    );

    expect(links.get("session-a")).toEqual({ threadId: "t1", threadTitle: null });
  });
});

describe("attachSessionLinks", () => {
  it("labels only the sessions that resolve", () => {
    const result = attachSessionLinks(
      summary([session({ sessionId: "linked" }), session({ sessionId: "terminal" })]),
      new Map([["linked", { threadId: "t1", threadTitle: "Fix the parser" }]]),
    );

    expect(result.sessions?.[0]?.threadId).toBe("t1");
    expect(result.sessions?.[0]?.threadTitle).toBe("Fix the parser");
    // A session started outside T3 Code has nothing to open.
    expect(result.sessions?.[1]?.threadId).toBeNull();
  });

  it("returns the summary untouched when nothing resolves", () => {
    const input = summary([session()]);
    expect(attachSessionLinks(input, new Map())).toBe(input);
  });
});
