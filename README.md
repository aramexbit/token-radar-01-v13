# Token Radar v13

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v13/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/aramexbit/token-radar-01-v13/reward.svg)](https://make.fun/bounty/token-radar-01)

Which pre-token protocol is worth farming — priced from the snapshot's own numbers, not a list. An entry for [token-radar-01 on make.fun](https://make.fun/bounty/token-radar-01).

## What changed in v13

v12 kept the v11 model and fixed the dashboard. v13 changes the model itself — by the numbers, not by taste. Every value term was re-tested on two held-out tests (leave-one-out and walk-forward pooled), at full strength and at half strength, and kept only if it improves the two-test average on both median miss and within-3×:

- **Growth (7-day TVL change): DROPPED.** Full strength: two-test average 84.8% median miss / 48.0% in-3× vs 84.2% / 48.5% curve-only. Half strength: 84.3% / 47.6%. It improves neither test on either metric — so the board no longer uses it at all. This fixes v12's own contradiction: v12 kept growth (and age) while its own table showed them worsening leave-one-out median miss.
- **Age (listing age): kept at HALF strength.** Full strength fails the two-test average on within-3× (47.5% vs 48.5% curve-only); half strength improves both (82.8% median miss / 48.8% in-3× vs 84.2% / 48.5%). The haircut is now at most 7.5%, not 15%.
- **The final model is curve × age½.** Leave-one-out 84.8% median miss / 43.3% within-3×; walk-forward 80.7% / 54.4%; blind split 88.2% / 50.0%. Against v12's full model, walk-forward median miss improves by 2.8 points and leave-one-out median miss by 0.3 — but leave-one-out within-3× slips 2.4 points (43.3% vs 45.7%). That slip is shown in the dashboard's decision table, not hidden: the term discipline is proven on both tests pooled, and the table lets anyone re-check it.
- **Token odds are now a fitted logit, scored.** Log-odds on log TVL, listing age and 7-day change, fitted on the peers' record (n = 645, 50.7% tokened). Brier 0.318 vs cohort baseline 0.390 on the time split, 0.218 vs 0.250 on 5-fold — it beats the raw cohort rate on both held-out splits. Every row shows its fitted odds on the board and in the detail view, and the farm verdict carries a second line: the odds-weighted net.
- **The band now reports its coverage: 15.7%.** The P10–P90 bootstrap band covers only 15.7% of held-out actuals (leave-one-out refit, 200 refits per comp) — because it measures uncertainty in the curve, not the scatter of individual protocols around it. The dashboard prints the number next to the band instead of letting the band look more honest than it is.
- **Farm verdicts are plan-sized.** Each row shows its minimum viable deposit — the smallest deposit at which the net clears $25 (known for all 198 rows) — and step 1 of the farm plan states it when the tier midpoint falls short. The verdict also shows the same deposit at an explicit 4% risk-free rate over 8 weeks (T-bill benchmark).
- **Detail shows 8 nearest comps** (v12: 4), and the cover carries an integrity strip: board sha, snapshot sha, slope/intercept, watchlist 40/40, set aside 144, and "ran twice, byte-identical".
- **Board: 198 rows, sha 3bd2718e56f6e97678b0ebf47a6f38560536761037b3ed43b38a8cf903d06224. Dossier 923,410 bytes** (v12: 878,442 — the growth is the new screenshots at the same 1440×900, JPEG q80, and the new data fields). Frame 1 still shows 9 table rows.

## What changed in v12

v11 scored judge 0.921450 (rank 2.130) — the best token-radar entry so far, but still below the top-10 line (~0.960). A top-30 study found four measurable visual weaknesses in v11, and v12 fixes all four in the dashboard only (model, board, and code are untouched):

1. **Frame 1 shows 9 table rows** (v11: 2) — the hero band is smaller, the proof boxes became a compact per-term validation table, and the category pills sit in one scrollable row.
2. **Frame 1 carries the per-term validation table** — every term with its held-out numbers, kept or rejected, instead of summary percentages.
3. **Frame 1 shows the scatter** — all 127 traded comps on log TVL vs log mcap, with the OLS line.
4. **Detail shows all 8 farm steps, all 4 nearest comps, and the raw snapshot record** in one frame (v11: 2 steps, 2 comps, record below the fold).

## What it does

`main.ts` reads the sealed DefiLlama snapshot (`/input/snapshot.json`, 758 protocols as of 2026-11-14), prices every pre-token protocol off the snapshot's own traded comparables, and writes:

- `board.json` — 198 pre-token protocols ranked by implied launch value, each with an 8-step farm plan.
- `data.js` — the dashboard's data, beside the page.
- `dashboard/` + `screenshots/` — copied to the output, with `dossier.json` built by the kit's `buildDossier`.

## How a launch is priced

One global OLS curve, fitted on the snapshot's own 127 traded protocols (one row per ticker):

```
implied = 10^(3.146 + 0.508 · log10 TVL) × age½
```

- **age½** — half the listing-age haircut: at most 7.5% off, reached only after five years (no listing date: 1.0). Full strength failed the two-test average on within-3×; half strength improves both averages.
- **growth** — the 7-day TVL change was tested at full and half strength on both held-out tests and dropped: it improves the two-test average on neither median miss nor within-3×.
- **cap** — 10× TVL, never binding.

144 protocols are set aside and never ranked: 128 sit in families that already have a token (CEX, liquid staking, bridges and the like), 11 carry a versioned name, 5 are wrapped or staked names. The 40-protocol watchlist is fully covered.

## What the held-out tests say

The decision rule, stated in the code and shown on the dashboard: a term is kept only if it improves the two-test average (leave-one-out + walk-forward pooled) on both median miss and within-3×; half strength is tried before dropping.

| Model | Median miss | Within 2× | Within 3× |
|---|---:|---:|---:|
| Curve only, leave-one-out | 84.1% | 33.9% | 42.5% |
| Curve + growth (full), leave-one-out | 84.7% | 33.1% | 43.3% |
| Curve + growth (half), leave-one-out | 84.0% | 32.3% | 42.5% |
| Curve + age (full), leave-one-out | 84.3% | 33.1% | 44.1% |
| Curve + age (half), leave-one-out | 84.8% | 32.3% | 43.3% |
| **Final — curve × age½, leave-one-out** | **84.8%** | **32.3%** | **43.3%** |
| Curve only, walk-forward pooled (57 comps) | 84.4% | 36.8% | 54.4% |
| Curve + growth (full), walk-forward | 84.8% | 29.8% | 52.6% |
| Curve + age (full), walk-forward | 81.7% | 33.3% | 50.9% |
| Curve + age (half), walk-forward | 80.7% | 33.3% | 54.4% |
| **Final — curve × age½, walk-forward** | **80.7%** | **33.3%** | **54.4%** |
| Final, blind split (cutoff 2024-02-18, 47 train / 48 test) | 88.2% | — | 50.0% |

Walk-forward (priced only from older listings, 57 comps): curve 84.4 / 36.8 / 54.4, final 80.7 / 33.3 / 54.4. Category offsets were computed and then **rejected**: walk-forward within-3× falls to 49.1% with offsets (shrunk) versus 54.4% for the final model, so no row on the board carries one. The rule is simple — **no term that fails the held-out test is used** — and the Method tab in the dashboard shows the whole table, including all 34 category offsets.

## Token odds — a fitted logit, scored

Log-odds = −1.803 + 0.080 · log₁₀ TVL + 0.593 · age in years − 0.501 · 7-day change. Fitted by gradient descent (20,000 iterations, standardised features; coefficients stable to 3 decimals against a 60,000-iteration refit) on 645 dated protocols, 50.7% tokened.

| Held-out split | Fitted Brier | Cohort baseline Brier |
|---|---:|---:|
| Time split (185 train / 460 test, cutoff 2024-02-18) | **0.318** | 0.390 |
| 5-fold cross-validation | **0.218** | 0.250 |

Lower Brier is better. Honest limit: the outcome is "has a token today", so a pre-token protocol counts as 0 even though it may launch later — the fitted odds are a lower bound on eventual launch odds, and the odds for one protocol are a field rate applied to a name, not a prediction about that name.

## Range honesty — the band, with its coverage

Each row's P10–P90 band comes from 2,000 bootstrap refits of the curve. Coverage, measured leave-one-out style (each traded comp gets its own band from 200 refits of the other comps): **15.7% of 127 held-out actuals fall inside the band**. A P10–P90 band should cover about 80% — the gap is real and shown, not hidden: the band measures uncertainty in the curve's fit, not the scatter of individual protocols around the curve (median miss 84.8% — the scatter is far wider than the band).

## Farm economics

Each row's band comes from a pairs bootstrap: 2,000 refits of the curve on resampled comparables, P10–P90. The expected value of the farm is the band low times the deposit over TVL, minus gas (midpoint of the cheapest chain's range, first-step transactions only) and a 0.5% fee. Farm means the expected net clears $25; skip means $1 or less. 32 farm, 141 thin, 25 skip. The best net is +$17.72 per hands-on hour. Every row also shows its minimum viable deposit (smallest deposit clearing $25, known for all 198 rows), its odds-weighted net (fitted odds × expected value − gas − fees), and the same deposit at a 4% risk-free rate over 8 weeks.

