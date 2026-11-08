"""The GRID line (calibration/grid-3692781.json): the Python twin returns the TypeScript's units on its vectors, and recomputes
the line's price table at the peg (fee decimals 20) unit for unit."""
import json
import pathlib

from taifoon_jev_wilson.economy import lp_premium_units, quote_economy
from taifoon_jev_wilson.fee import job_fee

HERE = pathlib.Path(__file__).parent
V = json.loads((HERE / "vectors" / "economy-grid-line.json").read_text())
CAL = json.loads((HERE.parent / "calibration" / "grid-3692781.json").read_text())


def test_grid_line_vectors_equal_typescript():
    assert V["rows"] > 100 and V["calibration_digest"] == CAL["digest"]
    p = V["params"][0]["source"]
    for i in range(V["rows"]):
        rec = {"correct": V["correct"][i], "incorrect": V["incorrect"][i]}
        q = quote_economy(int(V["price"][i]), rec, V["lock"][i], V["arbitrator"][i], int(V["fee"][i]), V["multiple"][i], p)
        assert q["covered"] == V["covered"][i], i
        for k in ("premium", "to_backers", "to_layer", "deposit", "compensation", "cover_cap"):
            assert str(q[k]) == V[k][i], (i, k)


def test_grid_line_table_at_the_peg():
    s = CAL["gas_snapshot"]
    gas = {"chainId": CAL["chainId"], "block": s["block"], "baseFeeWei": int(s["base_fee_wei"]), "tipWei": int(s["tip_wei"]),
           "liveBufferBps": s["live_buffer_bps"], "gasUsd8": int(s["gas_usd8"]),
           "l1FeeWeiByBytes": {int(k): int(v) for k, v in s["l1_fee_wei_by_bytes"].items()}}
    a = CAL["asset"]
    assert a["fee_decimals"] == 20 and a["decimals"] == 18
    legs = [l for l in CAL["legs"]["legs"] if CAL["table"]["profile"] in l["profiles"]]
    pr = CAL["premium"]
    for r in CAL["table"]["rows"]:
        price = int(r["price"])
        q = job_fee(price, gas, legs, CAL["fee"], a["fee_decimals"])
        pi = lp_premium_units(price, None, pr["lockSeconds"], pr["arbitrator"], pr["coverMultipleBps"], CAL["lp"])
        assert str(q["fee"]) == r["fee"] and str(pi) == r["premium"] and str(price + q["fee"] + pi) == r["total"], price
