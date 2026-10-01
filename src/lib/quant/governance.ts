import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { getDb, schema } from "../db";
import { MODEL_NAME, freshModel, normaliseState, type ModelState } from "./model";
import type { QuantTuning } from "./tuning";

export type ModelScope = "shared" | "US" | "UK";
export type GovernanceMetrics = typeof schema.modelVersions.$inferSelect.metrics;

export interface TrainingWindow {
  from: string;
  to: string;
  firstCandidateId?: number | null;
  lastCandidateId?: number | null;
}

export interface ForwardEvidence {
  probability: number;
  outcome: boolean;
  actualAfterCostPct: number;
  predictedTrade: boolean;
  selected: boolean;
  runId: number;
}

const numericEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export function governanceThresholds() {
  return {
    marketTrainingSamples: numericEnv("MODEL_MARKET_MIN_TRAINING_SAMPLES", 100),
    promotionOutcomes: numericEnv("MODEL_PROMOTION_MIN_OUTCOMES", 100),
    promotionDays: numericEnv("MODEL_PROMOTION_MIN_DAYS", 20),
    maxCalibrationError: numericEnv("MODEL_PROMOTION_MAX_CALIBRATION_ERROR", 0.1),
    rollbackOutcomes: numericEnv("MODEL_ROLLBACK_MIN_OUTCOMES", 30),
    rollbackBrierDelta: numericEnv("MODEL_ROLLBACK_BRIER_DELTA", 0.03),
    rollbackCalibrationDelta: numericEnv("MODEL_ROLLBACK_CALIBRATION_DELTA", 0.05),
    rollbackReturnDeltaPct: numericEnv("MODEL_ROLLBACK_RETURN_DELTA_PCT", 0.5),
    rollbackDrawdownDeltaPct: numericEnv("MODEL_ROLLBACK_DRAWDOWN_DELTA_PCT", 5),
  };
}

type Thresholds = ReturnType<typeof governanceThresholds>;

export function promotionReady(
  champion: GovernanceMetrics,
  challenger: GovernanceMetrics,
  outcomes: number,
  sessions: number,
  threshold: Thresholds,
): boolean {
  const comparable =
    outcomes >= threshold.promotionOutcomes &&
    sessions >= threshold.promotionDays &&
    challenger.brier != null &&
    champion.brier != null;
  const frequencySafe =
    challenger.meanAfterCostReturnPct != null &&
    challenger.maxDrawdownPct != null &&
    champion.meanAfterCostReturnPct != null &&
    champion.maxDrawdownPct != null &&
    challenger.predictedTradeFrequency != null &&
    champion.predictedTradeFrequency != null &&
    challenger.predictedTradeFrequency >= champion.predictedTradeFrequency * 0.25 &&
    challenger.predictedTradeFrequency <= Math.max(0.02, champion.predictedTradeFrequency * 4);
  return (
    comparable &&
    challenger.calibrationError != null &&
    champion.calibrationError != null &&
    challenger.calibrationError <= threshold.maxCalibrationError &&
    challenger.calibrationError <= champion.calibrationError &&
    challenger.brier! <= champion.brier! &&
    challenger.baselineBrier != null &&
    challenger.brier! < challenger.baselineBrier &&
    challenger.meanAfterCostReturnPct! >= champion.meanAfterCostReturnPct! &&
    challenger.maxDrawdownPct! <= champion.maxDrawdownPct! &&
    frequencySafe
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function settingsFingerprint(settings: unknown): string {
  return createHash("sha256").update(canonical(settings)).digest("hex");
}

const emptyMetrics = (): GovernanceMetrics => ({
  calibrationError: null,
  brier: null,
  baselineBrier: null,
  meanAfterCostReturnPct: null,
  maxDrawdownPct: null,
  predictedTradeFrequency: null,
});

export function calculateForwardMetrics(rows: ForwardEvidence[]): GovernanceMetrics {
  if (!rows.length) return emptyMetrics();
  const y = rows.map((row) => (row.outcome ? 1 : 0));
  const base = y.reduce<number>((sum, value) => sum + value, 0) / y.length;
  const brier = rows.reduce((sum, row, i) => sum + (row.probability - y[i]) ** 2, 0) / rows.length;
  const baselineBrier = y.reduce<number>((sum, value) => sum + (base - value) ** 2, 0) / y.length;

  let calibratedN = 0;
  let calibrationError = 0;
  for (let bin = 0; bin < 10; bin++) {
    const bucket = rows.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === bin);
    if (!bucket.length) continue;
    const predicted = bucket.reduce((sum, row) => sum + row.probability, 0) / bucket.length;
    const realised = bucket.filter((row) => row.outcome).length / bucket.length;
    calibrationError += Math.abs(predicted - realised) * bucket.length;
    calibratedN += bucket.length;
  }

  const trades = rows.filter((row) => row.selected && row.predictedTrade);
  let wealth = 1;
  let peak = 1;
  let maxDrawdownPct = 0;
  for (const row of trades) {
    wealth *= Math.max(0, 1 + row.actualAfterCostPct / 100);
    peak = Math.max(peak, wealth);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? ((peak - wealth) / peak) * 100 : 0);
  }
  const runs = new Set(rows.map((row) => row.runId)).size;
  return {
    calibrationError: calibratedN ? calibrationError / calibratedN : null,
    brier,
    baselineBrier,
    meanAfterCostReturnPct: trades.length
      ? trades.reduce((sum, row) => sum + row.actualAfterCostPct, 0) / trades.length
      : null,
    maxDrawdownPct: trades.length ? maxDrawdownPct : null,
    predictedTradeFrequency: runs ? new Set(trades.map((row) => row.runId)).size / runs : null,
  };
}

