/**
 * The learned half of the decision engine.
 *
 * A ridge-regularised logistic regression trained online on the app's own counterfactual data: every
 * shortlisted candidate (picked or not) gets its actual close-to-next-open return recorded, which is
 * roughly eight labelled examples per trading day rather than one. Three things make it safe to run
 * on tiny samples:
 *
 * 1. Coefficients start at hand-set priors from the overnight-returns literature and are regularised
 *    *toward those priors*, so evidence has to earn any move away from them.
 * 2. Features are standardised online with Welford statistics, so no feature can dominate because of
 *    its units.
 * 3. Raw model output is passed through a calibration curve fitted on realised outcomes, which is
 *    what stops the engine from becoming quietly overconfident.
 */

import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import {
  clamp,
  finite,
  logit,
  newRunningStat,
  pushStat,
  shrunkRate,
  sigmoid,
  statStd,
  type RunningStat,
} from "./stats";
import { FEATURE_KEYS, PRIOR_BIAS, priorWeights, type FeatureVector } from "./features";
import { DEFAULT_TUNING, type QuantTuning } from "./tuning";

export const MODEL_NAME = "overnight_v1";
const MODEL_VERSION = 1;

const CALIBRATION_BINS = 8;

export interface ModelState {
  version: number;
  samples: number;
  bias: number;
  weights: FeatureVector;
  /** AdaGrad accumulators, one per feature plus the bias. */
  grad2: FeatureVector;
  biasGrad2: number;
  stats: Record<string, RunningStat>;
  /** Reliability curve: predicted-probability bins with realised win counts. */
  calibration: { n: number; wins: number; sum: number }[];
  /** Highest candidate id already trained on, so training never double-counts a row. */
  lastCandidateId: number;
  updatedAt: number;
}

export function freshModel(): ModelState {
  return {
    version: MODEL_VERSION,
    samples: 0,
    bias: PRIOR_BIAS,
    weights: priorWeights(),
    grad2: Object.fromEntries(FEATURE_KEYS.map((k) => [k, 0])),
    biasGrad2: 0,
    stats: Object.fromEntries(FEATURE_KEYS.map((k) => [k, newRunningStat()])),
    calibration: Array.from({ length: CALIBRATION_BINS }, () => ({ n: 0, wins: 0, sum: 0 })),
    lastCandidateId: 0,
    updatedAt: Date.now(),
  };
}

/** Tolerates state written by an older feature set: unknown keys drop, new keys take their prior. */
export function normaliseState(raw: unknown): ModelState {
  const fresh = freshModel();
  if (!raw || typeof raw !== "object") return fresh;
  const s = raw as Partial<ModelState>;
  if (s.version !== MODEL_VERSION) return fresh;
  const pick = <T>(src: Record<string, T> | undefined, fallback: Record<string, T>) =>
    Object.fromEntries(FEATURE_KEYS.map((k) => [k, src?.[k] ?? fallback[k]]));
  return {
    version: MODEL_VERSION,
    samples: finite(s.samples ?? 0),
    bias: finite(s.bias ?? fresh.bias, fresh.bias),
    weights: pick(s.weights, fresh.weights),
    grad2: pick(s.grad2, fresh.grad2),
    biasGrad2: finite(s.biasGrad2 ?? 0),
    stats: pick(s.stats, fresh.stats),
    calibration:
      Array.isArray(s.calibration) && s.calibration.length === CALIBRATION_BINS ? s.calibration : fresh.calibration,
    lastCandidateId: finite(s.lastCandidateId ?? 0),
    updatedAt: s.updatedAt ?? Date.now(),
  };
}

export async function loadModel(): Promise<ModelState> {
  const [row] = await getDb().select().from(schema.modelState).where(eq(schema.modelState.name, MODEL_NAME));
  return normaliseState(row?.state);
}

export async function saveModel(state: ModelState): Promise<void> {
  const value = { ...state, updatedAt: Date.now() };
  await getDb()
    .insert(schema.modelState)
    .values({ name: MODEL_NAME, version: MODEL_VERSION, samples: value.samples, state: value })
    .onConflictDoUpdate({
      target: schema.modelState.name,
      set: { state: value, samples: value.samples, version: MODEL_VERSION, updatedAt: new Date() },
    });
}

/** Standardise a feature, falling back to the raw value until the running statistics mean anything. */
function z(state: ModelState, key: string, value: number): number {
  const s = state.stats[key];
  if (!s || s.n < 20) return clamp(finite(value), -5, 5);
  const sd = statStd(s);
  return clamp(sd > 1e-6 ? (finite(value) - s.mean) / sd : 0, -5, 5);
}

export interface Prediction {
  /** Raw model probability before calibration. */
  raw: number;
  /** Calibrated probability. */
  probability: number;
  logOdds: number;
  /** Per-feature contribution to the log-odds, largest magnitude first. */
  contributions: { key: string; contribution: number; z: number }[];
}

