"""Every calibration this package ships: the Python twin recomputes its price table from the recorded snapshot, unit for unit."""
import json
import pathlib

from taifoon_jev_wilson.fee import job_fee
from taifoon_jev_wilson.lp import lp_premium

DIR = pathlib.Path(__file__).parent.parent / "calibration"
FILES = sorted(p for p in DIR.glob("*.json") if p.stem.isdigit())


def _gas(c):
    s = c["gas_snapshot"]
    return {"chainId": c["chainId"], "block": s["block"], "baseFeeWei": int(s["base_fee_wei"]), "tipWei": int(s["tip_wei"]),
            "liveBufferBps": s["live_buffer_bps"], "gasUsd8": int(s["gas_usd8"]),
            "l1FeeWeiByBytes": {int(k): int(v) for k, v in s["l1_fee_wei_by_bytes"].items()}}


def _legs(c, profile):
    return [l for l in c["legs"]["legs"] if profile in l["profiles"]]


def test_tables_unit_for_unit():
    assert FILES
    for f in FILES:
        c = json.loads(f.read_text())
        gas = _gas(c)
        for r in c["table"]["rows"]:
            price = int(r["price"])
            q = job_fee(price, gas, _legs(c, c["table"]["profile"]), c["fee"])
            pr = c["premium"]
            pi = lp_premium(price, None, pr["lockSeconds"], pr["arbitrator"], pr["coverMultipleBps"], params=c["lp"])["premium"]
            assert (None if q["fee"] is None else str(q["fee"])) == r["fee"], (f.name, price)
            assert str(pi) == r["premium"], (f.name, price)
            assert q["served"] == r["served"] and q["floored"] == r["floored"]
            if q["served"]:
                assert str(price + q["fee"] + pi) == r["total"]
        for profile, mp in c["table"]["min_price"].items():
            assert str(job_fee(1_000_000, gas, _legs(c, profile), c["fee"])["minPrice"]) == mp