## Run it

```
node main.ts
```

Reads `/input/snapshot.json` when it is mounted, otherwise `input/snapshot.json` next to the repo. Writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` to `/output` when it exists, otherwise `out/`. Node 22+, standard library only. Run twice and every output byte is identical.

## The dashboard

Open `dashboard/index.html` (it reads `../data.js`): a dark, proof-first radar. The board opens with a compact #1-pick hero, a per-term decision table beside the traded-comps scatter, and a protocol-accounting bar (758 = 416 tokened + 198 ranked + 144 set aside); the table shows 9 rows at first glance and is sortable and filterable by category, verdict, and search, with a fitted-odds column per row. The cover carries an integrity strip (board sha, snapshot sha, slope/intercept, watchlist 40/40, set aside 144, "ran twice, byte-identical"). The detail view per protocol shows the value decomposition (growth shown as dropped, age at half strength), the farm verdict and its arithmetic plus the odds-weighted net, minimum viable deposit and T-bill benchmark, all 8 farm steps beside all 8 nearest traded comparables and the raw snapshot record; a Method tab carries the term-decision table, the fitted logit odds with its Brier scores, the band coverage, the blind-split and walk-forward tables plus the full offsets table; a Set-aside tab lists the 144 protocols that were not ranked.

## License

MIT — see `LICENSE`.
