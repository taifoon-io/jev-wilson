"""jev-wilson/economy: every number of one assured job, from the seller's record (the twin of src/economy.ts).

Same units as the TypeScript and the Solidity library on tests/vectors/economy-grid.json. See src/economy.ts for the
derivation of each line.

  r            = js_round(u_F * 1e6)            u_F = wilson_upper_failure(k, n); 1e6 when k = 0
  W            = floor(P * r / 1e6)             premium_amount
  L            = lp_premium_units(P, record, T, arb, m): lp_premium's formula in integers (1e-27 floors, rounded up)
  priced       = max(W, L + F)
  covered      = k > 0 and L > 0 and priced * 1e6 <= P * maxRatioE6
  premium      = priced if covered else 0;  to_backers = L;  to_layer = premium - L  (>= F)
  cover_cap    = floor(P * m / 10_000)
  compensation = min(priced, P)
  deposit      = P + max(compensation, ceil(cover_cap * r / 1e6))
"""
import math
from decimal import Decimal
from typing import Optional

from .lp import LP_DEFAULTS
from .wilson import RATIO_SCALE, js_round, premium_amount, wilson_upper_failure

ECONOMY_VERSION = "jev-wilson.economy.v1"
YEAR_S = 31_536_000
MAX_PRICE_UNITS = 10 ** 30
WAD = 10 ** 18
R = 10 ** 27


def wad(x) -> int:
    """A calibration decimal as the exact WAD integer of its shortest decimal form (0.1666 -> 166600000000000000)."""
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x < 0:
        raise ValueError(f"wad: {x}")
    d = Decimal(repr(x)) * WAD
    if d != d.to_integral_value():
        raise ValueError(f"wad: more than 18 decimals {x}")
    return int(d)


