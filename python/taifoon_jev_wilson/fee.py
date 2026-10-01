"""The fee on a job settled through an ERC-8183 evaluator, priced from live gas (the twin of src/fee.ts).

Integers only: every function returns the same units as the TypeScript on tests/vectors/fee-grid.json.

  fee       = max(floor(P * bps / 10,000), gas floor + margin)
  gas floor = sum over legs (gas_i * (baseFee * (1 + buffer) + tip) + L1fee_i * (1 + buffer)) * gasToken/USD * (1 + move), rounded up
  cap       = floor(P * capBps / 10,000); served = fee <= cap; min_price = the smallest P whose cap holds the floor
"""
import math

FEE_PROFILES = ("direct", "stand-in", "relayed")


def _ceil_div(a, b):
    return (a + b - 1) // b


def token_units(x, decimals=6):
    return int(math.ceil(x * 10 ** decimals))


def gas_floor(gas, legs, policy, decimals=6):
    buffer_bps = max(policy["gasBufferBps"], gas["liveBufferBps"])

    def buf(x):
        return (x * (10_000 + buffer_bps)) // 10_000

    gas_price = buf(gas["baseFeeWei"]) + gas["tipWei"]
    units = sum(l["gas"] for l in legs)
    l2 = units * gas_price
    l1_by = gas["l1FeeWeiByBytes"]
    l1_legs = []
    for l in legs:
        if not l1_by:
            l1_legs.append(0)
            continue
        f = l1_by.get(l["bytes"], l1_by.get(str(l["bytes"])))
        if f is None:
            raise ValueError("no L1 fee read for a %d-byte transaction" % l["bytes"])
        l1_legs.append(buf(f))
    l1 = sum(l1_legs)
    total = l2 + l1
    num = total * gas["gasUsd8"] * (10_000 + policy["ethMoveBps"]) * 10 ** decimals
    usdc = _ceil_div(num, 10 ** 18 * 10 ** 8 * 10_000)
    return {"usdc": usdc, "bufferBps": buffer_bps, "gasPrice": gas_price, "units": units, "l2": l2, "l1": l1, "total": total, "l1Legs": l1_legs}


def job_fee(price, gas, legs, policy, decimals=6):
    if price <= 0:
        raise ValueError("price must be positive")
    if not legs:
        raise ValueError("no legs")
    g = gas_floor(gas, legs, policy, decimals)
    margin = token_units(policy["marginUsdc"], decimals)
    floor = g["usdc"] + margin
    by_bps = (price * policy["bps"]) // 10_000
    cap = (price * policy["capBps"]) // 10_000
    min_price = _ceil_div(floor * 10_000, policy["capBps"])
    want = by_bps if by_bps >= floor else floor
    served = want <= cap
    return {
        "served": served, "fee": want if served else None, "byBps": by_bps, "floor": floor, "cap": cap, "minPrice": min_price,
        "floored": served and floor > by_bps, "margin": margin, "gas": g,
    }


def window_rises(base_fees, w):
    n = len(base_fees)
    if n < 2:
        return []
    win = max(1, min(w, n - 1))
    out = []
    for i in range(n - win):
        now = base_fees[i]
        m = max(base_fees[i:i + win + 1])
        out.append(((m - now) * 10_000) // now if now > 0 else 0)
    return out


def rise_quantiles_bps(base_fees, w, qs):
    r = sorted(window_rises(base_fees, w))
    if not r:
        return [0 for _ in qs]
    return [r[min(len(r) - 1, int(math.floor(q * len(r))))] for q in qs]


def window_rise_bps(base_fees, w):
    return rise_quantiles_bps(base_fees, w, [0.95])[0]
