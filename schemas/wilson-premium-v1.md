# wilson-premium-v1

Frozen curve. Any change is v2 with new vectors.

## Inputs

- `k`: delivered jobs. Completed and paid.
- `n`: graded jobs. Delivered plus undelivered (delivered then rejected, proven cheated, or paid and never delivered).
- `P`: the price, an integer in the token's smallest unit.

## Pinned z

`z = 1.959963984540054`. This is the two-sided 95% normal quantile to 16 digits, and the constant the Taifoon layer uses. It is not `1.96`.

## Interval

The Wilson score interval, no continuity correction, for `x` successes of `n`:

```
p = x / n
d = 1 + z²/n
c = p + z²/(2n)
s = z · sqrt((p(1 − p) + z²/(4n)) / n)
interval = [max(0, (c − s)/d), min(1, (c + s)/d)]      n = 0 gives [0, 1]
```

The operations run in this order in both `src/wilson.ts` and `python/taifoon_jev_wilson/wilson.py`.

## Bounds

- `p_L = wilson(k, n)[0]`: the lower bound on the delivered rate.
- `u_F = wilson(n − k, n)[1]`: the upper bound on the failure rate.

In real arithmetic `u_F = 1 − p_L`. In doubles the two differ in the last bits for about 60% of records with `n ≤ 300` (27,320 of 45,450). The premium uses `u_F`, as the layer does.

## Premium

```
ratio  = u_F                                   (k ≥ 1)
π      = floor(P × round(ratio × 10⁶) / 10⁶)   (round = JavaScript Math.round, ties up)
cover  = ratio ≤ 0.30
```

- `k = 0` is UNKNOWN. There is no delivered job to price from, so the seller is not insurable. This includes `0/0`.
- Above 0.30 the premium is still computed, but no pool covers the job. The layer offers deposit-only terms.
- Optional `min` floors the ratio. The layer uses none (`min = 0`).

## Cheat

Cheat is a separate flag. A Jev `cheat_shaped` answer at or above 0.5 (THRESHOLDS_v1) escalates a grade to review. It never enters `p_L`, `u_F` or `π`. A cheat that is proven on chain is an undelivered job, so it counts in `n − k`.

## Where the plan and the layer differ

| Point | Plan | Layer (followed here) |
|---|---|---|
| z | 1.96 | 1.959963984540054 |
| Bound that prices | Wilson lower on delivered, `1 − p_L` | Wilson upper on failed, `u_F` |
| Rounding | not stated | ratio to 10⁻⁶ with Math.round, then floor on the integer price |
| `0/0` | a row in the table | UNKNOWN, not insurable |
| `{min, max}` | a range for π | `max` is the 0.30 cover rule; `min` is an optional floor |

Effect of z on the 9/10 row at P = 100,000,000 (100 USDC): the layer gives π = 40,415,000; z = 1.96 gives 40,415,600.

## Solidity

`solidity/src/WilsonPremium.sol` computes the same curve in integers, multiplied through by n:
`u_F = (x + z²/2 + z·sqrt(x(n − x)/n + z²/4)) / (n + z²)` with x = n − k, at scale 1e30 with z = 1959963984540054·10⁻¹⁵
and z² exact. Then `ratioE6 = round(u_F·10⁶)` (ties up), `π = floor(P·ratioE6/10⁶)`, `cover = u_F ≤ 0.30` compared exactly.
`k = 0` reverts `WilsonUnknown()` (`quote` returns insurable = false). On every row of `tests/vectors/premium-grid.json`
it equals the TypeScript: π, ratioE6 and cover, difference 0. The closest record with n ≤ 300 lies 2.6·10⁻¹¹ (relative)
from a rounding tie, far above both the doubles' error and the fixed point's.
