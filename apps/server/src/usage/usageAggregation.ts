// @effect-diagnostics globalDate:off
import type {
  UsageBucket,
  UsageCategoryCost,
  UsageDay,
  UsageProjectBucket,
  UsageResolution,
  UsageSessionBucket,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { cacheSavingsUsd, priceUsage, type RateTable } from "./usagePricing.ts";

// en-CA gives ISO-ordered parts in the requested zone; Date getters are host-local.
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  // Cache quarter-hour slots to avoid per-record Intl calls; fixed-offset midnight can split slots and needs exact formatting.
  const days = new Map<number, string | null>();
  return (timestampMs) => {
    const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
    let day = days.get(slot);
    if (day === undefined) {
      const first = format.format(new Date(slot * QUARTER_HOUR_MS));
      const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
      day = first === last ? first : null;
      days.set(slot, day);
    }
    return day ?? format.format(new Date(timestampMs));
  };
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface MutableBucket {
  totals: { -readonly [K in keyof UsageTokenTotals]: number };
  costUsd: number;
  cacheSavingsUsd: number;
  categoryCostUsd: UsageCategoryCost | null;
  fastCostUsd: number;
  ultrafastCostUsd: number;
  speedPremiumUsd: number;
  records: number;
  unpricedRecords: number;
  providerReportedRecords: number;
  sessions: Set<string>;
}

function emptyBucket(): MutableBucket {
  return {
    totals: { ...EMPTY_TOTALS },
    costUsd: 0,
    cacheSavingsUsd: 0,
    categoryCostUsd: null,
    fastCostUsd: 0,
    ultrafastCostUsd: 0,
    speedPremiumUsd: 0,
    records: 0,
    unpricedRecords: 0,
    providerReportedRecords: 0,
    sessions: new Set<string>(),
  };
}

function accumulateTotals(target: MutableBucket["totals"], add: UsageTokenTotals): void {
  target.uncachedInputTokens += add.uncachedInputTokens;
  target.cachedInputTokens += add.cachedInputTokens;
  target.cacheCreationTokens += add.cacheCreationTokens;
  target.outputTokens += add.outputTokens;
  target.reasoningTokens += add.reasoningTokens;
}

/** A project or session rollup: a bucket plus the span of days it covers. */
interface MutableGroup extends MutableBucket {
  provider: string;
  projectPath: string;
  models: Set<string>;
  firstDay: string;
  lastDay: string;
}

interface GroupContribution {
  readonly record: UsageRecord;
  readonly day: string;
  readonly priced: { readonly costUsd: number; readonly costSource: UsageBucket["costSource"] };
  readonly savings: number;
}

export interface AggregateOptions {
  readonly timeZone: string;
  readonly sinceDay: string;
  readonly untilDay: string;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
  readonly modelAliases?: ReadonlyMap<string, string>;
  readonly resolution?: UsageResolution;
  readonly sinceTimeMs?: number;
  readonly untilTimeMs?: number;
}

export function resolveModelAliases(
  aliases: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const model of Object.keys(aliases)) {
    const seen = new Set([model]);
    let target = aliases[model]!;
    while (Object.hasOwn(aliases, target) && !seen.has(target)) {
      seen.add(target);
      target = aliases[target]!;
    }
    if (!Object.hasOwn(aliases, target)) resolved.set(model, target);
  }
  return resolved;
}

export interface AggregateResult {
  readonly buckets: readonly UsageBucket[];
  readonly duplicatesDropped: number;
  readonly outOfWindow: number;
  readonly projects: readonly UsageProjectBucket[];
  readonly sessions: readonly UsageSessionBucket[];
}

