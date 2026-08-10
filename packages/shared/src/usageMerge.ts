/**
 * Merges per-environment usage summaries into the single view the page renders.
 *
 * Pure, so the de-duplication and derivation rules can be tested without a
 * connected environment.
 *
 * @module usageMerge
 */
import type {
  EnvironmentId,
  UsageBucket,
  UsageProjectBucket,
  UsageProviderKind,
  UsageSessionBucket,
  UsageSourceFingerprint,
  UsageSummary,
} from "@t3tools/contracts";

export interface EnvironmentUsage {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly summary: UsageSummary;
}

export interface ProviderTotals {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

export interface ModelTotals {
  readonly model: string;
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly costShare: number;
}

export interface ProjectTotals {
  readonly projectPath: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly costShare: number;
  /**
   * Split per harness so the table can column them like the day view. A project
   * worked on with both CLIs is one row, not one per provider.
   */
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
  readonly firstDay: string;
  readonly lastDay: string;
}

export interface SessionTotals {
  readonly sessionId: string;
  readonly projectPath: string;
  readonly provider: UsageProviderKind;
  readonly models: readonly string[];
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly costShare: number;
  readonly firstDay: string;
  readonly lastDay: string;
  /**
   * Thread this session drove, and the environment that owns it. Both are
   * needed to build a link: a thread id only resolves on its own environment.
   * Null for sessions started outside T3 Code.
   */
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly environmentId: EnvironmentId | null;
}

export interface DailyTotals {
  readonly day: string;
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly byProvider: ReadonlyMap<UsageProviderKind, { costUsd: number; totalTokens: number }>;
}

export interface CostQuality {
  readonly providerReportedShare: number;
  readonly modelPricedShare: number;
  readonly unpricedShare: number;
  readonly cacheSavingsUsd: number;
}

export interface MergedUsage {
  readonly costUsd: number;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly sessions: number;
  readonly providers: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly projects: readonly ProjectTotals[];
  readonly sessionTotals: readonly SessionTotals[];
  readonly daily: readonly DailyTotals[];
  readonly costQuality: CostQuality;
  /** Environments whose data was dropped as a duplicate of another's. */
  readonly duplicateSources: readonly string[];
  readonly contributingEnvironments: readonly EnvironmentId[];
  readonly staleEnvironments: readonly EnvironmentId[];
}

/**
 * Two sources are the same physical transcript directory only when host,
 * provider, path and filesystem identity all agree.
 *
 * `volumeId` is what stops two machines that happen to share a hostname and a
 * home path, which is every Mac in a fleet, from collapsing into one source and
 * having one of them silently dropped.
 */
function fingerprintKey(fingerprint: UsageSourceFingerprint): string {
  return [
    fingerprint.hostId,
    fingerprint.provider,
    fingerprint.resolvedHomePath,
    fingerprint.volumeId,
  ].join(" ");
}

/**
 * Decides which environment owns each physical transcript directory.
 *
 * Several environments on one machine (worktree servers, for instance) resolve
 * the same provider home and would otherwise double count every token. The
 * first environment in a stable order claims a fingerprint; the rest have that
 * provider's buckets dropped. Environments are sorted by id so the winner does
 * not change between renders.
 */
function claimSources(environments: readonly EnvironmentUsage[]): {
  readonly ownerByFingerprint: ReadonlyMap<string, EnvironmentId>;
  readonly duplicates: readonly string[];
} {
  const ownerByFingerprint = new Map<string, EnvironmentId>();
  const duplicates: string[] = [];

  const ordered = [...environments].sort((a, b) => a.environmentId.localeCompare(b.environmentId));

  for (const environment of ordered) {
    for (const source of environment.summary.sources) {
      if (source.status === "missing") continue;
      const key = fingerprintKey(source.fingerprint);
      if (ownerByFingerprint.has(key)) {
        duplicates.push(`${environment.label}: ${source.fingerprint.resolvedHomePath}`);
        continue;
      }
      ownerByFingerprint.set(key, environment.environmentId);
    }
  }

  return { ownerByFingerprint, duplicates };
}

/** Sources this environment owns after fingerprint claims, plus their buckets. */
function ownedContribution(
  environment: EnvironmentUsage,
  ownerByFingerprint: ReadonlyMap<string, EnvironmentId>,
): {
  readonly buckets: readonly UsageBucket[];
  readonly projects: readonly UsageProjectBucket[];
  readonly sessionBuckets: readonly UsageSessionBucket[];
  readonly sessions: number;
} {
  const ownedProviders = new Set<UsageProviderKind>();
  let sessions = 0;
  for (const source of environment.summary.sources) {
    if (source.status === "missing") continue;
    const key = fingerprintKey(source.fingerprint);
    if (ownerByFingerprint.get(key) === environment.environmentId) {
      ownedProviders.add(source.fingerprint.provider);
      // Distinct within a directory. Summing per-bucket session counts instead
      // would count a session once per day and model it spans.
      sessions += source.distinctSessions;
    }
  }
  // Every axis is filtered by the same owned-provider set, so a dropped
  // duplicate directory disappears from all three consistently.
  return {
    buckets: environment.summary.buckets.filter((bucket) => ownedProviders.has(bucket.provider)),
    projects: environment.summary.projects.filter((project) =>
      ownedProviders.has(project.provider),
    ),
    sessionBuckets: environment.summary.sessions.filter((session) =>
      ownedProviders.has(session.provider),
    ),
    sessions,
  };
}

/** Token total for any row carrying `UsageTokenTotals`. */
function rowTokens(row: { readonly totals: UsageBucket["totals"] }): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    row.totals.uncachedInputTokens +
    row.totals.cachedInputTokens +
    row.totals.cacheCreationTokens +
    row.totals.outputTokens
  );
}

