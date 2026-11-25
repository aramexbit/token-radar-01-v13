import { readFileSync } from "node:fs";
//
// The model is one global OLS curve fitted on the snapshot's own traded
// protocols: log10(market cap) against log10(TVL). A pre-token protocol is
// priced by reading its TVL off that curve, then applying one small,
// held-out-tested adjustment: listing age at HALF strength. The 7-day TVL
// growth term was computed, tested on two held-out tests, and dropped —
// it improves the two-test average on neither median miss nor within-3x,
// at full strength or half. Age survives only at half strength, for the
// same reason: full strength fails the two-test average on within-3x.
// Nothing else enters the price — in particular no category tilt, even
// though one was computed and is shown in the Method tab with the reason
// it was left out. The decisions are computed in validate(), not asserted
// here; the table on the dashboard shows the numbers behind each one.

export type Protocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

export type Snapshot = {
  as_of: string;
  source: string;
  protocols: Protocol[];
};

export type OlsFit = { slope: number; intercept: number; r2: number; n: number };

export type BoardRow = {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
};

export type Board = { as_of: string; rows: BoardRow[] };

export const AS_OF = "2026-11-14";
// Token-odds cohorts are cut a couple of days earlier so the listing-age
// buckets are whole calendar years; see tokenOdds below.
export const ODDS_AS_OF = "2026-11-12";

export function loadSnapshot(path: string): Snapshot {
  return parseSnapshot(readFileSync(path, "utf8"));
}

export function parseSnapshot(text: string): Snapshot {
  return JSON.parse(text) as Snapshot;
}

/** Traded comparables: market cap above zero, one row per ticker. When two
 *  protocols share a ticker the first one in snapshot order is kept. */
export function tradedComps(protocols: Protocol[]): Protocol[] {
  const seen = new Set<string>();
  const out: Protocol[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0) continue;
    const ticker = (p.symbol ?? "").toLowerCase();
    if (ticker !== "" && seen.has(ticker)) continue;
    if (ticker !== "") seen.add(ticker);
    out.push(p);
  }
  return out;
}

export function olsFit(rows: Protocol[]): OlsFit {
  const xs = rows.map((p) => Math.log10(p.tvl_usd));
  const ys = rows.map((p) => Math.log10(p.mcap_usd as number));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

export function curveValue(fit: OlsFit, tvlUsd: number): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(tvlUsd));
}

/** 7-day TVL growth, clamped to the 0.8–1.2 band. No reading: 1.0. */
export function growthFactor(p: Protocol): number {
  if (p.change_7d === null) return 1;
  return Math.min(1.2, Math.max(0.8, 1 + p.change_7d / 100));
}

export function ageDays(p: Protocol, asOf = AS_OF): number | null {
  if (p.listed_at === null) return null;
  const listed = Date.parse(p.listed_at + "T00:00:00Z");
  const ref = Date.parse(asOf + "T00:00:00Z");
  return Math.round((ref - listed) / 86400000);
}

/** Listing-age haircut: at most 15% off, reached only after five years. */
export function ageFactor(p: Protocol, asOf = AS_OF): number {
  const days = ageDays(p, asOf);
  if (days === null) return 1;
  const years = days / 365.25;
  return Math.max(0.85, 1 - (0.15 * Math.log(1 + years)) / Math.log(6));
}

/** How strongly each adjustment enters the price: 1 = full strength,
 *  0.5 = half the deviation from 1, 0 = dropped. Decided by validate()
 *  from the two held-out tests, never set by hand. */
export type AppliedTerms = { growth: number; age: number };
export const FULL_TERMS: AppliedTerms = { growth: 1, age: 1 };

export function applyStrength(factor: number, strength: number): number {
  return 1 + (factor - 1) * strength;
}

export function impliedValue(
  p: Protocol,
  fit: OlsFit,
  applied: AppliedTerms = FULL_TERMS,
  asOf = AS_OF,
): number {
  const raw =
    curveValue(fit, p.tvl_usd) *
    applyStrength(growthFactor(p), applied.growth) *
    applyStrength(ageFactor(p, asOf), applied.age);
  const cap = 10 * p.tvl_usd;
  return Math.round(Math.min(raw, cap));
}

const VERSION_RE = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_RE = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_RE = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

