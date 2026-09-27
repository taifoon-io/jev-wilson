"""jev-wilson: a Wilson bound on a seller's record, mapped to a coverage premium.

Bit-for-bit with src/wilson.ts and with the Taifoon coordination layer:
  interval   the 95% Wilson score interval, no continuity correction, clamped to [0, 1]
  z          1.959963984540054 (the layer's constant), not 1.96
  pi ratio   the UPPER bound on the failure rate = wilson(n - k, n)[1]
  pi amount  floor(price * js_round(ratio * 1e6) / 1e6), integer arithmetic
  UNKNOWN    no delivered job (k = 0): not insurable
  cover      only when pi / P <= 0.30

Every float operation runs in the same order as the TypeScript. Python's round() is banker's rounding,
so js_round() reproduces JavaScript Math.round instead.
"""
import math
from typing import Any, Optional, Union

from .rubric import RUBRIC_ASKED, RUBRIC_HASH, RUBRIC_VERSION, THRESHOLDS_V1

Z = 1.959963984540054
MAX_PREMIUM_RATIO = 0.3
RATIO_SCALE = 1_000_000
JEV_MODEL = "jev-1.13.0"


def _check_record(k: int, n: int) -> None:
    if isinstance(k, bool) or isinstance(n, bool) or not isinstance(k, int) or not isinstance(n, int) or k < 0 or n < 0 or k > n:
        raise ValueError(f"need integers 0 <= k <= n, got k={k}, n={n}")


def wilson(successes: int, n: int, z: float = Z) -> tuple:
    """The Wilson score interval for `successes` of `n`. (0, 1) when n = 0."""
    if n <= 0:
        return (0.0, 1.0)
    p = successes / n
    z2 = z * z
    d = 1 + z2 / n
    c = p + z2 / (2 * n)
    s = z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
    return (max(0.0, (c - s) / d), min(1.0, (c + s) / d))


def wilson_lower(k: int, n: int, z: float = Z) -> float:
    """p_L: the lower Wilson bound on the delivered rate, k delivered of n graded."""
    _check_record(k, n)
    return wilson(k, n, z)[0]


def wilson_upper_failure(k: int, n: int, z: float = Z) -> float:
    """u_F: the upper Wilson bound on the failure rate. This is the layer's pi ratio."""
    _check_record(k, n)
    return wilson(n - k, n, z)[1]


def js_round(x: float) -> int:
    """JavaScript Math.round: the nearest integer, ties toward +infinity."""
    f = math.floor(x)
    return int(f + 1) if x - f >= 0.5 else int(f)


def premium_amount(price: int, ratio: float) -> int:
    """floor(price * round(ratio * 1e6) / 1e6), as the layer's pool-quote computes it."""
    price = int(price)
    if price <= 0:
        raise ValueError("price must be a positive integer in the token's smallest unit")
    return (price * js_round(ratio * RATIO_SCALE)) // RATIO_SCALE


def premium(input: Union[float, dict], *, min: float = 0.0, max: float = MAX_PREMIUM_RATIO, price: Optional[Union[int, str]] = None, z: float = Z) -> dict:
    """The premium for the next job.

    premium({"k": k, "n": n}, ...)  prices from the record: ratio = u_F, bit-for-bit with the layer.
    premium(p_L, ...)               prices 1 - p_L. Equal in real arithmetic, but can differ from u_F in
                                    the last bits of a double. Use the record form for the layer's number.
    """
    if isinstance(input, dict):
        k, n = input["k"], input["n"]
        _check_record(k, n)
        if k <= 0:
            return {"insurable": False, "reason": "UNKNOWN", "ratio": None, "amount": None, "covered": False, "basis": "record"}
        raw = wilson_upper_failure(k, n, z)
        basis = "record"
    else:
        p_l = float(input)
        if not (0.0 <= p_l <= 1.0):
            raise ValueError(f"p_L must be in [0, 1], got {input}")
        raw = 1 - p_l
        basis = "p_L"
    ratio = min if raw < min else raw
    amount = None if price is None else premium_amount(int(price), ratio)
    return {"insurable": True, "ratio": ratio, "amount": amount, "covered": ratio <= max, "basis": basis}


def listing(k: int, n: int, *, z: float = Z, cheat: bool = False, grade_id: Optional[str] = None) -> dict:
    """One listing row: the record, both bounds, and the cheat flag kept apart from them."""
    return {"n": n, "k": k, "p_L": wilson_lower(k, n, z), "u_F": wilson_upper_failure(k, n, z), "z": z, "cheat": cheat, "grade_id": grade_id}


def grade(state: Any, *, client: Any = None, model: str = JEV_MODEL, questions=RUBRIC_ASKED) -> dict:
    """Optional. Ask Jev the four RUBRIC_v1 questions through TypeSafe AI's own SDK, typesafe-sdk
    (pip install "taifoon-jev-wilson[jev]"). Each question is the SDK's Choice; the call is client.system_one().
    With no client it makes typesafe_sdk.TypeSafeClient(), which reads your TYPESAFE_API_KEY.
    This package has no HTTP client of its own and never sees your key."""
    try:
        from typesafe_sdk import Choice, TypeSafeClient
    except ImportError as e:  # pragma: no cover - exercised only without the extra
        raise ImportError('grade() needs TypeSafe AI\'s SDK: pip install "taifoon-jev-wilson[jev]"') from e
    qs = {q["id"]: Choice(instructions=q["text"], criteria={o: o for o in q["options"]}) for q in questions}
    if client is None:
        client = TypeSafeClient()
    res = client.system_one(state=state, questions=qs, model=model)
    answers = {}
    for qid, a in dict(res.answers).items():
        answers[qid] = {"choice": a.choice, "confidence": a.confidence, "probabilities": dict(a.probabilities)}
    c = answers.get("cheat_shaped", {}).get("probabilities", {}).get("yes")
    return {"rubric": RUBRIC_VERSION, "rubric_hash": RUBRIC_HASH, "model": res.model, "answers": answers, "cheat": isinstance(c, (int, float)) and c >= THRESHOLDS_V1["cheatShapedMin"]}
