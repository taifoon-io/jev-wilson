"""jev-wilson/gas: the backers' gas per job (LP_DEFAULTS["opsUnits"]) from a per-chain gas reading.

The twin of src/gas.ts, in integers only: ops_units_from_gas returns the same integer on tests/vectors/gas-ops.json.
gas_cost_from_razor reads the cost from a razor quote (GET /v1/gas/{chain}/quote, schema taifoon.razor.quote.v1).

    lp_premium(price, record, lock, arbitrator, params={"opsUnits": ops_units_from_gas(gas_cost_from_razor(q), jobs)})
"""
import re

_INT = re.compile(r"^\d+$")


def _big(x, what):
    if isinstance(x, int) and not isinstance(x, bool):
        if x < 0:
            raise ValueError(f"{what} must be >= 0")
        return x
    if not isinstance(x, str) or not _INT.match(x):
        raise ValueError(f"{what} must be a non-negative integer string")
    return int(x)


def ops_units_from_gas(cost, jobs_per_deposit, token_decimals=6):
    """ceil(amount * usd8 * 10^token_decimals / (10^decimals * 1e8 * jobs_per_deposit)). cost = {amount, decimals, usd8}."""
    if not isinstance(jobs_per_deposit, int) or jobs_per_deposit < 1:
        raise ValueError("jobsPerDeposit must be an integer >= 1")
    d = cost["decimals"]
    if not isinstance(d, int) or d < 0 or d > 36:
        raise ValueError("decimals must be an integer in [0, 36]")
    if not isinstance(token_decimals, int) or token_decimals < 0 or token_decimals > 36:
        raise ValueError("tokenDecimals must be an integer in [0, 36]")
    num = _big(cost["amount"], "amount") * _big(cost["usd8"], "usd8") * 10 ** token_decimals
    den = 10 ** d * 100_000_000 * jobs_per_deposit
    units = (num + den - 1) // den
    if units > 2**53 - 1:
        raise ValueError("opsUnits exceeds 2^53 - 1: check decimals and amount")
    return units


def gas_cost_from_razor(q):
    amount = q["quote"].get("total_wei") or q["quote"].get("total_lamports")
    if amount is None:
        raise ValueError("the razor quote has no total_wei or total_lamports")
    native = q["reading"]["native"]
    if native.get("usd8") is None:
        raise ValueError("the razor reading has no USD price")
    return {"amount": amount, "decimals": native["decimals"], "usd8": native["usd8"]}
