"""jev-wilson/split: the premium's two legs and a no-show's deposit on an assurance hook with an economy (AssuranceHook V5).

Integers only; the same units as the TypeScript (src/split.ts) and Solidity (solidity/src/EconomySplit.sol) on
tests/vectors/split-grid.json. The layer's leg and the compensation round DOWN (the backers, resp. the seller, keep the dust).
"""

BPS = 10_000
MIN_BACKERS_SPLIT_BPS = 5_000


def _bps(x, lo, what):
    if not isinstance(x, int) or isinstance(x, bool) or x < lo or x > BPS:
        raise ValueError(f"{what} must be an integer in [{lo}, {BPS}], got {x!r}")
    return x


def _amount(x, what):
    if not isinstance(x, int) or isinstance(x, bool) or x < 0:
        raise ValueError(f"{what} must be a non-negative int")
    return x


def premium_split(premium, split_bps, covered=True):
    """{to_backers, to_layer, to_buyer} of a completed job's premium."""
    pi = _amount(premium, "premium")
    s = _bps(split_bps, MIN_BACKERS_SPLIT_BPS, "split_bps")
    if not covered:
        return {"to_backers": 0, "to_layer": 0, "to_buyer": pi}
    to_layer = pi * (BPS - s) // BPS
    return {"to_backers": pi - to_layer, "to_layer": to_layer, "to_buyer": 0}


def no_show_comp(deposit, comp_bps):
    """{to_buyer, to_seller} of the deposit of a job accepted and never delivered by its deadline."""
    d = _amount(deposit, "deposit")
    to_buyer = d * _bps(comp_bps, 0, "comp_bps") // BPS
    return {"to_buyer": to_buyer, "to_seller": d - to_buyer}