async function initialSharedState(): Promise<ModelState> {
  const row = await getDb().select().from(schema.modelState).where(eq(schema.modelState.name, MODEL_NAME)).get();
  return normaliseState(row?.state);
}

export async function ensureSharedDeployment() {
  const db = getDb();
  const existing = await db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.scope, "shared")).get();
  if (existing) return existing;
  const state = await initialSharedState();
  const [version] = await db
    .insert(schema.modelVersions)
    .values({
      modelName: MODEL_NAME,
      scope: "shared",
      state,
      samples: state.samples,
      trainingFrom: "legacy",
      trainingTo: "legacy",
      firstCandidateId: null,
      lastCandidateId: state.lastCandidateId || null,
      settingsFingerprint: "legacy",
      settings: {},
      metrics: emptyMetrics(),
    })
    .returning();
  await db
    .insert(schema.modelDeployments)
    .values({ scope: "shared", championVersionId: version.id })
    .onConflictDoNothing({ target: schema.modelDeployments.scope });
  return (await db.select().from(schema.modelDeployments).where(eq(schema.modelDeployments.scope, "shared")).get())!;
}

async function deployment(scope: ModelScope) {
  if (scope === "shared") return ensureSharedDeployment();
  return getDb().select().from(schema.modelDeployments).where(eq(schema.modelDeployments.scope, scope)).get();
}

async function version(id: number | null | undefined) {
  if (!id) return null;
  return (await getDb().select().from(schema.modelVersions).where(eq(schema.modelVersions.id, id)).get()) ?? null;
}

export async function governedChampion(scope: ModelScope): Promise<{ id: number; state: ModelState }> {
  const selected = (await deployment(scope)) ?? (await ensureSharedDeployment());
  const champion = (await version(selected.championVersionId))!;
  return { id: champion.id, state: normaliseState(champion.state) };
}

export async function governedModels(market: "US" | "UK") {
  const selected = (await deployment(market)) ?? (await ensureSharedDeployment());
  const champion = await governedChampion(market);
  const challenger = await version(selected.challengerVersionId ?? selected.previousChampionVersionId);
  return {
    scope: selected.scope as ModelScope,
    champion,
    challenger: challenger ? { id: challenger.id, state: normaliseState(challenger.state) } : null,
  };
}

export async function trainingBase(scope: ModelScope): Promise<{ id: number | null; state: ModelState }> {
  const latest = await getDb()
    .select()
    .from(schema.modelVersions)
    .where(and(eq(schema.modelVersions.modelName, MODEL_NAME), eq(schema.modelVersions.scope, scope)))
    .orderBy(desc(schema.modelVersions.id))
    .limit(1)
    .get();
  const base = latest ?? (scope === "shared" ? await version((await ensureSharedDeployment()).championVersionId) : null);
  return base ? { id: base.id, state: normaliseState(base.state) } : { id: null, state: freshModel() };
}