const EMPTY_MERGED: MergedUsage = {
  costUsd: 0,
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  records: 0,
  sessions: 0,
  providers: [],
  models: [],
  projects: [],
  sessionTotals: [],
  daily: [],
  costQuality: {
    providerReportedShare: 0,
    modelPricedShare: 0,
    unpricedShare: 0,
    cacheSavingsUsd: 0,
  },
  duplicateSources: [],
  contributingEnvironments: [],
  staleEnvironments: [],
};

/**
 * Merges every connected environment's summary.
 *
 * `expectedContractVersion` guards against an environment running older server
 * code: rather than blocking the page, its data is excluded and its id is
 * reported so the UI can say coverage is partial.
 */
export function mergeUsage(
  environments: readonly EnvironmentUsage[],
  expectedContractVersion: number,
): MergedUsage {
  if (environments.length === 0) return EMPTY_MERGED;

  const current: EnvironmentUsage[] = [];
  const staleEnvironments: EnvironmentId[] = [];
  for (const environment of environments) {
    if (environment.summary.contractVersion === expectedContractVersion) {
      current.push(environment);
    } else {
      staleEnvironments.push(environment.environmentId);
    }
  }

  const { ownerByFingerprint, duplicates } = claimSources(current);

  let costUsd = 0;
  let uncachedInputTokens = 0;
  let cachedInputTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let records = 0;
  let sessions = 0;
  let cacheSavingsUsd = 0;
  let providerReportedRecords = 0;
  let unpricedRecords = 0;

  const providerAccumulator = new Map<
    UsageProviderKind,
    { costUsd: number; totalTokens: number; records: number }
  >();
  const modelAccumulator = new Map<
    string,
    { provider: UsageProviderKind; costUsd: number; totalTokens: number; records: number }
  >();
  const projectAccumulator = new Map<
    string,
    {
      projectPath: string;
      costUsd: number;
      totalTokens: number;
      records: number;
      sessions: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
      firstDay: string;
      lastDay: string;
    }
  >();
  const sessionAccumulator = new Map<
    string,
    {
      projectPath: string;
      provider: UsageProviderKind;
      models: Set<string>;
      costUsd: number;
      totalTokens: number;
      records: number;
      firstDay: string;
      lastDay: string;
      threadId: string | null;
      threadTitle: string | null;
      environmentId: EnvironmentId | null;
    }
  >();
  const dailyAccumulator = new Map<
    string,
    {
      costUsd: number;
      totalTokens: number;
      byProvider: Map<UsageProviderKind, { costUsd: number; totalTokens: number }>;
    }
  >();
  const contributingEnvironments: EnvironmentId[] = [];

  for (const environment of current) {
    const {
      buckets,
      projects: environmentProjects,
      sessionBuckets,
      sessions: environmentSessions,
    } = ownedContribution(environment, ownerByFingerprint);
    if (buckets.length > 0) contributingEnvironments.push(environment.environmentId);
    sessions += environmentSessions;

    for (const bucket of buckets) {
      const tokens = rowTokens(bucket);

      costUsd += bucket.costUsd;
      cacheSavingsUsd += bucket.cacheSavingsUsd;
      uncachedInputTokens += bucket.totals.uncachedInputTokens;
      cachedInputTokens += bucket.totals.cachedInputTokens;
      cacheCreationTokens += bucket.totals.cacheCreationTokens;
      outputTokens += bucket.totals.outputTokens;
      reasoningTokens += bucket.totals.reasoningTokens;
      records += bucket.records;
      unpricedRecords += bucket.unpricedRecords;
      if (bucket.costSource === "providerReported") providerReportedRecords += bucket.records;

      const provider = providerAccumulator.get(bucket.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
        records: 0,
      };
      provider.costUsd += bucket.costUsd;
      provider.totalTokens += tokens;
      provider.records += bucket.records;
      providerAccumulator.set(bucket.provider, provider);

      const modelKey = `${bucket.provider} ${bucket.model}`;
      const model = modelAccumulator.get(modelKey) ?? {
        provider: bucket.provider,
        costUsd: 0,
        totalTokens: 0,
        records: 0,
      };
      model.costUsd += bucket.costUsd;
      model.totalTokens += tokens;
      model.records += bucket.records;
      modelAccumulator.set(modelKey, model);

      const day = dailyAccumulator.get(bucket.day) ?? {
        costUsd: 0,
        totalTokens: 0,
        byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
      };
      day.costUsd += bucket.costUsd;
      day.totalTokens += tokens;
      const dayProvider = day.byProvider.get(bucket.provider) ?? { costUsd: 0, totalTokens: 0 };
      dayProvider.costUsd += bucket.costUsd;
      dayProvider.totalTokens += tokens;
      day.byProvider.set(bucket.provider, dayProvider);
      dailyAccumulator.set(bucket.day, day);
    }

    // Two environments on different machines can legitimately report the same
    // project path; fingerprint claiming has already removed the case where
    // they are the same directory read twice, so these merge.
    // Keyed by path alone, so one project worked on with both harnesses is a
    // single row carrying a per-provider split.
    for (const project of environmentProjects) {
      const tokens = rowTokens(project);
      let existing = projectAccumulator.get(project.projectPath);
      if (existing === undefined) {
        existing = {
          projectPath: project.projectPath,
          costUsd: 0,
          totalTokens: 0,
          records: 0,
          sessions: 0,
          byProvider: new Map<UsageProviderKind, { costUsd: number; totalTokens: number }>(),
          firstDay: project.firstDay,
          lastDay: project.lastDay,
        };
        projectAccumulator.set(project.projectPath, existing);
      }
      existing.costUsd += project.costUsd;
      existing.totalTokens += tokens;
      existing.records += project.records;
      existing.sessions += project.sessions;
      const perProvider = existing.byProvider.get(project.provider) ?? {
        costUsd: 0,
        totalTokens: 0,
      };
      perProvider.costUsd += project.costUsd;
      perProvider.totalTokens += tokens;
      existing.byProvider.set(project.provider, perProvider);
      if (project.firstDay < existing.firstDay) existing.firstDay = project.firstDay;
      if (project.lastDay > existing.lastDay) existing.lastDay = project.lastDay;
    }

    for (const session of sessionBuckets) {
      const existing = sessionAccumulator.get(session.sessionId);
      if (existing === undefined) {
        sessionAccumulator.set(session.sessionId, {
          projectPath: session.projectPath,
          provider: session.provider,
          models: new Set(session.models),
          costUsd: session.costUsd,
          totalTokens: rowTokens(session),
          records: session.records,
          firstDay: session.firstDay,
          lastDay: session.lastDay,
          threadId: session.threadId,
          threadTitle: session.threadTitle,
          // Only meaningful paired with the thread id it came from.
          environmentId: session.threadId === null ? null : environment.environmentId,
        });
        continue;
      }
      existing.costUsd += session.costUsd;
      existing.totalTokens += rowTokens(session);
      existing.records += session.records;
      for (const model of session.models) existing.models.add(model);
      if (session.firstDay < existing.firstDay) existing.firstDay = session.firstDay;
      if (session.lastDay > existing.lastDay) existing.lastDay = session.lastDay;
      // First environment to claim the thread keeps it; a second one linking the
      // same session would be the same thread reported twice.
      if (existing.threadId === null && session.threadId !== null) {
        existing.threadId = session.threadId;
        existing.threadTitle = session.threadTitle;
        existing.environmentId = environment.environmentId;
      }
    }
  }

  const totalTokens = uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens;

  const providers: ProviderTotals[] = [...providerAccumulator.entries()]
    .map(([provider, totals]) => ({
      provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      tokenShare: totalTokens === 0 ? 0 : totals.totalTokens / totalTokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  const models: ModelTotals[] = [...modelAccumulator.entries()]
    .map(([key, totals]) => ({
      model: key.slice(key.indexOf(" ") + 1),
      provider: totals.provider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const projects: ProjectTotals[] = [...projectAccumulator.values()]
    .map((totals) => ({
      projectPath: totals.projectPath,
      byProvider: totals.byProvider,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      sessions: totals.sessions,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      firstDay: totals.firstDay,
      lastDay: totals.lastDay,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const sessionTotals: SessionTotals[] = [...sessionAccumulator.entries()]
    .map(([sessionId, totals]) => ({
      sessionId,
      projectPath: totals.projectPath,
      provider: totals.provider,
      models: [...totals.models].sort(),
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      records: totals.records,
      costShare: costUsd === 0 ? 0 : totals.costUsd / costUsd,
      firstDay: totals.firstDay,
      lastDay: totals.lastDay,
      threadId: totals.threadId,
      threadTitle: totals.threadTitle,
      environmentId: totals.environmentId,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const daily: DailyTotals[] = [...dailyAccumulator.entries()]
    .map(([day, totals]) => ({
      day,
      costUsd: totals.costUsd,
      totalTokens: totals.totalTokens,
      byProvider: totals.byProvider,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    costUsd,
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    records,
    sessions,
    providers,
    models,
    projects,
    sessionTotals,
    daily,
    costQuality: {
      providerReportedShare: records === 0 ? 0 : providerReportedRecords / records,
      unpricedShare: records === 0 ? 0 : unpricedRecords / records,
      modelPricedShare:
        records === 0 ? 0 : (records - providerReportedRecords - unpricedRecords) / records,
      cacheSavingsUsd,
    },
    duplicateSources: duplicates,
    contributingEnvironments,
    staleEnvironments,
  };
}
