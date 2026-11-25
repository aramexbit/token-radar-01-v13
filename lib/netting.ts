// Token Radar — bootstrap bands and farm economics.
//
// The curve is refit 2,000 times on resampled comparables (pairs
// bootstrap, fixed seed). Each board row gets a P10–P90 band from those
// refits. The farm economics are then plain arithmetic on the band's low
// end: the expected value of the farm is the low-end launch value times
// the deposit over TVL, minus gas and fees. A row is worth farming only
// when that expected net clears $25; at $1 or less it is a skip. Two
// more numbers ride along: the smallest deposit at which the farm clears
// $25 (the minimum viable capital for the plan), and what the same
// deposit would earn at an explicit 4% risk-free rate over the 8 weeks,
// so a farm verdict can be read against doing nothing.

import {
  ageFactor,
  applyStrength,
  curveValue,
  growthFactor,
  type AppliedTerms,
  type OlsFit,
  type Protocol,
} from "./model.ts";
import { depositMidpoint, firstStepTx, gasPerTx } from "./plan.ts";

export type Verdict = "farm" | "thin" | "skip";

export type RowEconomics = {
  bandLow: number;
  bandHigh: number;
  deposit: number;
  gas: number;
  gasTx: number;
  fees: number;
  expected: number;
  net: number;
  netPerHour: number;
  breakEven: number;
  rankLow: number;
  rankHigh: number;
  verdict: Verdict;
  minViableDeposit: number | null;
  tbill: number;
  oddsNet: number;
  oddsNetPerHour: number;
};

export const TBILL_RATE = 0.04; // explicit assumption: 4% risk-free, 8 weeks
export const FARM_BAR_USD = 25;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Nearest-rank quantile: index round(q × (n − 1)) on the sorted values. */
export function quantile(sorted: number[], q: number): number {
  const idx = Math.round(q * (sorted.length - 1));
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export function bootstrapBands(
  rows: { protocol: Protocol; implied: number }[],
  comps: Protocol[],
  fit: OlsFit,
  applied: AppliedTerms = { growth: 1, age: 1 },
  refits = 2000,
  seed = 2,
): { bandLow: number; bandHigh: number }[] {
  const xs0 = comps.map((p) => Math.log10(p.tvl_usd));
  const ys0 = comps.map((p) => Math.log10(p.mcap_usd as number));
  const n = comps.length;
  const rng = mulberry32(seed);
  const boot = rows.map(() => new Float64Array(refits));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let b = 0; b < refits; b++) {
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      xs[i] = xs0[j];
      ys[i] = ys0[j];
    }
    const refit = olsFitFromXY(xs, ys);
    for (let k = 0; k < rows.length; k++) {
      const p = rows[k].protocol;
      let v =
        curveValue(refit, p.tvl_usd) *
        applyStrength(growthFactor(p), applied.growth) *
        applyStrength(ageFactor(p), applied.age);
      const cap = 10 * p.tvl_usd;
      if (v > cap) v = cap;
      boot[k][b] = v;
    }
  }
  return boot.map((arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return { bandLow: quantile(sorted, 0.1), bandHigh: quantile(sorted, 0.9) };
  });
}

/** Empirical coverage of the P10–P90 band, leave-one-out style: for each
 *  traded comp, refit the curve on the other comps, build that comp's own
 *  band from 200 bootstrap refits of the rest, and ask whether the real
 *  market cap falls inside it. A band without this number is decoration —
 *  the dashboard prints the coverage next to the band. */
export function bandCoverage(
  comps: Protocol[],
  fit: OlsFit,
  applied: AppliedTerms = { growth: 1, age: 1 },
  refits = 200,
  seed = 7,
): { coverage: number; n: number; refits: number } {
  let inside = 0;
  for (let i = 0; i < comps.length; i++) {
    const held = comps[i];
    const rest = comps.filter((_, j) => j !== i);
    const xs0 = rest.map((p) => Math.log10(p.tvl_usd));
    const ys0 = rest.map((p) => Math.log10(p.mcap_usd as number));
    const n = rest.length;
    const rng = mulberry32(seed + i);
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const vals = new Float64Array(refits);
    for (let b = 0; b < refits; b++) {
      for (let k = 0; k < n; k++) {
        const j = Math.floor(rng() * n);
        xs[k] = xs0[j];
        ys[k] = ys0[j];
      }
      const refit = olsFitFromXY(xs, ys);
      let v =
        curveValue(refit, held.tvl_usd) *
        applyStrength(growthFactor(held), applied.growth) *
        applyStrength(ageFactor(held), applied.age);
      const cap = 10 * held.tvl_usd;
      if (v > cap) v = cap;
      vals[b] = v;
    }
    const sorted = [...vals].sort((a, b) => a - b);
    const low = quantile(sorted, 0.1);
    const high = quantile(sorted, 0.9);
    if ((held.mcap_usd as number) >= low && (held.mcap_usd as number) <= high) inside++;
  }
  return { coverage: (100 * inside) / comps.length, n: comps.length, refits };
}

function olsFitFromXY(xs: Float64Array, ys: Float64Array): OlsFit {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: (sxy * sxy) / (sxx * syy), n };
}

export function rowEconomics(
  row: { protocol: Protocol; implied: number },
  band: { bandLow: number; bandHigh: number },
  allImpliedDesc: number[],
  oddsFit = 0,
): RowEconomics {
  const p = row.protocol;
  const deposit = depositMidpoint(p);
  const gasTx = firstStepTx(p);
  const gas = gasTx * gasPerTx(p);
  const fees = 0.005 * deposit;
  const expected = (band.bandLow * deposit) / p.tvl_usd;
  const net = expected - gas - fees;
  const netPerHour = net / 2.0;
  const breakEven = ((gas + fees) * p.tvl_usd * row.implied) / (deposit * band.bandLow);
  // Smallest deposit at which the farm clears the $25 bar, from the band
  // low: D * (bandLow/TVL − 0.5%) ≥ 25 + gas. Null when the band low is
  // too thin for any deposit to clear the bar.
  const slope = band.bandLow / p.tvl_usd - 0.005;
  const minViableDeposit = slope > 0 ? Math.ceil((FARM_BAR_USD + gas) / slope) : null;
  // What the same deposit earns doing nothing, at an explicit 4%
  // risk-free rate over the 8-week plan.
  const tbill = deposit * TBILL_RATE * (8 / 52);
  // Odds-weighted net: the same arithmetic, but the launch value only
  // counts at the fitted odds of a launch happening at all.
  const oddsNet = oddsFit * expected - gas - fees;
  const oddsNetPerHour = oddsNet / 2.0;
  const rankOf = (v: number): number => {
    let r = 1;
    for (const x of allImpliedDesc) {
      if (x > v) r++;
      else break;
    }
    return r;
  };
  const verdict: Verdict = net >= 25 ? "farm" : net <= 1 ? "skip" : "thin";
  return {
    bandLow: band.bandLow,
    bandHigh: band.bandHigh,
    deposit,
    gas,
    gasTx,
    fees,
    expected,
    net,
    netPerHour,
    breakEven,
    rankLow: rankOf(band.bandHigh),
    rankHigh: rankOf(band.bandLow),
    verdict,
    minViableDeposit,
    tbill,
    oddsNet,
    oddsNetPerHour,
  };
}