export function predict(state: ModelState, features: FeatureVector): Prediction {
  let logOdds = state.bias;
  const contributions: { key: string; contribution: number; z: number }[] = [];
  for (const key of FEATURE_KEYS) {
    const zi = z(state, key, features[key] ?? 0);
    const c = (state.weights[key] ?? 0) * zi;
    logOdds += c;
    contributions.push({ key, contribution: finite(c), z: zi });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const raw = sigmoid(logOdds);
  return { raw, probability: applyCalibration(state, raw), logOdds, contributions };
}

const binOf = (p: number) => clamp(Math.floor(p * CALIBRATION_BINS), 0, CALIBRATION_BINS - 1);

/**
 * Maps a raw probability to the win rate actually observed for similar predictions. Neighbouring
 * bins are pooled and the result is shrunk toward the raw value, so calibration only bites once
 * there is enough evidence to justify it.
 */
export function applyCalibration(state: ModelState, raw: number): number {
  const b = binOf(raw);
  let n = 0;
  let wins = 0;
  for (let i = Math.max(0, b - 1); i <= Math.min(CALIBRATION_BINS - 1, b + 1); i++) {
    n += state.calibration[i].n;
    wins += state.calibration[i].wins;
  }
  if (n < 15) return raw;
  const observed = shrunkRate(wins, n, raw, 10);
  // Blend in log-odds space; trust calibration more as evidence accumulates.
  const trust = clamp(n / (n + 40), 0, 0.75);
  return sigmoid(logit(raw) * (1 - trust) + logit(observed) * trust);
}

export interface TrainingSample {
  features: FeatureVector;
  /** True when the realised overnight return cleared the cost threshold. */
  label: boolean;
  /** Down-weights samples we are less sure about (e.g. stale or partial data). */
  weight?: number;
}

export interface TrainOptions {
  /**
   * Features this batch cannot supply honestly (replayed history has no headlines or market context).
   * They are left out of the standardisation statistics and their coefficients are not touched, so
   * a batch of neutral placeholders cannot teach the model that those features never vary.
   */
  frozen?: ReadonlySet<string>;
  /** Record this batch in the reliability curve. Off for replayed history, which is not live-comparable. */
  calibrate?: boolean;
}

/**
 * One pass of regularised online gradient descent. Returns a new state; the caller persists it.
 * Samples should be passed in chronological order.
 */
export function train(state: ModelState, samples: TrainingSample[], tuning: QuantTuning = DEFAULT_TUNING, opts: TrainOptions = {}): ModelState {
  if (samples.length === 0) return state;
  const { ridge: RIDGE, learningRate: LEARNING_RATE, trainingPasses: passes } = tuning;
  const frozen = opts.frozen ?? new Set<string>();
  const next: ModelState = {
    ...state,
    weights: { ...state.weights },
    grad2: { ...state.grad2 },
    stats: { ...state.stats },
    calibration: state.calibration.map((b) => ({ ...b })),
  };
  const priors = priorWeights();

  // Update standardisation first so this batch is scored on comparable units.
  for (const s of samples) {
    for (const key of FEATURE_KEYS) if (!frozen.has(key)) next.stats[key] = pushStat(next.stats[key], s.features[key] ?? 0);
  }

  for (let pass = 0; pass < passes; pass++) {
    for (const s of samples) {
      const w = clamp(s.weight ?? 1, 0, 3);
      const zs = FEATURE_KEYS.map((k) => (frozen.has(k) ? 0 : z(next, k, s.features[k] ?? 0)));
      let logOdds = next.bias;
      for (const [i, k] of FEATURE_KEYS.entries()) logOdds += (next.weights[k] ?? 0) * zs[i];
      const error = sigmoid(logOdds) - (s.label ? 1 : 0);

      for (const [i, k] of FEATURE_KEYS.entries()) {
        if (frozen.has(k)) continue;
        // Ridge pulls toward the prior coefficient rather than toward zero.
        const grad = w * error * zs[i] + RIDGE * ((next.weights[k] ?? 0) - priors[k]);
        next.grad2[k] = (next.grad2[k] ?? 0) + grad * grad;
        next.weights[k] = finite((next.weights[k] ?? 0) - (LEARNING_RATE * grad) / Math.sqrt(1 + next.grad2[k]), priors[k]);
      }
      const bGrad = w * error + RIDGE * (next.bias - PRIOR_BIAS);
      next.biasGrad2 += bGrad * bGrad;
      next.bias = finite(next.bias - (LEARNING_RATE * bGrad) / Math.sqrt(1 + next.biasGrad2), PRIOR_BIAS);
    }
  }

  // Calibration is measured against the freshly updated coefficients.
  if (opts.calibrate !== false) {
    for (const s of samples) {
      let logOdds = next.bias;
      for (const k of FEATURE_KEYS) logOdds += (next.weights[k] ?? 0) * z(next, k, s.features[k] ?? 0);
      const raw = sigmoid(logOdds);
      const bin = next.calibration[binOf(raw)];
      bin.n += 1;
      bin.sum += raw;
      if (s.label) bin.wins += 1;
    }
  }

  next.samples += samples.length;
  next.updatedAt = Date.now();
  return next;
}

export interface ModelDiagnostics {
  samples: number;
  /** Brier-style reliability gap: mean |predicted - realised| across populated bins. */
  calibrationError: number | null;
  /** Coefficients that have moved furthest from their priors, i.e. what the engine has learned. */
  learned: { key: string; weight: number; prior: number; drift: number }[];
  reliability: { bucket: string; predicted: number; realised: number; n: number }[];
}

export function diagnostics(state: ModelState): ModelDiagnostics {
  const priors = priorWeights();
  const learned = FEATURE_KEYS.map((key) => ({
    key,
    weight: state.weights[key] ?? 0,
    prior: priors[key],
    drift: (state.weights[key] ?? 0) - priors[key],
  })).sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));

  const reliability = state.calibration
    .map((b, i) => ({
      bucket: `${Math.round((i / CALIBRATION_BINS) * 100)}-${Math.round(((i + 1) / CALIBRATION_BINS) * 100)}%`,
      predicted: b.n ? b.sum / b.n : 0,
      realised: b.n ? b.wins / b.n : 0,
      n: b.n,
    }))
    .filter((b) => b.n > 0);

  const populated = reliability.filter((b) => b.n >= 5);
  const calibrationError = populated.length
    ? populated.reduce((s, b) => s + Math.abs(b.predicted - b.realised) * b.n, 0) / populated.reduce((s, b) => s + b.n, 0)
    : null;

  return { samples: state.samples, calibrationError, learned, reliability };
}
