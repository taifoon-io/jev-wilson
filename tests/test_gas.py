import json
import pathlib

import pytest

from taifoon_jev_wilson.gas import gas_cost_from_razor, ops_units_from_gas

G = json.loads((pathlib.Path(__file__).parent / "vectors" / "gas-ops.json").read_text())


def test_gas_vectors_bit_for_bit():
    for amount, decimals, usd8, jobs, token_decimals, want in G["rows"]:
        assert ops_units_from_gas({"amount": amount, "decimals": decimals, "usd8": usd8}, jobs, token_decimals) == want


def test_razor_quote_and_refusals():
    q = {"quote": {"total_wei": "746588449090620"}, "reading": {"native": {"decimals": 18, "usd8": "267866729079"}}}
    assert ops_units_from_gas(gas_cost_from_razor(q), 1) == G["rows"][0][5]
    with pytest.raises(ValueError):
        ops_units_from_gas({"amount": "1", "decimals": 18, "usd8": "1"}, 0)
    with pytest.raises(ValueError):
        ops_units_from_gas({"amount": "1" + "0" * 40, "decimals": 0, "usd8": "1"}, 1)