def lp_premium_units(price: int, record: Optional[dict], lock_seconds: int, arbitrator: bool,
                     cover_multiple_bps: int = 10_000, params: Optional[dict] = None) -> int:
    """lp_premium computed exactly (the twin of src/economy.ts lpPremiumUnits and EconomyQuote.lpPremium)."""
    p = {**LP_DEFAULTS, **(params or {})}
    if not (0 < p["utilization"] <= 1) or p["severity"] > 1 or p["a0"] + p["b0"] <= 0:
        raise ValueError("lp params out of range")
    ops = p["opsUnits"]
    if isinstance(ops, float) and ops.is_integer():
        ops = int(ops)
    _int(ops, "opsUnits")
    f = record["incorrect"] if record else 0
    k = record["correct"] if record else 0
    pm = price * cover_multiple_bps
    total = 0
    if arbitrator:
        w = wad(p["a0"]) + wad(p["b0"]) + (k + f) * WAD
        mean_r = (wad(p["a0"]) + f * WAD) * R // w
        total += wad(p["severity"]) * pm * mean_r // (WAD * 10_000)
        sd_r = math.isqrt(mean_r * (R - mean_r) * WAD // (w + WAD))
        total += wad(p["severity"]) * wad(p["lambda"]) * pm * sd_r // (WAD * WAD * 10_000)
    total += wad(p["lpYield"]) * pm * lock_seconds * R // (YEAR_S * wad(p["utilization"]) * 10_000)
    total += ops * R
    return (total + R - 1) // R


def _int(x, what, lo=0):
    if isinstance(x, bool) or not isinstance(x, int) or x < lo:
        raise ValueError(f"{what} must be an integer >= {lo}, got {x}")
    return x


def max_ratio_e6(params: Optional[dict] = None) -> int:
    p = {**LP_DEFAULTS, **(params or {})}
    return js_round(p["maxRatio"] * RATIO_SCALE)


def ending_legs(price, premium, to_backers, deposit, compensation, cover_cap, evaluator_fee) -> dict:
    """Who receives what at each money ending (the twin of src/economy.ts endingLegs)."""
    P, pi, b, D, c, C, E = price, premium, to_backers, deposit, compensation, cover_cap, evaluator_fee
    to_layer = pi - b
    back = pi - to_layer if b == 0 else 0
    L = lambda buyer, seller, backers=0, layer=0, evaluator=0: {"buyer": buyer, "seller": seller, "backers": backers, "layer": layer, "evaluator": evaluator}
    return {
        "completed": L(back, P + D, b, to_layer, E),
        "auto_completed": L(back + E, P + D, b, to_layer),
        "rejected": L(P + pi + c, D - c, 0, 0, E),
        "no_show": L(P + pi + E + c, D - c),
        "expired_delivered": L(P + pi + E, D),
        "unaccepted": L(P + pi + E, 0),
        "cheated": L(P + pi + E + D + C, 0),
    }


def quote_economy(price: int, record: Optional[dict], lock_seconds: int, arbitrator: bool, fee: int,
                  cover_multiple_bps: int = 10_000, params: Optional[dict] = None, evaluator_fee: Optional[int] = None) -> dict:
    """Every number of one assured job, from the record. Pure."""
    _int(price, "price", 1)
    if price > MAX_PRICE_UNITS:
        raise ValueError(f"price above {MAX_PRICE_UNITS} units")
    _int(fee, "fee")
    _int(lock_seconds, "lock_seconds")
    _int(cover_multiple_bps, "cover_multiple_bps", 10_000)
    if cover_multiple_bps > 1_000_000 or lock_seconds > 10 ** 10:
        raise ValueError("cover_multiple_bps or lock_seconds out of range")
    p = {**LP_DEFAULTS, **(params or {})}
    k = record["correct"] if record else 0
    f = record["incorrect"] if record else 0
    n = k + f
    insurable = k > 0
    if insurable:
        u = wilson_upper_failure(k, n)
        ratio_e6 = js_round(u * RATIO_SCALE)
        wilson = premium_amount(price, u)
    else:
        ratio_e6 = RATIO_SCALE
        wilson = price
    lp = lp_premium_units(price, record, lock_seconds, arbitrator, cover_multiple_bps, p)
    need = lp + fee
    priced = max(wilson, need)
    mr = max_ratio_e6(p)
    covered = insurable and lp > 0 and priced * RATIO_SCALE <= price * mr
    cap = price * cover_multiple_bps // 10_000
    ub_loss_on_cap = (cap * ratio_e6 + RATIO_SCALE - 1) // RATIO_SCALE
    compensation = min(priced, price)
    deposit = price + max(compensation, ub_loss_on_cap)
    legs = ending_legs(price, priced if covered else 0, lp if covered else 0, deposit, compensation, cap if covered else 0,
                       fee if evaluator_fee is None else _int(evaluator_fee, "evaluator_fee"))
    return {
        "v": ECONOMY_VERSION,
        "insurable": insurable,
        "covered": covered,
        "reason": None if covered else ("UNKNOWN" if not insurable else "BACKERS_UNPAID" if lp == 0 else "OVER_MAX_RATIO"),
        "premium": priced if covered else 0,
        "to_backers": lp if covered else 0,
        "to_layer": priced - lp if covered else 0,
        "deposit": deposit,
        "compensation": compensation,
        "cover_cap": cap if covered else 0,
        "legs": legs,
        "basis": {"ratio_e6": ratio_e6, "wilson": wilson, "lp": lp, "fee": fee, "need": need, "priced": priced,
                  "max_ratio_e6": mr, "ub_loss_on_cap": ub_loss_on_cap},
    }


def check_bounds(price: int, premium: int, deposit: int, cover_cap: int, pool: bool, seconds_to_deadline: int,
                 to_backers: int, to_layer: int, compensation: int, max_premium_bps: int, min_backers_apr_bps: int):
    """AssuranceHook V5.1's check of committed terms, off chain. The first failed bound's name, or None."""
    if to_backers + to_layer != premium:
        return "LegsNotPremium"
    if not pool and (to_backers != 0 or to_layer != 0):
        return "LegsWithoutPool"
    if premium * 10_000 > price * max_premium_bps:
        return "PremiumOverBound"
    if compensation > deposit or compensation > price:
        return "CompensationOverBound"
    if pool:
        if to_backers == 0:
            return "BackersBelowFloor"
        if to_backers * 10_000 * YEAR_S < cover_cap * min_backers_apr_bps * seconds_to_deadline:
            return "BackersBelowFloor"
    return None