export async function persistTrainedVersion(input: {
  scope: ModelScope;
  parentVersionId: number | null;
  state: ModelState;
  tuning: QuantTuning;
  window: TrainingWindow;
  metrics?: Partial<GovernanceMetrics>;
  reason: string;
}) {
  const db = getDb();
  const metrics = { ...emptyMetrics(), ...input.metrics };
  const [created] = await db
    .insert(schema.modelVersions)
    .values({
      modelName: MODEL_NAME,
      scope: input.scope,
      parentVersionId: input.parentVersionId,
      state: input.state,
      samples: input.state.samples,
      trainingFrom: input.window.from,
      trainingTo: input.window.to,
      firstCandidateId: input.window.firstCandidateId ?? null,
      lastCandidateId: input.window.lastCandidateId ?? null,
      settingsFingerprint: settingsFingerprint(input.tuning),
      settings: input.tuning,
      metrics,
    })
    .returning();

  const current = await deployment(input.scope);
  const assignAsChallenger = !!current && !current.challengerVersionId && !current.previousChampionVersionId;
  if (assignAsChallenger) {
    await db
      .update(schema.modelDeployments)
      .set({ challengerVersionId: created.id, updatedAt: new Date() })
      .where(eq(schema.modelDeployments.scope, input.scope));
  } else if (!current) {
    const fallback = await ensureSharedDeployment();
    await db.insert(schema.modelDeployments).values({
      scope: input.scope,
      championVersionId: fallback.championVersionId,
      challengerVersionId: created.id,
    });
  }
  if (!current || assignAsChallenger) {
    await db.insert(schema.modelGovernanceEvents).values({
      scope: input.scope,
      action: "challenger_created",
      fromVersionId: current?.championVersionId ?? null,
      toVersionId: created.id,
      reason: input.reason,
      evidence: metrics,
    });
  }
  return created;
}

export async function persistForwardEvidence(input: {
  runId: number;
  market: "US" | "UK";
  versionId: number;
  kind: "champion" | "shadow";
  rows: {
    candidateId: number;
    probability: number;
    rawProbability: number;
    expectedAfterCostPct: number;
    costPct: number;
    selected: boolean;
    predictedTrade: boolean;
  }[];
}) {
  if (!input.rows.length) return;
  await getDb()
    .insert(schema.modelEvidence)
    .values(
      input.rows.map((row) => ({
        ...row,
        runId: input.runId,
        market: input.market,
        modelVersionId: input.versionId,
        kind: input.kind,
      })),
    )
    .onConflictDoNothing({ target: [schema.modelEvidence.modelVersionId, schema.modelEvidence.candidateId] });
}

export async function attachOutcomes(candidateIds: number[]): Promise<void> {
  if (!candidateIds.length) return;
  const db = getDb();
  const rows = await db.select().from(schema.candidates).where(inArray(schema.candidates.id, candidateIds));
  for (const row of rows) {
    if (row.overnightReturnPct == null) continue;
    const evidence = await db.select().from(schema.modelEvidence).where(eq(schema.modelEvidence.candidateId, row.id));
    for (const item of evidence) {
      await db
        .update(schema.modelEvidence)
        .set({
          actualReturnPct: row.overnightReturnPct,
          actualAfterCostPct: row.overnightReturnPct - item.costPct,
          outcome: row.overnightReturnPct > item.costPct,
          observedAt: new Date(),
        })
        .where(eq(schema.modelEvidence.id, item.id));
    }
  }
}

async function evidenceRows(versionId: number, since?: Date | null): Promise<ForwardEvidence[]> {
  const rows = await getDb()
    .select()
    .from(schema.modelEvidence)
    .where(
      and(
        eq(schema.modelEvidence.modelVersionId, versionId),
        isNotNull(schema.modelEvidence.outcome),
        ...(since ? [gte(schema.modelEvidence.predictedAt, since)] : []),
      ),
    )
    .orderBy(asc(schema.modelEvidence.observedAt));
  return rows.map((row) => ({
    probability: row.probability,
    outcome: row.outcome === true,
    actualAfterCostPct: row.actualAfterCostPct ?? 0,
    predictedTrade: row.predictedTrade,
    selected: row.selected,
    runId: row.runId,
  }));
}

