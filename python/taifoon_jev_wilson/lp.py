"""jev-wilson/lp: the premium a cover pool's backers need, priced from their side.

Bit-for-bit with src/lp.ts (tests/vectors/lp-grid.json): the same operations in the same order, only + - * / and sqrt.

  expected loss   s * C * mu              mu = (a0 + f) / (a0 + b0 + n), the Beta-Binomial posterior mean
  risk loading    s * C * lam * sd        sd = sqrt(mu * (1 - mu) / (a0 + b0 + n + 1))
  capital         y * C * T / (YEAR * u)
  operations      o
  C = P * m; no arbitrator => expected loss and risk loading are 0; premium = ceil(sum); covered when premium / P <= max.
"""
import math
from typing import Optional

YEAR_S = 31_536_000

LP_DEFAULTS = {
    "a0": 0.1666, "b0": 0.9297, "lambda": 2, "severity": 1, "lpYield": 0.1, "utilization": 0.25, "opsUnits": 100, "maxRatio": 0.3,
}


def _check_count(x: int, what: str) -> None:
    if isinstance(x, bool) or not isinstance(x, int) or x < 0:
        raise ValueError(f"{what} must be an integer >= 0, got {x}")


def failure_rate(record: Optional[dict], params: Optional[dict] = None) -> dict:
    p = {**LP_DEFAULTS, **(params or {})}
    f = record["incorrect"] if record else 0
    k = record["correct"] if record else 0
    _check_count(f, "incorrect")
    _check_count(k, "correct")
    n = k + f
    w = p["a0"] + p["b0"] + n
    mean = (p["a0"] + f) / w
    sd = math.sqrt((mean * (1 - mean)) / (w + 1))
    return {"mean": mean, "sd": sd, "n": n}


def lp_premium(price: int, record: Optional[dict], lock_seconds: float, arbitrator: bool,
               cover_multiple_bps: int = 10_000, params: Optional[dict] = None) -> dict:
    """The premium a backer needs for one job (token's smallest unit). Pure."""
    p = {**LP_DEFAULTS, **(params or {})}
    if isinstance(price, bool) or not isinstance(price, int) or price <= 0:
        raise ValueError("price must be a positive integer in the token's smallest unit")
    if not lock_seconds >= 0:
        raise ValueError("lock_seconds must be >= 0")
    if not (0 < p["utilization"] <= 1):
        raise ValueError("utilization must be in (0, 1]")
    m = cover_multiple_bps / 10_000
    cover = price * m
    rate = failure_rate(record, p)
    expected_loss = p["severity"] * cover * rate["mean"] if arbitrator else 0
    risk = p["severity"] * cover * p["lambda"] * rate["sd"] if arbitrator else 0
    capital = (p["lpYield"] * cover * lock_seconds) / (YEAR_S * p["utilization"])
    ops = p["opsUnits"]
    premium = math.ceil(expected_loss + risk + capital + ops)
    ratio = premium / price
    return {
        "premium": premium, "ratio": ratio, "covered": ratio <= p["maxRatio"],
        "parts": {"expectedLoss": expected_loss, "risk": risk, "capital": capital, "ops": ops},
        "rate": rate, "cover": cover,
    }
