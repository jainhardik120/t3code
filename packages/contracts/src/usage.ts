import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Bump for incompatible UsageSummary changes; skipped unknown array variants need no bump. */
export const USAGE_CONTRACT_VERSION = 6 as const;

export const USAGE_MERGE_COMPATIBLE_SINCE = 4 as const;

export const UsageProviderKind = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "antigravity",
  "pi",
  "muse",
]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

export const UsageResolution = Schema.Literals(["day", "hour"]);
export type UsageResolution = typeof UsageResolution.Type;

export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/** Sum uncached input, cache reads, and cache writes for input totals; reasoning is already included in output. */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

export const UsageCategoryCost = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type UsageCategoryCost = typeof UsageCategoryCost.Type;

export const UsageBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.optional(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  sourcePath: Schema.optional(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  categoryCostUsd: Schema.optional(UsageCategoryCost),
  fastCostUsd: Schema.optional(Schema.Number),
  ultrafastCostUsd: Schema.optional(Schema.Number),
  speedPremiumUsd: Schema.optional(Schema.Number),
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type UsageBucket = typeof UsageBucket.Type;

/**
 * The working directory a session ran in, used as its project identity.
 *
 * Both CLIs record it: Claude on every transcript line, Codex once on
 * `session_meta`. It is preferred over the encoded directory name under
 * `~/.claude/projects`, which replaces every `/` with `-` and so cannot be
 * decoded back to a path unambiguously. Empty when a transcript never declared
 * one.
 */
export const UsageProjectPath = Schema.String;
export type UsageProjectPath = typeof UsageProjectPath.Type;

/**
 * Usage rolled up per project across the whole window.
 *
 * Kept as its own axis rather than another key on {@link UsageBucket}: adding
 * project and session to that key multiplies its cardinality by both, and the
 * day/model grid is read far more often than either breakdown.
 */
export const UsageProjectBucket = Schema.Struct({
  projectPath: UsageProjectPath,
  provider: UsageProviderKind,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that ran in this project. */
  sessions: NonNegativeInt,
  firstDay: UsageDay,
  lastDay: UsageDay,
});
export type UsageProjectBucket = typeof UsageProjectBucket.Type;

/** Usage rolled up per transcript session across the whole window. */
export const UsageSessionBucket = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  projectPath: UsageProjectPath,
  provider: UsageProviderKind,
  /**
   * Every model the session used, sorted. A long session commonly spans more
   * than one, so a single "the" model would misattribute the rest.
   */
  models: Schema.Array(TrimmedNonEmptyString),
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  firstDay: UsageDay,
  lastDay: UsageDay,
  /**
   * The T3 thread this session belongs to, when this server drove it.
   *
   * Null for sessions started outside T3 Code — a plain terminal run leaves an
   * identical transcript with nothing to link to. Only meaningful alongside the
   * environment that reported it, since thread ids are per-environment.
   */
  threadId: Schema.NullOr(TrimmedNonEmptyString),
  /** Thread title for {@link threadId}, when one is known. */
  threadTitle: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSessionBucket = typeof UsageSessionBucket.Type;

export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /** Transcript directory device:inode distinguishes machines sharing a hostname and home path. */
  volumeId: Schema.String,
});
export type UsageSourceFingerprint = typeof UsageSourceFingerprint.Type;

export const UsageSourceStatus = Schema.Literals(["ok", "missing", "partial", "failed"]);
export type UsageSourceStatus = typeof UsageSourceStatus.Type;

export const UsageSource = Schema.Struct({
  fingerprint: UsageSourceFingerprint,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  /** Total this count; bucket counts double-count sessions spanning days or models. */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
  action: Schema.optionalKey(Schema.Literal("enableCursorKeychain")),
  /** Cached response during refresh; repeat with awaitRefresh for fresh data. */
  refreshing: Schema.optionalKey(Schema.Literal(true)),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  sinceDay: UsageDay,
  untilDay: UsageDay,
  /** IANA bucketing zone; offsets fail across DST boundaries. */
  timeZone: TrimmedNonEmptyString,
  resolution: Schema.optional(UsageResolution),
  sinceTime: Schema.optional(TrimmedNonEmptyString),
  untilTime: Schema.optional(TrimmedNonEmptyString),
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: ForwardCompatibleArray(UsageBucket),
  /**
   * Per-project and per-session rollups over the same window as `buckets`.
   * Optional so summaries from servers without the fork's rollups (contract
   * v6, still merge-compatible) decode instead of failing the environment.
   */
  projects: Schema.optional(ForwardCompatibleArray(UsageProjectBucket)),
  sessions: Schema.optional(ForwardCompatibleArray(UsageSessionBucket)),
  sources: ForwardCompatibleArray(UsageSource),
  pricing: UsagePricing,
  scanDurationMs: NonNegativeInt,
});
export type UsageSummary = typeof UsageSummary.Type;

/**
 * Cost of the transcript session a thread is currently running.
 *
 * Priced by the same code as the usage page, from the same transcript, so the
 * figure in a thread and the figure in the usage table cannot disagree.
 */
export const ThreadUsageCostInput = Schema.Struct({ threadId: ThreadId });
export type ThreadUsageCostInput = typeof ThreadUsageCostInput.Type;

export const ThreadUsageCost = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  costSource: UsageCostSource,
  records: NonNegativeInt,
});
export type ThreadUsageCost = typeof ThreadUsageCost.Type;

export class UsageReadError extends Schema.TaggedError<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
