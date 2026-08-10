/**
 * Usage reporting contract.
 *
 * Each environment scans the provider CLIs' own on-disk session transcripts
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`) rather than
 * relying on T3 Code's own orchestration projections, so usage stays complete
 * even for turns that were never driven through T3 Code. This mirrors the
 * approach `ccusage` takes.
 *
 * Environments return pre-aggregated `(day, provider, model)` buckets. Raw
 * transcript records never cross the wire.
 *
 * @module usage
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Bumped whenever the shape of {@link UsageSummary} changes incompatibly. The
 * client renders partial coverage when an environment reports an older version
 * rather than failing the whole page.
 */
export const USAGE_CONTRACT_VERSION = 4 as const;

export const UsageProviderKind = Schema.Literals(["claude", "codex"]);
export type UsageProviderKind = typeof UsageProviderKind.Type;

/**
 * A calendar day in the reporting time zone, formatted `YYYY-MM-DD`.
 *
 * Days are bucketed server-side so that a turn always lands on the day the user
 * experienced it, not the UTC day.
 */
const USAGE_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const UsageDay = TrimmedNonEmptyString.check(Schema.isPattern(USAGE_DAY_PATTERN)).pipe(
  Schema.brand("UsageDay"),
);
export type UsageDay = typeof UsageDay.Type;

/**
 * Why a bucket's cost is what it is.
 *
 * - `providerReported` - the transcript carried an explicit cost figure.
 * - `modelPriced` - we matched the model against the LiteLLM rate table.
 * - `unpriced` - tokens are known, rates are not. Counted in totals, excluded
 *   from cost.
 */
export const UsageCostSource = Schema.Literals(["providerReported", "modelPriced", "unpriced"]);
export type UsageCostSource = typeof UsageCostSource.Type;

/**
 * Token counts for a bucket.
 *
 * `cachedInputTokens` and `cacheCreationTokens` are disjoint from
 * `uncachedInputTokens`; summing all three gives total input. `reasoningTokens`
 * is a *subset* of `outputTokens` (Codex reports it that way, and Anthropic
 * folds thinking into output), so it must never be added on top.
 */
export const UsageTokenTotals = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
});
export type UsageTokenTotals = typeof UsageTokenTotals.Type;

/**
 * One `(day, provider, model)` cell.
 *
 * `costUsd` is the raw API-equivalent cost of these tokens. It is not money
 * spent: subscription plans bill separately. `unpricedRecords` counts records
 * whose tokens are included in the token totals but which contributed nothing
 * to `costUsd`.
 */
export const UsageBucket = Schema.Struct({
  day: UsageDay,
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  /**
   * What the cached input would have cost at full input rates minus what it
   * actually cost. Requires the rate table, so it is computed alongside cost
   * rather than derived on the client.
   */
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  /** Distinct assistant responses, after de-duplication. */
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  /** Distinct transcript sessions that contributed to this cell. */
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

/**
 * Identifies the physical transcript directory a source read from.
 *
 * Two environments on the same machine (worktree servers, for example) resolve
 * the same provider home and would otherwise double count. The client drops
 * duplicate fingerprints before merging.
 */
export const UsageSourceFingerprint = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  provider: UsageProviderKind,
  resolvedHomePath: TrimmedNonEmptyString,
  /**
   * Filesystem identity of the transcript directory, as `device:inode`.
   *
   * Hostname and path alone are not enough: every Mac in a fleet resolves
   * `/Users/<user>/.claude`, so two machines that happen to share a hostname
   * would look like one source and have their usage silently dropped. The
   * device/inode pair is stable for two servers reading the same directory and
   * effectively never collides across machines. Empty when it cannot be read.
   */
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
  /** Records that parsed but carried no recognisable usage payload. */
  malformedRecords: NonNegativeInt,
  /**
   * Distinct transcript sessions seen under this directory. Buckets also carry
   * per-bucket session counts, but a session spans days and models, so summing
   * those overcounts; this is the figure clients should total.
   */
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageSource = typeof UsageSource.Type;

export const UsagePricingStatus = Schema.Literals(["fresh", "cached", "unavailable"]);
export type UsagePricingStatus = typeof UsagePricingStatus.Type;

/**
 * Provenance for the rate table, so the UI can be honest about how good the
 * cost figures are.
 */
export const UsagePricing = Schema.Struct({
  status: UsagePricingStatus,
  source: TrimmedNonEmptyString,
  fetchedAt: Schema.NullOr(Schema.String),
  knownModels: NonNegativeInt,
});
export type UsagePricing = typeof UsagePricing.Type;

export const UsageSummaryInput = Schema.Struct({
  /** Inclusive first day of the window, in `timeZone`. */
  sinceDay: UsageDay,
  /** Inclusive last day of the window, in `timeZone`. */
  untilDay: UsageDay,
  /**
   * IANA zone the client wants days bucketed in. An offset would be wrong for
   * any window that crosses a DST boundary.
   */
  timeZone: TrimmedNonEmptyString,
});
export type UsageSummaryInput = typeof UsageSummaryInput.Type;

export const UsageSummary = Schema.Struct({
  contractVersion: Schema.Number,
  readAt: Schema.String,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  buckets: Schema.Array(UsageBucket),
  /** Per-project rollups over the same window as `buckets`. */
  projects: Schema.Array(UsageProjectBucket),
  /** Per-session rollups over the same window as `buckets`. */
  sessions: Schema.Array(UsageSessionBucket),
  sources: Schema.Array(UsageSource),
  pricing: UsagePricing,
  /** Wall-clock cost of the scan, surfaced in diagnostics. */
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

export class UsageReadError extends Schema.TaggedErrorClass<UsageReadError>()("UsageReadError", {
  reason: Schema.Literals(["scanFailed", "invalidWindow"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Usage read failed (${this.reason}): ${this.detail}`;
  }
}