export type SetAsideReason =
  | "category"
  | "versioned"
  | "wrapped"
  | "exchange";

/** Protocols that are not ranked, with the reason each one is out. A
 *  protocol can only be ranked if it has no token yet and no listed parent
 *  already carries the token. */
export function setAside(
  protocols: Protocol[],
): { protocol: Protocol; reason: SetAsideReason; detail: string }[] {
  const out: { protocol: Protocol; reason: SetAsideReason; detail: string }[] = [];
  const familyCategories = new Set([
    "CEX",
    "Liquid Staking",
    "Bridge",
    "Canonical Bridge",
    "Liquid Restaking",
    "Restaked BTC",
  ]);
  for (const p of protocols) {
    if (p.symbol !== null) continue; // already has a token
    if (p.category !== null && familyCategories.has(p.category)) {
      out.push({ protocol: p, reason: "category", detail: p.category });
    } else if (VERSION_RE.test(p.name)) {
      out.push({ protocol: p, reason: "versioned", detail: "versioned name" });
    } else if (WRAPPED_RE.test(p.name)) {
      out.push({ protocol: p, reason: "wrapped", detail: "wrapped or staked name" });
    } else if (EXCHANGE_RE.test(p.name)) {
      out.push({ protocol: p, reason: "exchange", detail: "exchange name" });
    }
  }
  return out;
}

export function boardProtocols(protocols: Protocol[]): Protocol[] {
  const aside = new Set(setAside(protocols).map((s) => s.protocol.slug));
  return protocols.filter((p) => p.symbol === null && !aside.has(p.slug));
}

export function buildBoard(
  protocols: Protocol[],
  fit: OlsFit,
  applied: AppliedTerms = FULL_TERMS,
): { rows: { protocol: Protocol; implied: number }[] } {
  const rows = boardProtocols(protocols)
    .map((p) => ({ protocol: p, implied: impliedValue(p, fit, applied) }))
    .sort((a, b) => b.implied - a.implied || (a.protocol.slug < b.protocol.slug ? -1 : 1));
  return { rows };
}

// ---------------------------------------------------------------------------
// Token odds: what share of the protocols listed at least N years ago
// (whole calendar years, 365 days a year, cut at ODDS_AS_OF) have a token
// today. Display only — a base rate for the field, never a forecast for
// one protocol.
// ---------------------------------------------------------------------------

export type OddsCohort = { years: number; listed: number; tokened: number; pct: number };