/** Deduplicates across the whole scan; Claude copies records into resumed/forked transcripts. */
export class UsageAggregator {
  readonly #buckets = new Map<string, MutableBucket>();
  readonly #projects = new Map<string, MutableGroup>();
  readonly #sessions = new Map<string, MutableGroup>();
  readonly #seen = new Set<string>();
  readonly #toDay: (timestampMs: number) => string;
  readonly #hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null;
  readonly #options: AggregateOptions;
  #lastBucket: {
    readonly day: string;
    readonly hourIndex: number;
    readonly provider: string;
    readonly model: string;
    readonly source: string;
    readonly bucket: MutableBucket;
  } | null = null;
  #duplicatesDropped = 0;
  #outOfWindow = 0;

  constructor(options: AggregateOptions) {
    this.#options = options;
    this.#toDay = makeDayFormatter(options.timeZone);
    if (options.resolution === "hour") {
      if (options.sinceTimeMs === undefined || options.untilTimeMs === undefined) {
        throw new Error("Hourly usage aggregation requires exact time bounds");
      }
      this.#hourlyWindow = {
        sinceTimeMs: options.sinceTimeMs,
        untilTimeMs: options.untilTimeMs,
      };
    } else {
      this.#hourlyWindow = null;
    }
  }

  add(input: UsageRecord, sourcePath?: string): boolean {
    const record = this.#mapModel(input);
    if (record.dedupeKey !== null) {
      if (this.#seen.has(record.dedupeKey)) {
        this.#duplicatesDropped += 1;
        return false;
      }
      this.#seen.add(record.dedupeKey);
    }

    if (
      this.#hourlyWindow !== null &&
      (record.timestampMs < this.#hourlyWindow.sinceTimeMs ||
        record.timestampMs >= this.#hourlyWindow.untilTimeMs)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const day = this.#toDay(record.timestampMs);
    if (
      this.#hourlyWindow === null &&
      (day < this.#options.sinceDay || day > this.#options.untilDay)
    ) {
      this.#outOfWindow += 1;
      return false;
    }

    const hourIndex =
      this.#hourlyWindow === null
        ? -1
        : Math.floor((record.timestampMs - this.#hourlyWindow.sinceTimeMs) / HOUR_MS);
    const bucket = this.#bucketFor(day, hourIndex, record.provider, record.model, sourcePath ?? "");

    const priced = priceUsage(this.#options.rates, record, this.#options.priceOverrides);

    accumulateTotals(bucket.totals, record.totals);
    bucket.costUsd += priced.costUsd;
    if (priced.categoryCostUsd !== null) {
      const sum = bucket.categoryCostUsd;
      const add = priced.categoryCostUsd;
      bucket.categoryCostUsd =
        sum === null
          ? add
          : {
              input: sum.input + add.input,
              cacheRead: sum.cacheRead + add.cacheRead,
              cacheWrite: sum.cacheWrite + add.cacheWrite,
              output: sum.output + add.output,
            };
    }
    if (record.speed === "fast") bucket.fastCostUsd += priced.costUsd;
    if (record.speed === "ultrafast") bucket.ultrafastCostUsd += priced.costUsd;
    bucket.speedPremiumUsd += priced.speedPremiumUsd;
    const savings = cacheSavingsUsd(this.#options.rates, record, this.#options.priceOverrides);
    bucket.cacheSavingsUsd += savings;
    bucket.records += 1;
    if (priced.costSource === "unpriced") bucket.unpricedRecords += 1;
    if (priced.costSource === "providerReported") bucket.providerReportedRecords += 1;
    if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);

    // The project and session rollups see exactly the records the day/model
    // grid saw, so all three axes always total to the same cost.
    const contribution: GroupContribution = { record, day, priced, savings };
    const session =
      record.sessionId.length > 0
        ? this.#addToGroup(this.#sessions, record.sessionId, contribution)
        : undefined;
    // A session is attributed to the directory it started in, and every one of
    // its records follows that attribution. Claude rewrites `cwd` whenever the
    // agent changes directory mid-session, so keying projects on the raw
    // per-record path shatters one repo into a row per subdirectory it visited.
    const projectPath = session?.projectPath ?? record.projectPath ?? "";
    this.#addToGroup(
      this.#projects,
      `${record.provider}\u0000${projectPath}`,
      contribution,
      projectPath,
    );
    return true;
  }

  #addToGroup(
    groups: Map<string, MutableGroup>,
    key: string,
    contribution: GroupContribution,
    projectPathOverride?: string,
  ): MutableGroup {
    const { record, day, priced, savings } = contribution;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        ...emptyBucket(),
        provider: record.provider,
        projectPath: projectPathOverride ?? record.projectPath ?? "",
        models: new Set<string>(),
        firstDay: day,
        lastDay: day,
      };
      groups.set(key, group);
    }

    accumulateTotals(group.totals, record.totals);
    group.costUsd += priced.costUsd;
    group.cacheSavingsUsd += savings;
    group.records += 1;
    if (priced.costSource === "unpriced") group.unpricedRecords += 1;
    if (priced.costSource === "providerReported") group.providerReportedRecords += 1;
    if (record.sessionId.length > 0) group.sessions.add(record.sessionId);
    if (record.model.length > 0) group.models.add(record.model);
    // File order is not chronological across a resumed session, so widen both ends.
    if (day < group.firstDay) group.firstDay = day;
    if (day > group.lastDay) group.lastDay = day;
    // Codex declares cwd once on session_meta, so a record parsed before it has
    // no path; the first one that does fills the blank, and never overwrites.
    const candidate = projectPathOverride ?? record.projectPath ?? "";
    if (group.projectPath.length === 0 && candidate.length > 0) {
      group.projectPath = candidate;
    }
    return group;
  }

  // Aliases use the target's rate, replacing provider-specific rateModel.
  #mapModel(record: UsageRecord): UsageRecord {
    const model = this.#options.modelAliases?.get(record.model);
    if (model === undefined) return record;
    const { rateModel: _rateModel, ...rest } = record;
    return { ...rest, model };
  }

  // Time-ordered records usually reuse the previous bucket; avoid rebuilding its key.
  #bucketFor(
    day: string,
    hourIndex: number,
    provider: string,
    model: string,
    source: string,
  ): MutableBucket {
    const last = this.#lastBucket;
    if (
      last !== null &&
      last.day === day &&
      last.hourIndex === hourIndex &&
      last.provider === provider &&
      last.model === model &&
      last.source === source
    ) {
      return last.bucket;
    }
    const window = this.#hourlyWindow;
    const hourStart =
      window === null ? "" : new Date(window.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
    const key = `${day}\u0000${hourStart}\u0000${provider}\u0000${model}\u0000${source}`;
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      bucket = emptyBucket();
      this.#buckets.set(key, bucket);
    }
    this.#lastBucket = { day, hourIndex, provider, model, source, bucket };
    return bucket;
  }

  finish(): AggregateResult {
    const buckets: UsageBucket[] = [];
    for (const [key, bucket] of this.#buckets) {
      const [day = "", hourStart = "", provider = "", model = "", sourcePath = ""] =
        key.split("\u0000");
      const category = bucket.categoryCostUsd;
      const fastCostUsd = roundUsd(bucket.fastCostUsd);
      const ultrafastCostUsd = roundUsd(bucket.ultrafastCostUsd);
      const speedPremiumUsd = roundUsd(bucket.speedPremiumUsd);
      buckets.push({
        day: day as UsageDay,
        ...(hourStart === "" ? {} : { hourStart }),
        provider: provider as UsageBucket["provider"],
        model,
        ...(sourcePath === "" ? {} : { sourcePath }),
        totals: { ...bucket.totals },
        costUsd: bucket.costUsd,
        cacheSavingsUsd: bucket.cacheSavingsUsd,
        ...(category === null
          ? {}
          : {
              categoryCostUsd: {
                input: roundUsd(category.input),
                cacheRead: roundUsd(category.cacheRead),
                cacheWrite: roundUsd(category.cacheWrite),
                output: roundUsd(category.output),
              },
            }),
        ...(fastCostUsd === 0 ? {} : { fastCostUsd }),
        ...(ultrafastCostUsd === 0 ? {} : { ultrafastCostUsd }),
        ...(speedPremiumUsd === 0 ? {} : { speedPremiumUsd }),
        costSource: resolveCostSource(bucket),
        records: bucket.records,
        unpricedRecords: bucket.unpricedRecords,
        sessions: bucket.sessions.size,
      });
    }
    buckets.sort(
      (a, b) =>
        a.day.localeCompare(b.day) ||
        (a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model),
    );

    const projects: UsageProjectBucket[] = [];
    for (const group of this.#projects.values()) {
      projects.push({
        projectPath: group.projectPath,
        provider: group.provider as UsageBucket["provider"],
        totals: { ...group.totals },
        costUsd: group.costUsd,
        cacheSavingsUsd: group.cacheSavingsUsd,
        costSource: resolveCostSource(group),
        records: group.records,
        unpricedRecords: group.unpricedRecords,
        sessions: group.sessions.size,
        firstDay: group.firstDay as UsageDay,
        lastDay: group.lastDay as UsageDay,
      });
    }
    // Costliest first: both tables are read top-down to find what to cut.
    projects.sort((a, b) => b.costUsd - a.costUsd || a.projectPath.localeCompare(b.projectPath));

    const sessions: UsageSessionBucket[] = [];
    for (const [sessionId, group] of this.#sessions) {
      sessions.push({
        sessionId,
        projectPath: group.projectPath,
        provider: group.provider as UsageBucket["provider"],
        models: [...group.models].sort(),
        totals: { ...group.totals },
        costUsd: group.costUsd,
        cacheSavingsUsd: group.cacheSavingsUsd,
        costSource: resolveCostSource(group),
        records: group.records,
        unpricedRecords: group.unpricedRecords,
        firstDay: group.firstDay as UsageDay,
        lastDay: group.lastDay as UsageDay,
        // Filled in at the RPC boundary, which is where thread state lives.
        threadId: null,
        threadTitle: null,
      });
    }
    sessions.sort((a, b) => b.costUsd - a.costUsd || a.sessionId.localeCompare(b.sessionId));

    return {
      buckets,
      projects,
      sessions,
      duplicatesDropped: this.#duplicatesDropped,
      outOfWindow: this.#outOfWindow,
    };
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
  if (bucket.unpricedRecords === bucket.records) return "unpriced";
  if (bucket.providerReportedRecords === bucket.records) return "providerReported";
  return "modelPriced";
}
