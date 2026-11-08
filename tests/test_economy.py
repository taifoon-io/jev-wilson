import json
import pathlib

import pytest

from taifoon_jev_wilson.economy import check_bounds, lp_premium_units, quote_economy, wad
from taifoon_jev_wilson.lp import lp_premium

HERE = pathlib.Path(__file__).parent
G = json.loads((HERE / "vectors" / "economy-grid.json").read_text())
LP = json.loads((HERE / "vectors" / "lp-grid.json").read_text())


def test_economy_grid_equals_typescript():
    assert G["rows"] >= 10_000
    for i in range(G["rows"]):
        p = G["params"][G["param"][i]]["source"]
        rec = {"correct": G["correct"][i], "incorrect": G["incorrect"][i]}
        q = quote_economy(int(G["price"][i]), rec, G["lock"][i], G["arbitrator"][i], int(G["fee"][i]),
                          G["multiple"][i], p)
        assert q["covered"] == G["covered"][i], i
        for k, col in (("premium", "premium"), ("to_backers", "to_backers"), ("to_layer", "to_layer"),
                       ("deposit", "deposit"), ("compensation", "compensation"), ("cover_cap", "cover_cap")):
            assert str(q[k]) == G[col][i], (i, k)
        assert q["basis"]["ratio_e6"] == G["ratio_e6"][i], i
        assert str(q["basis"]["lp"]) == G["lp"][i], i


def test_params_wad_match_the_grid():
    for p in G["params"]:
        for k in ("a0", "b0", "lambda", "severity", "lpYield", "utilization"):
            assert str(wad(p["source"][k])) == p[k]


def test_lp_premium_units_is_lp_premium_on_the_lp_grid():
    c = {k: LP["cols"].index(k) for k in ("price", "correct", "incorrect", "lockSeconds", "coverMultipleBps", "arbitrator", "premium")}
    n = 0
    for r in LP["rows"]:
        if not float(r[c["lockSeconds"]]).is_integer():
            continue
        rec = None if r[c["correct"]] is None else {"correct": r[c["correct"]], "incorrect": r[c["incorrect"]]}
        exact = lp_premium_units(r[c["price"]], rec, int(r[c["lockSeconds"]]), r[c["arbitrator"]], r[c["coverMultipleBps"]])
        assert exact == r[c["premium"]]
        assert exact == lp_premium(r[c["price"]], rec, r[c["lockSeconds"]], r[c["arbitrator"]], r[c["coverMultipleBps"]])["premium"]
        n += 1
    assert n > 1_000


def test_owner_numbers_base_10_usdc_7_days():
    want = {(1, 20): (2_361_310, 1_602_269, 759_041), (5, 100): (1_117_500, 1_023_752, 93_748),
            (50, 1_000): (764_771, 715_771, 49_000), (500, 10_000): (669_514, 620_514, 49_000)}
    for (f, n), (premium, backers, layer) in want.items():
        q = quote_economy(10_000_000, {"correct": n - f, "incorrect": f}, 7 * 86_400, True, 49_000)
        assert (q["premium"], q["to_backers"], q["to_layer"]) == (premium, backers, layer)
        assert q["compensation"] == premium and q["deposit"] == 10_000_000 + premium


def test_check_bounds():
    q = quote_economy(10_000_000, {"correct": 95, "incorrect": 5}, 7 * 86_400, True, 49_000)
    args = dict(price=10_000_000, premium=q["premium"], deposit=q["deposit"], cover_cap=q["cover_cap"], pool=True,
                seconds_to_deadline=7 * 86_400, to_backers=q["to_backers"], to_layer=q["to_layer"],
                compensation=q["compensation"], max_premium_bps=3_000, min_backers_apr_bps=1_000)
    assert check_bounds(**args) is None
    assert check_bounds(**{**args, "to_layer": args["to_layer"] + 1}) == "LegsNotPremium"
    assert check_bounds(**{**args, "compensation": args["deposit"] + 1}) == "CompensationOverBound"


def test_refusals():
    with pytest.raises(ValueError):
        quote_economy(0, None, 0, False, 0)
    with pytest.raises(ValueError):
        quote_economy(1, None, 0, False, 0, cover_multiple_bps=9_999)
    q = quote_economy(10_000_000, None, 4_200, True, 49_000)
    assert q["covered"] is False and q["reason"] == "UNKNOWN" and q["compensation"] == 10_000_000 and q["deposit"] == 20_000_000


def test_legs_sum_to_what_the_job_holds():
    for i in range(0, G["rows"], 11):
        p = G["params"][G["param"][i]]["source"]
        P, E = int(G["price"][i]), int(G["fee"][i]) // 2
        q = quote_economy(P, {"correct": G["correct"][i], "incorrect": G["incorrect"][i]}, G["lock"][i], G["arbitrator"][i],
                          int(G["fee"][i]), G["multiple"][i], p, evaluator_fee=E)
        for end, l in q["legs"].items():
            held = P + q["premium"] + E + (0 if end == "unaccepted" else q["deposit"]) + (q["cover_cap"] if end == "cheated" else 0)
            assert sum(l.values()) == held, (i, end)
