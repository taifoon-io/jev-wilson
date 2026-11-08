import json
import pathlib

import pytest

from taifoon_jev_wilson.split import MIN_BACKERS_SPLIT_BPS, no_show_comp, premium_split

G = json.loads((pathlib.Path(__file__).parent / "vectors" / "split-grid.json").read_text())


def test_premium_split_equals_grid():
    for i in range(G["split_rows"]):
        r = premium_split(int(G["amount"][i]), G["split_bps"][i])
        assert str(r["to_backers"]) == G["to_backers"][i], i
        assert str(r["to_layer"]) == G["to_layer"][i], i


def test_no_show_comp_equals_grid():
    for i in range(G["comp_rows"]):
        r = no_show_comp(int(G["deposit"][i]), G["comp_bps"][i])
        assert str(r["to_buyer"]) == G["to_buyer"][i], i
        assert str(r["to_seller"]) == G["to_seller"][i], i


def test_bounds_and_uncovered():
    with pytest.raises(ValueError):
        premium_split(1, MIN_BACKERS_SPLIT_BPS - 1)
    with pytest.raises(ValueError):
        no_show_comp(1, 10_001)
    assert premium_split(100, 8_000, covered=False) == {"to_backers": 0, "to_layer": 0, "to_buyer": 100}