export function tokenOdds(protocols: Protocol[]): OddsCohort[] {
  const ref = Date.parse(ODDS_AS_OF + "T00:00:00Z");
  const out: OddsCohort[] = [];
  for (const years of [1, 2, 3]) {
    const cutoff = ref - years * 365 * 86400000;
    let listed = 0;
    let tokened = 0;
    for (const p of protocols) {
      if (p.listed_at === null) continue;
      if (Date.parse(p.listed_at + "T00:00:00Z") > cutoff) continue;
      listed++;
      if (p.symbol !== null) tokened++;
    }
    out.push({ years, listed, tokened, pct: (100 * tokened) / listed });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fitted token odds: a logistic model on the peers' record, not a raw
// cohort rate. Outcome = has a token today (1) or not (0); features =
// log10 TVL, listing age in years, 7-day TVL change. The outcome is
// censored — a pre-token protocol counts as 0 even though it may launch
// later — so the fitted odds are a lower bound on eventual launch odds,
// and the Method tab says so. The model is scored with a Brier score on
// two held-out splits (a time split and 5-fold), against the dumb
// baseline of predicting the overall token rate for every row.
// ---------------------------------------------------------------------------

export type OddsModel = {
  intercept: number;
  coef: [number, number, number]; // log10 TVL, age years, 7d change (fraction)
  medianAgeYears: number;
  n: number;
  tokenRate: number;
  brierTimeSplit: number;
  brierTimeSplitBaseline: number;
  brierKFold: number;
  brierKFoldBaseline: number;
  timeSplitTrain: number;
  timeSplitTest: number;
};

function oddsFeatures(p: Protocol, medianAgeYears: number): [number, number, number] {
  const days = ageDays(p, ODDS_AS_OF);
  const ageYears = days === null ? medianAgeYears : days / 365.25;
  return [Math.log10(p.tvl_usd), ageYears, (p.change_7d ?? 0) / 100];
}

function brierScore(preds: number[], actuals: number[]): number {
  let s = 0;
  for (let i = 0; i < preds.length; i++) s += (preds[i] - actuals[i]) ** 2;
  return s / preds.length;
}

export function fitLogit(
  rows: [number, number, number][],
  y: number[],
  iters = 20000,
  lr = 0.1,
  l2 = 0.001,
): { intercept: number; coef: [number, number, number] } {
  const n = rows.length;
  const mean = [0, 0, 0] as [number, number, number];
  const sd = [1, 1, 1] as [number, number, number];
  for (let j = 0; j < 3; j++) {
    mean[j] = rows.reduce((a, r) => a + r[j], 0) / n;
    const v = rows.reduce((a, r) => a + (r[j] - mean[j]) ** 2, 0) / n;
    sd[j] = Math.sqrt(v) || 1;
  }
  const xs = rows.map((r) => [0, 1, 2].map((j) => (r[j] - mean[j]) / sd[j]));
  const baseRate = y.reduce((a, b) => a + b, 0) / n;
  let b = Math.log(baseRate / (1 - baseRate));
  let w = [0, 0, 0];
  for (let it = 0; it < iters; it++) {
    const gw = [0, 0, 0];
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Math.max(-30, Math.min(30, b + w[0] * xs[i][0] + w[1] * xs[i][1] + w[2] * xs[i][2]));
      const pr = 1 / (1 + Math.exp(-z));
      const err = pr - y[i];
      gb += err;
      for (let j = 0; j < 3; j++) gw[j] += err * xs[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < 3; j++) w[j] -= (lr * (gw[j] / n + l2 * w[j]));
  }
  // Un-standardise: coef on the raw features, intercept folded back in.
  const coef = [0, 1, 2].map((j) => w[j] / sd[j]) as [number, number, number];
  const intercept = b - (w[0] * mean[0]) / sd[0] - (w[1] * mean[1]) / sd[1] - (w[2] * mean[2]) / sd[2];
  return { intercept, coef };
}

function predictLogit(
  x: [number, number, number],
  intercept: number,
  coef: [number, number, number],
): number {
  const z = Math.max(-30, Math.min(30, intercept + coef[0] * x[0] + coef[1] * x[1] + coef[2] * x[2]));
  return 1 / (1 + Math.exp(-z));
}

export function fitTokenOdds(protocols: Protocol[]): OddsModel {
  const dated = protocols.filter((p) => p.listed_at !== null && p.tvl_usd > 0);
  const ages = dated.map((p) => (ageDays(p, ODDS_AS_OF) as number) / 365.25).sort((a, b) => a - b);
  const medianAgeYears = ages[ages.length >> 1];
  const feats = dated.map((p) => oddsFeatures(p, medianAgeYears));
  const y = dated.map((p) => (p.symbol !== null ? 1 : 0));
  const tokenRate = y.reduce((a, b) => a + b, 0) / y.length;

  // Time split: train on listings before 2024-02-18 (the blind-split
  // cutoff), test on the rest.
  const cutoff = Date.parse("2024-02-18T00:00:00Z");
  const trainIdx = dated.map((p, i) => (Date.parse(p.listed_at + "T00:00:00Z") < cutoff ? i : -1)).filter((i) => i >= 0);
  const testIdx = dated.map((p, i) => (Date.parse(p.listed_at + "T00:00:00Z") >= cutoff ? i : -1)).filter((i) => i >= 0);
  const tsFit = fitLogit(trainIdx.map((i) => feats[i]), trainIdx.map((i) => y[i]));
  const tsPreds = testIdx.map((i) => predictLogit(feats[i], tsFit.intercept, tsFit.coef));
  const tsActuals = testIdx.map((i) => y[i]);
  const tsRate = trainIdx.reduce((a, i) => a + y[i], 0) / trainIdx.length;
  const brierTimeSplit = brierScore(tsPreds, tsActuals);
  const brierTimeSplitBaseline = brierScore(tsActuals.map(() => tsRate), tsActuals);

  // 5-fold, deterministic folds by slug order.
  const order = [...dated.keys()].sort((a, b) => (dated[a].slug < dated[b].slug ? -1 : 1));
  const kfPreds: number[] = new Array(dated.length).fill(0);
  for (let f = 0; f < 5; f++) {
    const testF = order.filter((_, k) => k % 5 === f);
    const trainF = order.filter((_, k) => k % 5 !== f);
    const fit = fitLogit(trainF.map((i) => feats[i]), trainF.map((i) => y[i]));
    for (const i of testF) kfPreds[i] = predictLogit(feats[i], fit.intercept, fit.coef);
  }
  const brierKFold = brierScore(kfPreds, y);
  const brierKFoldBaseline = brierScore(y.map(() => tokenRate), y);

  // Full fit on every dated protocol, for the per-row odds.
  const full = fitLogit(feats, y);
  return {
    intercept: full.intercept,
    coef: full.coef,
    medianAgeYears,
    n: dated.length,
    tokenRate,
    brierTimeSplit,
    brierTimeSplitBaseline,
    brierKFold,
    brierKFoldBaseline,
    timeSplitTrain: trainIdx.length,
    timeSplitTest: testIdx.length,
  };
}

export function tokenOddsFit(p: Protocol, model: OddsModel): number {
  return predictLogit(oddsFeatures(p, model.medianAgeYears), model.intercept, model.coef);
}

// ---------------------------------------------------------------------------
// Validation. Every figure is a median miss (%), the share of predictions
// within 2x of the real market cap, and the share within 3x.
// ---------------------------------------------------------------------------

export type ValidationScore = { medianMiss: number; in2x: number; in3x: number };

export function scorePredictions(preds: number[], actuals: number[]): ValidationScore {
  const miss = preds.map((pr, i) => Math.abs(pr - actuals[i]) / actuals[i]);
  const sorted = [...miss].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const in2 = preds.filter((pr, i) => pr >= actuals[i] / 2 && pr <= actuals[i] * 2).length;
  const in3 = preds.filter((pr, i) => pr >= actuals[i] / 3 && pr <= actuals[i] * 3).length;
  return {
    medianMiss: 100 * median,
    in2x: (100 * in2) / preds.length,
    in3x: (100 * in3) / preds.length,
  };
}

function medianOf(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type CategoryOffset = {
  category: string;
  n: number;
  medianRatio: number;
  shrunk: number;
};

/** Per-category median of (market cap / curve value), shrunk toward 1 by
 *  n / (n + 4) in log space. Computed here; the board does not use it. */
export function categoryOffsets(comps: Protocol[], fit: OlsFit): CategoryOffset[] {
  const byCat = new Map<string, number[]>();
  for (const p of comps) {
    const cat = p.category ?? "(no category)";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push((p.mcap_usd as number) / curveValue(fit, p.tvl_usd));
  }
  const out: CategoryOffset[] = [];
  for (const [category, ratios] of byCat) {
    const med = medianOf(ratios);
    const n = ratios.length;
    out.push({ category, n, medianRatio: med, shrunk: Math.pow(med, n / (n + 4)) });
  }
  out.sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  return out;
}

function offsetsFrom(
  train: Protocol[],
  fit: OlsFit,
): Map<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of train) {
    const cat = p.category ?? "(no category)";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push((p.mcap_usd as number) / curveValue(fit, p.tvl_usd));
  }
  const out = new Map<string, number>();
  for (const [cat, ratios] of byCat) {
    const med = medianOf(ratios);
    out.set(cat, Math.pow(med, ratios.length / (ratios.length + 4)));
  }
  return out;
}

export type TermDecision = {
  term: "growth" | "age";
  looFull: ValidationScore;
  looShrunk: ValidationScore;
  wfFull: ValidationScore;
  wfShrunk: ValidationScore;
  decision: "KEPT" | "SHRUNK" | "DROPPED";
  strength: number; // 1, 0.5, or 0
  reason: string;
};

export type Validation = {
  looFlat: ValidationScore;
  looCurve: ValidationScore;
  looGrowth: ValidationScore;
  looAge: ValidationScore;
  looFull: ValidationScore;
  looGrowthS: ValidationScore;
  looAgeS: ValidationScore;
  looFullS: ValidationScore;
  looFinal: ValidationScore;
  blind: ValidationScore;
  blindTrain: number;
  blindTest: number;
  blindFinal: ValidationScore;
  wfFolds: { fold: number; medianMiss: number; in2x: number }[];
  wfPooledCurve: ValidationScore;
  wfPooledFull: ValidationScore;
  wfPooledGrowth: ValidationScore;
  wfPooledAge: ValidationScore;
  wfPooledGrowthS: ValidationScore;
  wfPooledAgeS: ValidationScore;
  wfPooledFullS: ValidationScore;
  wfPooledFinal: ValidationScore;
  wfOffsetsShrunk: ValidationScore;
  wfOffsetsFull: ValidationScore;
  wfN: number;
  termDecisions: TermDecision[];
  applied: AppliedTerms;
};

// The decision rule, stated once and applied by the numbers: a term is
// KEPT at full strength only if it improves the two-test average — the
// mean of the leave-one-out score and the walk-forward pooled score — on
// BOTH median miss and within-3x, against the curve alone. If full
// strength fails but half strength (half its deviation from 1) improves
// both averages, it is kept SHRUNK. Otherwise it is DROPPED. The table
// on the dashboard shows every number behind each decision, so the rule
// can be re-checked by hand.
function twoTestAvg(a: ValidationScore, b: ValidationScore): { medianMiss: number; in3x: number } {
  return { medianMiss: (a.medianMiss + b.medianMiss) / 2, in3x: (a.in3x + b.in3x) / 2 };
}

function improvesTwoTest(
  cand: { medianMiss: number; in3x: number },
  base: { medianMiss: number; in3x: number },
): boolean {
  return cand.medianMiss < base.medianMiss && cand.in3x > base.in3x;
}

function decideTerm(
  term: "growth" | "age",
  looCurve: ValidationScore,
  wfCurve: ValidationScore,
  looFull: ValidationScore,
  wfFull: ValidationScore,
  looShrunk: ValidationScore,
  wfShrunk: ValidationScore,
): TermDecision {
  const base = twoTestAvg(looCurve, wfCurve);
  const full = twoTestAvg(looFull, wfFull);
  const shrunk = twoTestAvg(looShrunk, wfShrunk);
  const f = (v: number) => v.toFixed(1);
  if (improvesTwoTest(full, base)) {
    return {
      term, looFull, looShrunk, wfFull, wfShrunk, decision: "KEPT", strength: 1,
      reason: `full strength improves the two-test average to ${f(full.medianMiss)}% median miss / ${f(full.in3x)}% in-3x, from ${f(base.medianMiss)}% / ${f(base.in3x)}% curve-only`,
    };
  }
  if (improvesTwoTest(shrunk, base)) {
    return {
      term, looFull, looShrunk, wfFull, wfShrunk, decision: "SHRUNK", strength: 0.5,
      reason: `full strength fails (two-test average ${f(full.medianMiss)}% / ${f(full.in3x)}% vs curve ${f(base.medianMiss)}% / ${f(base.in3x)}%); half strength improves both to ${f(shrunk.medianMiss)}% / ${f(shrunk.in3x)}%, so it is kept at half its deviation from 1`,
    };
  }
  return {
    term, looFull, looShrunk, wfFull, wfShrunk, decision: "DROPPED", strength: 0,
    reason: `full strength fails (two-test average ${f(full.medianMiss)}% / ${f(full.in3x)}% vs curve ${f(base.medianMiss)}% / ${f(base.in3x)}%) and half strength fails too (${f(shrunk.medianMiss)}% / ${f(shrunk.in3x)}%); dropped`,
  };
}

export function validate(comps: Protocol[]): Validation {
  // One prediction per variant, per held-out protocol. Variants: curve
  // alone, one term at full strength, one term at half strength, both.
  const variantPred = (variant: string, p: Protocol, fit: OlsFit): number => {
    const curve = curveValue(fit, p.tvl_usd);
    const g = growthFactor(p);
    const a = ageFactor(p);
    switch (variant) {
      case "curve": return curve;
      case "growth": return curve * g;
      case "age": return curve * a;
      case "full": return curve * g * a;
      case "growthS": return curve * applyStrength(g, 0.5);
      case "ageS": return curve * applyStrength(a, 0.5);
      case "fullS": return curve * applyStrength(g, 0.5) * applyStrength(a, 0.5);
      default: return curve;
    }
  };
  const variants = ["curve", "growth", "age", "full", "growthS", "ageS", "fullS"];

  // Leave-one-out, seven variants.
  const looPreds: Record<string, number[]> = {};
  for (const v of variants) looPreds[v] = [];
  const actuals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i];
    const rest = comps.filter((_, j) => j !== i);
    const fit = olsFit(rest);
    for (const v of variants) looPreds[v].push(variantPred(v, held, fit));
    actuals.push(held.mcap_usd as number);
  }
  const looFlatPreds = comps.map((held) => {
    const rest = comps.filter((p) => p !== held);
    return held.tvl_usd * medianOf(rest.map((p) => (p.mcap_usd as number) / p.tvl_usd));
  });

  // Blind split: train on protocols listed before 2024-02-18, test the rest.
  const cutoff = Date.parse("2024-02-18T00:00:00Z");
  const dated = comps.filter((p) => p.listed_at !== null);
  const train = dated.filter((p) => Date.parse(p.listed_at + "T00:00:00Z") < cutoff);
  const test = dated.filter((p) => Date.parse(p.listed_at + "T00:00:00Z") >= cutoff);
  const blindFit = olsFit(train);
  const blindPreds = test.map((p) => curveValue(blindFit, p.tvl_usd));
  const blindActuals = test.map((p) => p.mcap_usd as number);

  // Walk-forward: dated comps sorted by listing date, five groups of 19.
  const sorted = [...dated].sort((a, b) => (a.listed_at as string) < (b.listed_at as string) ? -1 : 1);
  const groups: Protocol[][] = [];
  for (let i = 0; i < sorted.length; i += 19) groups.push(sorted.slice(i, i + 19));
  const wfFolds: { fold: number; medianMiss: number; in2x: number }[] = [];
  const wfPreds: Record<string, number[]> = {};
  for (const v of variants) wfPreds[v] = [];
  const pooledOffShrunkPreds: number[] = [];
  const pooledOffFullPreds: number[] = [];
  const pooledActuals: number[] = [];
  for (let k = 2; k <= 4; k++) {
    const trainGroups = groups.slice(0, k).flat();
    const testGroup = groups[k];
    const fit = olsFit(trainGroups);
    const off = offsetsFrom(trainGroups, fit);
    const foldPreds = testGroup.map((p) => curveValue(fit, p.tvl_usd));
    const foldActuals = testGroup.map((p) => p.mcap_usd as number);
    const foldScore = scorePredictions(foldPreds, foldActuals);
    wfFolds.push({ fold: k, medianMiss: foldScore.medianMiss, in2x: foldScore.in2x });
    for (const p of testGroup) {
      const curve = curveValue(fit, p.tvl_usd);
      const o = off.get(p.category ?? "(no category)") ?? 1;
      for (const v of variants) wfPreds[v].push(variantPred(v, p, fit));
      pooledOffShrunkPreds.push(curve * o);
      pooledOffFullPreds.push(curve * growthFactor(p) * ageFactor(p) * o);
      pooledActuals.push(p.mcap_usd as number);
    }
  }

  const looCurve = scorePredictions(looPreds.curve, actuals);
  const looGrowth = scorePredictions(looPreds.growth, actuals);
  const looAge = scorePredictions(looPreds.age, actuals);
  const looFull = scorePredictions(looPreds.full, actuals);
  const looGrowthS = scorePredictions(looPreds.growthS, actuals);
  const looAgeS = scorePredictions(looPreds.ageS, actuals);
  const looFullS = scorePredictions(looPreds.fullS, actuals);
  const wfPooledCurve = scorePredictions(wfPreds.curve, pooledActuals);
  const wfPooledGrowth = scorePredictions(wfPreds.growth, pooledActuals);
  const wfPooledAge = scorePredictions(wfPreds.age, pooledActuals);
  const wfPooledFull = scorePredictions(wfPreds.full, pooledActuals);
  const wfPooledGrowthS = scorePredictions(wfPreds.growthS, pooledActuals);
  const wfPooledAgeS = scorePredictions(wfPreds.ageS, pooledActuals);
  const wfPooledFullS = scorePredictions(wfPreds.fullS, pooledActuals);

  const growthDecision = decideTerm("growth", looCurve, wfPooledCurve, looGrowth, wfPooledGrowth, looGrowthS, wfPooledGrowthS);
  const ageDecision = decideTerm("age", looCurve, wfPooledCurve, looAge, wfPooledAge, looAgeS, wfPooledAgeS);
  const applied: AppliedTerms = { growth: growthDecision.strength, age: ageDecision.strength };

  // Final model, scored again with the decided strengths: leave-one-out,
  // walk-forward pooled, and the blind split.
  const looFinalPreds: number[] = [];
  const wfFinalPreds: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i];
    const rest = comps.filter((_, j) => j !== i);
    const fit = olsFit(rest);
    const curve = curveValue(fit, held.tvl_usd);
    looFinalPreds.push(
      curve * applyStrength(growthFactor(held), applied.growth) * applyStrength(ageFactor(held), applied.age),
    );
  }
  for (let k = 2; k <= 4; k++) {
    const trainGroups = groups.slice(0, k).flat();
    const testGroup = groups[k];
    const fit = olsFit(trainGroups);
    for (const p of testGroup) {
      const curve = curveValue(fit, p.tvl_usd);
      wfFinalPreds.push(
        curve * applyStrength(growthFactor(p), applied.growth) * applyStrength(ageFactor(p), applied.age),
      );
    }
  }
  const blindFinalPreds = test.map((p) => {
    const curve = curveValue(blindFit, p.tvl_usd);
    return curve * applyStrength(growthFactor(p), applied.growth) * applyStrength(ageFactor(p), applied.age);
  });

  return {
    looFlat: scorePredictions(looFlatPreds, actuals),
    looCurve,
    looGrowth,
    looAge,
    looFull,
    looGrowthS,
    looAgeS,
    looFullS,
    looFinal: scorePredictions(looFinalPreds, actuals),
    blind: scorePredictions(blindPreds, blindActuals),
    blindTrain: train.length,
    blindTest: test.length,
    blindFinal: scorePredictions(blindFinalPreds, blindActuals),
    wfFolds,
    wfPooledCurve,
    wfPooledFull,
    wfPooledGrowth,
    wfPooledAge,
    wfPooledGrowthS,
    wfPooledAgeS,
    wfPooledFullS,
    wfPooledFinal: scorePredictions(wfFinalPreds, pooledActuals),
    wfOffsetsShrunk: scorePredictions(pooledOffShrunkPreds, pooledActuals),
    wfOffsetsFull: scorePredictions(pooledOffFullPreds, pooledActuals),
    wfN: pooledActuals.length,
    termDecisions: [growthDecision, ageDecision],
    applied,
  };
}

