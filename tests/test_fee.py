import json
import pathlib

from taifoon_jev_wilson.fee import job_fee, rise_quantiles_bps
from taifoon_jev_wilson.prior import fit_prior

HERE = pathlib.Path(__file__).parent
G = json.loads((HERE / "vectors" / "fee-grid.json").read_text())


def _gas(g):
    return {**g, "baseFeeWei": int(g["baseFeeWei"]), "tipWei": int(g["tipWei"]), "gasUsd8": int(g["gasUsd8"]),
            "l1FeeWeiByBytes": {int(k): int(v) for k, v in g["l1FeeWeiByBytes"].items()}}


def _s(x):
    return None if x is None else str(x)


def test_fee_grid_unit_for_unit():
    for gi, pi, legs, price, served, fee, by_bps, floor, cap, min_price, floored, gas_price, l2, l1, gas_usdc, buffer_bps in G["rows"]:
        q = job_fee(int(price), _gas(G["gases"][gi]), G["legs"][legs], G["policies"][pi])
        got = [q["served"], _s(q["fee"]), _s(q["byBps"]), _s(q["floor"]), _s(q["cap"]), _s(q["minPrice"]), q["floored"],
               _s(q["gas"]["gasPrice"]), _s(q["gas"]["l2"]), _s(q["gas"]["l1"]), _s(q["gas"]["usdc"]), q["gas"]["bufferBps"]]
        assert got == [served, fee, by_bps, floor, cap, min_price, floored, gas_price, l2, l1, gas_usdc, buffer_bps], (gi, pi, legs, price)


def test_rises():
    for si, w, *q in G["rises"]:
        assert rise_quantiles_bps([int(x) for x in G["series"][si]], w, [0.5, 0.9, 0.95, 0.99]) == q


def test_prior_fit_agrees():
    v = json.loads((HERE / "vectors" / "prior-fit.json").read_text())["fit"]
    f = fit_prior(json.loads((HERE / "fixtures" / "sellers-8453.json").read_text())["records"])
    for k in ("a0", "b0", "mean"):
        assert abs(f[k] - v[k]) < 1e-5 * max(1.0, abs(v[k])), (k, f[k], v[k])
    assert round(f["a0"], 4) == round(v["a0"], 4) and round(f["b0"], 4) == round(v["b0"], 4)
    for k in ("sellers", "jobs", "incorrect"):
        assert f[k] == v[k]
