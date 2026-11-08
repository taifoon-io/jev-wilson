import json
import pathlib

import pytest

from taifoon_jev_wilson.margin import BPS, MARGIN_BPS, OWN_FLOOR_UNITS, fee_of_list, list_price, margin_fee, seller_part

G = json.loads((pathlib.Path(__file__).parent / "vectors" / "margin-grid.json").read_text())


def test_constants():
    assert (G["bps"], G["margin_bps"], int(G["own_floor_units"])) == (BPS, MARGIN_BPS, OWN_FLOOR_UNITS)


def test_margin_equals_grid():
    for i in range(G["rows"]):
        u = int(G["units"][i])
        assert str(margin_fee(u)) == G["fee"][i], i
        assert str(list_price(u)) == G["list"][i], i
        assert str(seller_part(u)) == G["seller_of_list"][i], i
        assert str(fee_of_list(u)) == G["fee_of_list"][i], i


def test_round_trip_and_examples():
    for s in (1, 7, 221, 1000, 8333, 10**18):
        assert seller_part(list_price(s)) == s
    assert (margin_fee(1000), list_price(1000), margin_fee(0)) == (200, 1200, 2000)
    assert (seller_part(5000), fee_of_list(5000)) == (4166, 834)
    with pytest.raises(ValueError):
        margin_fee(-1)
