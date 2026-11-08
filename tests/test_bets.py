import json
import pathlib

from taifoon_jev_wilson.bets import bets_price, gross_payout, position_fee, run_bets_script

V = pathlib.Path(__file__).parent / "vectors"
G = json.loads((V / "bets-grid.json").read_text())
S = json.loads((V / "bets-scenarios.json").read_text())


def test_bets_grid_to_the_unit():
    for s in G["sets"].values():
        p = {k: int(v) for k, v in s["params"].items()}
        for k, f, l, pp, mean, sd, risk, cap, ins, x, g, fee in s["rows"]:
            q = bets_price(int(k), int(f), int(l), p)
            assert [str(q[n]) for n in ("p", "mean", "sd", "risk", "capital")] == [pp, mean, sd, risk, cap]
            assert ("1" if q["insurable"] else "0") == ins
            assert str(gross_payout(int(x), q["p"])) == g
            assert str(position_fee(int(x), p)) == fee


def test_bets_scenarios_end_balances():
    r = run_bets_script(S["script"])
    e = S["expected"]
    assert r["balances"] == e["balances"]
    assert r["treasury"] == e["treasury"] and r["held"] == e["held"] == "0"
    assert r["conserved"] is True
    assert [(x["ok"], x["error"], x["value"]) for x in r["steps"]] == [(x["ok"], x["error"], x["value"]) for x in e["steps"]]