export async function governanceReport(scope: ModelScope) {
  const selected = await deployment(scope);
  if (!selected) return null;
  const comparisonVersionId = selected.challengerVersionId ?? selected.previousChampionVersionId;
  const since = selected.previousChampionVersionId ? selected.promotedAt : null;
  const championAll = await evidenceRows(selected.championVersionId, since);
  const challengerAll = comparisonVersionId ? await evidenceRows(comparisonVersionId, since) : [];
  const commonRuns = new Set(challengerAll.map((row) => row.runId));
  const championRows = championAll.filter((row) => commonRuns.has(row.runId));
  const championRuns = new Set(championRows.map((row) => row.runId));
  const challengerRows = challengerAll.filter((row) => championRuns.has(row.runId));
  const days = new Set(challengerRows.map((row) => row.runId)).size;
  const champion = calculateForwardMetrics(championRows);
  const challenger = calculateForwardMetrics(challengerRows);
  const threshold = governanceThresholds();
  const ready = promotionReady(champion, challenger, challengerRows.length, days, threshold);
  return {
    scope,
    championVersionId: selected.championVersionId,
    challengerVersionId: comparisonVersionId,
    previousChampionVersionId: selected.previousChampionVersionId,
    outcomes: challengerRows.length,
    days,
    champion,
    challenger,
    readyForManualPromotion: ready,
    thresholds: threshold,
  };
}

export async function promoteChallenger(scope: ModelScope, reason: string) {
  const db = getDb();
  const report = await governanceReport(scope);
  if (!report?.challengerVersionId) throw new Error(`No ${scope} challenger exists`);
  if (report.previousChampionVersionId) throw new Error(`The ${scope} champion is still in its rollback monitoring window`);
  if (!report.readyForManualPromotion) throw new Error(`The ${scope} challenger has not met promotion evidence thresholds`);
  await db
    .update(schema.modelDeployments)
    .set({
      championVersionId: report.challengerVersionId,
      challengerVersionId: null,
      previousChampionVersionId: report.championVersionId,
      promotedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.modelDeployments.scope, scope));
  await db.insert(schema.modelGovernanceEvents).values({
    scope,
    action: "promoted",
    fromVersionId: report.championVersionId,
    toVersionId: report.challengerVersionId,
    reason,
    evidence: report.challenger,
  });
  return governanceReport(scope);
}

export async function rollback(scope: ModelScope, reason: string, automatic = false) {
  const db = getDb();
  const selected = await deployment(scope);
  if (!selected?.previousChampionVersionId) throw new Error(`No ${scope} previous champion exists`);
  const from = selected.championVersionId;
  const to = selected.previousChampionVersionId;
  await db
    .update(schema.modelDeployments)
    .set({
      championVersionId: to,
      challengerVersionId: from,
      previousChampionVersionId: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.modelDeployments.scope, scope));
  await db.insert(schema.modelGovernanceEvents).values({
    scope,
    action: "rolled_back",
    fromVersionId: from,
    toVersionId: to,
    reason: `${automatic ? "automatic" : "manual"}: ${reason}`,
    evidence: calculateForwardMetrics(await evidenceRows(from)),
  });
  return governanceReport(scope);
}

export async function autoRollbackIfDeteriorated(scope: ModelScope): Promise<boolean> {
  const report = await governanceReport(scope);
  if (!report?.previousChampionVersionId || !report.challengerVersionId) return false;
  const t = report.thresholds;
  if (report.outcomes < t.rollbackOutcomes) return false;
  const current = report.champion;
  const previous = report.challenger;
  const brierBad = current.brier != null && previous.brier != null && current.brier - previous.brier >= t.rollbackBrierDelta;
  const calibrationBad =
    current.calibrationError != null &&
    previous.calibrationError != null &&
    current.calibrationError - previous.calibrationError >= t.rollbackCalibrationDelta;
  const returnBad =
    current.meanAfterCostReturnPct != null &&
    previous.meanAfterCostReturnPct != null &&
    previous.meanAfterCostReturnPct - current.meanAfterCostReturnPct >= t.rollbackReturnDeltaPct;
  const drawdownBad =
    current.maxDrawdownPct != null &&
    previous.maxDrawdownPct != null &&
    current.maxDrawdownPct - previous.maxDrawdownPct >= t.rollbackDrawdownDeltaPct;
  if (!brierBad && !calibrationBad && !returnBad && !drawdownBad) {
    await getDb()
      .update(schema.modelDeployments)
      .set({ previousChampionVersionId: null, updatedAt: new Date() })
      .where(eq(schema.modelDeployments.scope, scope));
    return false;
  }
  await rollback(
    scope,
    `forward metrics materially deteriorated (brier=${brierBad}, calibration=${calibrationBad}, return=${returnBad}, drawdown=${drawdownBad})`,
    true,
  );
  return true;
}
