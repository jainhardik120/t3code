import { describe, expect, it } from "@effect/vitest";

import { UsageAggregator } from "./usageAggregation.ts";
import type { RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-fable-5",
    {
      inputCostPerToken: 1e-5,
      outputCostPerToken: 5e-5,
      cacheReadCostPerToken: 1e-6,
      cacheCreationCostPerToken: 1.25e-5,
    },
  ],
]);

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    // 2026-08-07T04:05Z is still Aug 6 in Los Angeles.
    timestampMs: Date.parse("2026-08-07T04:05:13.944Z"),
    model: "claude-fable-5",
    sessionId: "session-a",
    projectPath: "/home/dev/alpha",
    totals: {
      uncachedInputTokens: 100,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    dedupeKey: null,
    ...overrides,
  };
}

function aggregate(records: readonly UsageRecord[], timeZone = "UTC") {
  const aggregator = new UsageAggregator({
    timeZone,
    sinceDay: "2026-08-01",
    untilDay: "2026-08-31",
    rates,
  });
  for (const item of records) aggregator.add(item);
  return aggregator.finish();
}

describe("UsageAggregator", () => {
  it("keeps only the first record for a repeated dedupe key", () => {
    const result = aggregate([
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
      record({ dedupeKey: "msg_1:" }),
    ]);

    expect(result.duplicatesDropped).toBe(2);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.records).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("still sums records that carry no dedupe key", () => {
    const result = aggregate([record(), record()]);

    expect(result.duplicatesDropped).toBe(0);
    expect(result.buckets[0]?.totals.outputTokens).toBe(100);
  });

  it("buckets by the day in the requested time zone", () => {
    const utc = aggregate([record()], "UTC");
    const losAngeles = aggregate([record()], "America/Los_Angeles");

    expect(utc.buckets[0]?.day).toBe("2026-08-07");
    expect(losAngeles.buckets[0]?.day).toBe("2026-08-06");
  });

  it("prices against the rate table", () => {
    const result = aggregate([record()]);

    // 100*1e-5 + 1000*1e-6 + 10*1.25e-5 + 50*5e-5
    expect(result.buckets[0]?.costUsd).toBeCloseTo(0.004625, 9);
    expect(result.buckets[0]?.costSource).toBe("modelPriced");
  });

  it("counts tokens but not cost for a model with no rate", () => {
    const result = aggregate([record({ model: "kimi-k3" })]);

    expect(result.buckets[0]?.costUsd).toBe(0);
    expect(result.buckets[0]?.costSource).toBe("unpriced");
    expect(result.buckets[0]?.unpricedRecords).toBe(1);
    expect(result.buckets[0]?.totals.outputTokens).toBe(50);
  });

  it("prefers a reported cost over the rate table", () => {
    const result = aggregate([record({ reportedCostUsd: 1.25 })]);

    expect(result.buckets[0]?.costUsd).toBe(1.25);
    expect(result.buckets[0]?.costSource).toBe("providerReported");
  });

  it("drops records outside the window", () => {
    const result = aggregate([record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") })]);

    expect(result.outOfWindow).toBe(1);
    expect(result.buckets).toHaveLength(0);
  });

  it("reports whether a record contributed", () => {
    const aggregator = new UsageAggregator({
      timeZone: "UTC",
      sinceDay: "2026-08-01",
      untilDay: "2026-08-31",
      rates,
    });

    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(true);
    expect(aggregator.add(record({ dedupeKey: "msg_1:" }))).toBe(false);
    expect(aggregator.add(record({ timestampMs: Date.parse("2026-07-01T12:00:00Z") }))).toBe(false);
  });

  it("separates providers and models into their own buckets", () => {
    const result = aggregate([
      record(),
      record({ provider: "codex", model: "gpt-5.6-sol" }),
      record({ model: "claude-opus-5" }),
    ]);

    expect(result.buckets).toHaveLength(3);
  });

  it("anchors a session to the directory it started in", () => {
    // Claude rewrites cwd when the agent changes directory mid-session; all of
    // it belongs to the project the session opened in.
    const result = aggregate([
      record({ sessionId: "s1", projectPath: "/home/dev/repo" }),
      record({ sessionId: "s1", projectPath: "/home/dev/repo/packages/api" }),
      record({ sessionId: "s1", projectPath: "/home/dev/repo/web/src" }),
    ]);

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.projectPath).toBe("/home/dev/repo");
    expect(result.projects[0]?.records).toBe(3);
    expect(result.sessions[0]?.projectPath).toBe("/home/dev/repo");
  });

  it("rolls usage up by project, keyed per provider", () => {
    const result = aggregate([
      record({ projectPath: "/home/dev/alpha", sessionId: "s1" }),
      record({ projectPath: "/home/dev/alpha", sessionId: "s2" }),
      record({ projectPath: "/home/dev/beta", sessionId: "s3" }),
    ]);

    expect(result.projects).toHaveLength(2);
    const alpha = result.projects.find((row) => row.projectPath === "/home/dev/alpha");
    expect(alpha?.records).toBe(2);
    expect(alpha?.sessions).toBe(2);
    // Every axis folds the same records, so project cost totals to bucket cost.
    const bucketCost = result.buckets.reduce((sum, row) => sum + row.costUsd, 0);
    const projectCost = result.projects.reduce((sum, row) => sum + row.costUsd, 0);
    expect(projectCost).toBeCloseTo(bucketCost, 10);
  });

  it("rolls usage up by session, spanning days and models", () => {
    const result = aggregate([
      record({
        sessionId: "long",
        model: "claude-fable-5",
        timestampMs: Date.parse("2026-08-05T10:00:00.000Z"),
      }),
      record({
        sessionId: "long",
        model: "claude-opus-5",
        timestampMs: Date.parse("2026-08-07T10:00:00.000Z"),
      }),
      // Out of order on purpose: the span must widen from both ends.
      record({
        sessionId: "long",
        model: "claude-fable-5",
        timestampMs: Date.parse("2026-08-03T10:00:00.000Z"),
      }),
    ]);

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session?.records).toBe(3);
    expect(session?.models).toEqual(["claude-fable-5", "claude-opus-5"]);
    expect(session?.firstDay).toBe("2026-08-03");
    expect(session?.lastDay).toBe("2026-08-07");
  });

  it("keeps records with no declared project in their own row", () => {
    const result = aggregate([record({ projectPath: "" }), record({ projectPath: "/home/dev/a" })]);

    expect(result.projects.map((row) => row.projectPath).toSorted()).toEqual(["", "/home/dev/a"]);
  });

  it("excludes duplicate and out-of-window records from every axis", () => {
    const result = aggregate([
      record({ dedupeKey: "dup", sessionId: "s1" }),
      record({ dedupeKey: "dup", sessionId: "s1" }),
      record({ sessionId: "s2", timestampMs: Date.parse("2026-09-15T10:00:00.000Z") }),
    ]);

    expect(result.duplicatesDropped).toBe(1);
    expect(result.outOfWindow).toBe(1);
    // The dropped duplicate is counted once and the out-of-window record never
    // appears, so no session row exists for it.
    expect(result.sessions.map((row) => row.sessionId)).toEqual(["s1"]);
    expect(result.sessions[0]?.records).toBe(1);
  });
});
