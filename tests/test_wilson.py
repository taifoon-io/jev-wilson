import hashlib
import json
import os

import pytest

from taifoon_jev_wilson import (
    RUBRIC_ASKED, RUBRIC_HASH, RUBRIC_V1, THRESHOLDS_V1, Z, grade, js_round, listing, premium, premium_amount,
    rubric_json, wilson, wilson_lower, wilson_upper_failure,
)

HERE = os.path.dirname(__file__)


def load(rel):
    with open(os.path.join(HERE, rel), encoding="utf-8") as f:
        return json.load(f)


V = load("vectors.json")
G = load("grid.json")


def test_z_is_the_layers_constant():
    assert Z == 1.959963984540054 == V["z"]


@pytest.mark.parametrize("v", V["vectors"], ids=lambda v: v["id"])
def test_vector(v):
    p = premium({"k": v["k"], "n": v["n"]}, price=int(v["price"]))
    if not v["layer"]["insurable"]:
        assert p["insurable"] is False and v["layer"]["premium"] is None
        return
    assert p["ratio"] == v["layer"]["premium_ratio"]
    assert repr(p["ratio"]) == repr(v["layer"]["premium_ratio"])
    assert str(p["amount"]) == v["layer"]["premium"]
    assert list(wilson(v["n"] - v["k"], v["n"])) == v["layer"]["wilson_failure"]


def test_live_fixtures_match_vectors():
    for v in V["vectors"]:
        if "fixture" not in v:
            continue
        q = load(os.path.join("..", v["fixture"]))
        assert q["premium"] == v["layer"]["premium"]
        assert q["premium_ratio"] == v["layer"]["premium_ratio"]


def test_grid_bit_for_bit():
    for k, n, dl, dh, fl, fh, prem in G["rows"]:
        assert wilson(k, n) == (dl, dh), (k, n)
        assert wilson(n - k, n) == (fl, fh), (k, n)
        if n > 0:
            assert wilson_lower(k, n) == dl
            assert wilson_upper_failure(k, n) == fh
        p = premium({"k": k, "n": n}, price=100000000)
        if prem is None:
            assert p["insurable"] is False
        else:
            assert str(p["amount"]) == prem, (k, n)


def test_plan_rows():
    assert premium({"k": 0, "n": 0})["insurable"] is False
    a, b = premium({"k": 9, "n": 10}), premium({"k": 90, "n": 100})
    assert a["ratio"] == 0.4041500267952385 and a["covered"] is False
    assert b["ratio"] == 0.17436566150491348 and b["covered"] is True


def test_js_round_is_not_bankers_rounding():
    assert js_round(0.5) == 1 and js_round(1.5) == 2 and js_round(2.5) == 3
    assert js_round(-0.5) == 0
    assert js_round(0.49999999999999994) == 0
    assert premium_amount(100000000, 0.0000005) == 100


def test_p_l_form_close_but_labelled():
    via_pl = premium(wilson_lower(60, 62), price=10**19)
    via_rec = premium({"k": 60, "n": 62}, price=10**19)
    assert abs(via_pl["ratio"] - via_rec["ratio"]) < 1e-15
    assert via_pl["basis"] == "p_L" and via_rec["basis"] == "record"


def test_min_max():
    p = premium({"k": 2319, "n": 2323}, min=0.01)
    assert p["ratio"] == 0.01 and p["covered"]
    assert premium({"k": 10, "n": 10}, max=0.25)["covered"] is False


def test_bad_records():
    for k, n in [(3, 2), (-1, 2), (1.5, 2), (True, 2)]:
        with pytest.raises(ValueError):
            wilson_lower(k, n)
    with pytest.raises(ValueError):
        premium(1.2)


def test_listing_cheat_separate():
    a = listing(60, 62, grade_id="g1")
    b = listing(60, 62, cheat=True, grade_id="g1")
    assert a["p_L"] == b["p_L"] and a["u_F"] == b["u_F"] and b["cheat"] is True
    schema = load("../schemas/listing.schema.json")
    assert set(schema["required"]) <= set(a) <= set(schema["properties"])


def test_rubric_hash():
    r = load("../schemas/rubric-v1.json")
    assert r["rubric_hash"] == RUBRIC_HASH
    assert r["rubric"] == [dict(q) for q in RUBRIC_V1]
    assert r["thresholds"] == THRESHOLDS_V1
    assert "0x" + hashlib.sha256(rubric_json().encode()).hexdigest() == RUBRIC_HASH
    assert r["asked"] == [q["id"] for q in RUBRIC_ASKED]


def test_grade_through_the_official_sdk():
    typesafe_sdk = pytest.importorskip("typesafe_sdk")
    httpx2 = pytest.importorskip("httpx2")
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        a = lambda choice, yes: {"type": "choice", "choice": choice, "confidence": max(yes, 1 - yes), "probabilities": {"yes": yes, "no": 1 - yes}}
        answers = {
            "spec_met": a("yes", 0.9),
            "unsupported_claim": a("no", 0.1),
            "ending": {"type": "choice", "choice": "complete", "confidence": 0.8, "probabilities": {"complete": 0.8, "reject": 0.1, "expire": 0.05, "needs_review": 0.05}},
            "cheat_shaped": a("no", 0.2),
        }
        return httpx2.Response(200, json={"model": seen["body"]["model"], "answers": answers, "usage": {"input_tokens": 10, "output_tokens": 4}})

    client = typesafe_sdk.TypeSafeClient(api_key="ts-test-key", transport=httpx2.MockTransport(handler))
    g = grade({"task": "t", "deliverable": "d"}, client=client)
    assert seen["url"] == "https://api.typesafe.ai/v1/systemone"
    assert seen["auth"] == "Bearer ts-test-key"
    assert seen["body"]["model"] == "jev-1.13.0"
    assert list(seen["body"]["questions"]) == ["spec_met", "unsupported_claim", "ending", "cheat_shaped"]
    assert seen["body"]["questions"]["ending"]["criteria"] == {"complete": "complete", "reject": "reject", "expire": "expire", "needs_review": "needs_review"}
    assert g["model"] == "jev-1.13.0" and g["rubric_hash"] == RUBRIC_HASH and g["cheat"] is False
    assert g["answers"]["ending"]["probabilities"] == {"complete": 0.8, "reject": 0.1, "expire": 0.05, "needs_review": 0.05}


def test_example_job_accept():
    ex = load("../examples/job-accept.json")
    for row in (ex["next_premium"], ex["contrast"]):
        p = premium({"k": row["k"], "n": row["n"]}, price=int(row["price"]))
        assert str(p["amount"]) == row["premium"]
        assert p["ratio"] == row["u_F"] and p["covered"] == row["covered"]
        assert wilson_lower(row["k"], row["n"]) == row["p_L"]
    fund, _, complete = ex["job"]["money_path"]
    assert sum(int(t["amount"]) for t in fund["transfers"]) == sum(int(t["amount"]) for t in complete["transfers"])
