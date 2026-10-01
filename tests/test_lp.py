import json
import pathlib

from taifoon_jev_wilson.lp import LP_DEFAULTS, lp_premium

G = json.loads((pathlib.Path(__file__).parent / "vectors" / "lp-grid.json").read_text())


def test_lp_grid_bit_for_bit():
    assert G["params"] == LP_DEFAULTS
    for price, c, i, lock, m, arb, premium, ratio, covered, mean, sd, el, risk, capital in G["rows"]:
        rec = None if c is None else {"correct": c, "incorrect": i}
        q = lp_premium(price, rec, lock, arb, m)
        assert q["premium"] == premium and q["ratio"] == ratio and q["covered"] == covered
        assert q["rate"]["mean"] == mean and q["rate"]["sd"] == sd
        assert q["parts"]["expectedLoss"] == el and q["parts"]["risk"] == risk and q["parts"]["capital"] == capital