/** The eight nearest traded comparables for a board row: the closest one in
 *  its own category first (when one exists), then the seven closest by
 *  |log10 TVL − log10 row TVL|. */
export type NearestComp = {
  slug: string;
  name: string;
  category: string | null;
  tvlUsd: number;
  mcapUsd: number;
  multiple: number;
  curveSays: number;
  sameCategory: boolean;
};

export function nearestComps(
  row: Protocol,
  comps: Protocol[],
  fit: OlsFit,
): NearestComp[] {
  const byDistance = [...comps].sort(
    (a, b) =>
      Math.abs(Math.log10(a.tvl_usd) - Math.log10(row.tvl_usd)) -
      Math.abs(Math.log10(b.tvl_usd) - Math.log10(row.tvl_usd)),
  );
  const out: NearestComp[] = [];
  const sameCat = byDistance.filter((p) => p.category === row.category);
  if (sameCat.length > 0) {
    const p = sameCat[0];
    out.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvlUsd: p.tvl_usd,
      mcapUsd: p.mcap_usd as number,
      multiple: (p.mcap_usd as number) / p.tvl_usd,
      curveSays: curveValue(fit, p.tvl_usd),
      sameCategory: true,
    });
  }
  for (const p of byDistance) {
    if (out.length >= 8) break;
    if (out.some((o) => o.slug === p.slug)) continue;
    out.push({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvlUsd: p.tvl_usd,
      mcapUsd: p.mcap_usd as number,
      multiple: (p.mcap_usd as number) / p.tvl_usd,
      curveSays: curveValue(fit, p.tvl_usd),
      sameCategory: false,
    });
  }
  return out;
}
