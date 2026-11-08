"""jev-wilson/bets: two-sided job assurance (Python twin of src/bets.ts). Integers only; the same operations in the same
order, so tests/vectors/bets-grid.json and bets-scenarios.json hold for TypeScript, Python and Solidity to the unit."""
from math import isqrt

WAD = 10**18
YEAR_S = 31_536_000

BETS_DEFAULTS = {
    "a0": 166_600_000_000_000_000, "b0": 929_700_000_000_000_000, "lambda": 2 * WAD, "lpYield": WAD // 10,
    "utilization": WAD // 4, "maxRatio": 3 * WAD // 10, "pMin": 5 * WAD // 1000, "feeBps": 49, "minFee": 20_000,
    "coverMultipleBps": 10_000, "againstMultipleBps": 10_000, "perBuyerCap": 3, "minDistinctBuyers": 3,
    "seniorPerRound": 20_000, "lockCutoffS": 60, "voidGraceS": 604_800,
}


def _ceil_div(a: int, b: int) -> int:
    return 0 if a == 0 else (a - 1) // b + 1


def bets_price(k_eff: int, f: int, lock_s: int, p: dict = BETS_DEFAULTS) -> dict:
    if k_eff < 0 or f < 0 or lock_s < 0:
        raise ValueError("record and lock must be >= 0")
    n = k_eff + f
    w = p["a0"] + p["b0"] + n * WAD
    mean = _ceil_div((p["a0"] + f * WAD) * WAD, w)
    v = (mean * (WAD - mean)) // (w + WAD)
    s2 = v * WAD
    sd = isqrt(s2)
    if sd * sd != s2:
        sd += 1
    risk = _ceil_div(p["lambda"] * sd, WAD)
    capital = _ceil_div(p["lpYield"] * lock_s * WAD, YEAR_S * p["utilization"])
    price = max(p["pMin"], mean + risk + capital)
    return {"p": price, "mean": mean, "sd": sd, "risk": risk, "capital": capital, "insurable": price <= p["maxRatio"]}


def gross_payout(x: int, price: int) -> int:
    return (x * WAD) // price


def position_fee(x: int, p: dict = BETS_DEFAULTS) -> int:
    return max(_ceil_div(x * p["feeBps"], 10_000), p["minFee"])


class BetsError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def book_key(seller: str, class_id: str) -> str:
    return f"{seller.lower()}|{class_id}"


class BetsMarket:
    """Reference model of AssuranceMarket: every guard, refusal error and payout of src/bets.ts BetsMarket."""

    def __init__(self, params: dict = BETS_DEFAULTS, owner: str = "owner"):
        self.p, self.owner, self.state = params, owner, "Active"
        self.rounds, self.positions, self.books, self.treasury = {}, [], {}, 0

    def book(self, key):
        return self.books.setdefault(key, {"kEff": 0, "f": 0, "distinctBuyers": 0, "seniorOpen": 0, "buyerRounds": {}})

    def senior_cap(self, b):
        return self.p["seniorPerRound"] * b["kEff"] if b["distinctBuyers"] >= self.p["minDistinctBuyers"] else 0

    def pause(self, caller):
        if caller != self.owner: raise BetsError("NotOwner")
        if self.state != "Active": raise BetsError("MarketNotActive")
        self.state = "Paused"

    def unpause(self, caller):
        if caller != self.owner: raise BetsError("NotOwner")
        if self.state != "Paused": raise BetsError("MarketShutdown")
        self.state = "Active"

    def shutdown(self, caller):
        if caller != self.owner: raise BetsError("NotOwner")
        if self.state == "Shutdown": raise BetsError("MarketShutdown")
        self.state = "Shutdown"

    def round(self, job_id):
        if job_id not in self.rounds: raise BetsError("NoRound")
        return self.rounds[job_id]

    def open_round(self, caller, job_id, class_id, job, now):
        if self.state != "Active": raise BetsError("MarketNotActive")
        if job_id in self.rounds: raise BetsError("RoundExists")
        if not job["accepted"]: raise BetsError("JobNotAccepted")
        if now >= job["deadline"] - self.p["lockCutoffS"]: raise BetsError("AfterCutoff")
        r = {"id": job_id, "book": book_key(job["seller"], class_id), "buyer": job["buyer"], "seller": job["seller"],
             "price": job["price"], "deadline": job["deadline"],
             "voidAt": job["deadline"] + job["reviewWindow"] + job["disputeWindow"] + job["arbitrationWindow"] + self.p["voidGraceS"],
             "state": "Open", "Fj": 0, "Fs": 0, "X": 0, "GA": 0, "GC": 0, "fees": 0, "seniorExposure": 0, "xCount": 0, "unclaimed": 0, "held": 0}
        self.rounds[job_id] = r
        return r

    def is_open(self, r, accepted, now):
        return r["state"] == "Open" and accepted and now < r["deadline"] - self.p["lockCutoffS"]

    def lock(self, job_id, accepted, now):
        r = self.round(job_id)
        if r["state"] != "Open": raise BetsError("RoundNotOpen")
        if self.is_open(r, accepted, now): raise BetsError("NotLockable")
        r["state"] = "Locked"

    def _exposure(self, Fj, Fs, GA, GC, X):
        L = GA + GC - X
        if L > Fj + Fs: raise BetsError("Undercollateralised")
        return L - Fj if L > Fj else 0

    def _apply(self, r, senior):
        b = self.book(r["book"])
        nxt = b["seniorOpen"] - r["seniorExposure"] + senior
        if senior > r["seniorExposure"] and nxt > self.senior_cap(b): raise BetsError("SeniorCap")
        b["seniorOpen"], r["seniorExposure"] = nxt, senior

    def open_for(self, caller, job_id, amount, accepted, now):
        if self.state != "Active": raise BetsError("MarketNotActive")
        r = self.round(job_id)
        if not self.is_open(r, accepted, now): raise BetsError("RoundNotOpen")
        if amount <= 0: raise BetsError("ZeroAmount")
        junior = caller == r["seller"]
        if junior: r["Fj"] += amount
        else: r["Fs"] += amount
        self._apply(r, self._exposure(r["Fj"], r["Fs"], r["GA"], r["GC"], r["X"]))
        r["held"] += amount; r["unclaimed"] += 1
        pos = {"id": len(self.positions), "round": job_id, "owner": caller, "side": "FOR", "stake": amount, "fee": 0, "p": 0, "G": 0, "junior": junior, "active": True}
        self.positions.append(pos)
        return pos

    def open_failure(self, side, caller, job_id, x, max_price, lock_s, accepted, now):
        if self.state != "Active": raise BetsError("MarketNotActive")
        r = self.round(job_id)
        if not self.is_open(r, accepted, now): raise BetsError("RoundNotOpen")
        if x <= 0: raise BetsError("ZeroAmount")
        if side == "AGAINST":
            if caller == r["seller"]: raise BetsError("SellerCannotChallenge")
            if caller == r["buyer"]: raise BetsError("BuyerUsesCover")
        elif caller != r["buyer"]:
            raise BetsError("NotBuyer")
        b = self.book(r["book"])
        q = bets_price(b["kEff"], b["f"], lock_s, self.p)
        if not q["insurable"]: raise BetsError("NotInsurable")
        if q["p"] > max_price: raise BetsError("PriceAboveMax")
        G = gross_payout(x, q["p"])
        GA = r["GA"] + G if side == "AGAINST" else r["GA"]
        GC = r["GC"] + G if side == "COVER" else r["GC"]
        if GA > (r["price"] * self.p["againstMultipleBps"]) // 10_000: raise BetsError("AgainstCap")
        if GC > (r["price"] * self.p["coverMultipleBps"]) // 10_000: raise BetsError("CoverCap")
        self._apply(r, self._exposure(r["Fj"], r["Fs"], GA, GC, r["X"] + x))
        fee = position_fee(x, self.p)
        r["GA"], r["GC"] = GA, GC
        r["X"] += x; r["fees"] += fee; r["xCount"] += 1; r["unclaimed"] += 1; r["held"] += x + fee
        pos = {"id": len(self.positions), "round": job_id, "owner": caller, "side": side, "stake": x, "fee": fee, "p": q["p"], "G": G, "junior": False, "active": True}
        self.positions.append(pos)
        return pos

    def withdraw_for(self, caller, pid, amount, accepted, now):
        pos = self.positions[pid]
        r = self.round(pos["round"])
        if not self.is_open(r, accepted, now): raise BetsError("RoundNotOpen")
        if pos["owner"] != caller: raise BetsError("NotOwner")
        if pos["side"] != "FOR": raise BetsError("NotFor")
        if not pos["active"]: raise BetsError("PositionNotActive")
        if amount <= 0 or amount > pos["stake"]: raise BetsError("BadAmount")
        Fj = r["Fj"] - amount if pos["junior"] else r["Fj"]
        Fs = r["Fs"] if pos["junior"] else r["Fs"] - amount
        self._apply(r, self._exposure(Fj, Fs, r["GA"], r["GC"], r["X"]))
        r["Fj"], r["Fs"] = Fj, Fs
        pos["stake"] -= amount; r["held"] -= amount
        if pos["stake"] == 0:
            pos["active"] = False; r["unclaimed"] -= 1
        return amount

    def resolve(self, job_id, outcome):
        r = self.round(job_id)
        if r["state"] not in ("Open", "Locked"): raise BetsError("AlreadyResolved")
        if outcome is None: raise BetsError("NoOutcome")
        b = self.book(r["book"])
        b["seniorOpen"] -= r["seniorExposure"]; r["seniorExposure"] = 0
        if outcome == "Delivered":
            seen = b["buyerRounds"].get(r["buyer"], 0)
            if seen == 0: b["distinctBuyers"] += 1
            if seen < self.p["perBuyerCap"]: b["kEff"] += 1
            b["buyerRounds"][r["buyer"]] = seen + 1
        else:
            b["f"] += 1
        r["state"] = outcome
        self.treasury += r["fees"]; r["held"] -= r["fees"]

    def void_round(self, job_id, now, unreadable=False, outcome=None):
        r = self.round(job_id)
        if r["state"] not in ("Open", "Locked"): raise BetsError("AlreadyResolved")
        if not unreadable and outcome is not None: raise BetsError("HasOutcome")
        if not unreadable and now <= r["voidAt"]: raise BetsError("VoidTooEarly")
        b = self.book(r["book"])
        b["seniorOpen"] -= r["seniorExposure"]; r["seniorExposure"] = 0
        r["state"] = "Void"

    def payout_of(self, pos):
        r = self.round(pos["round"])
        L = r["GA"] + r["GC"] - r["X"]
        if r["state"] == "Void":
            return pos["stake"] if pos["side"] == "FOR" else pos["stake"] + pos["fee"]
        if r["state"] == "Delivered":
            return pos["stake"] + (pos["stake"] * r["X"]) // (r["Fj"] + r["Fs"]) if pos["side"] == "FOR" else 0
        if r["state"] == "Failed":
            if pos["side"] != "FOR": return pos["G"]
            if pos["junior"]: return (pos["stake"] * (r["Fj"] - min(L, r["Fj"]))) // r["Fj"]
            return (pos["stake"] * (r["Fs"] - (L - r["Fj"] if L > r["Fj"] else 0))) // r["Fs"]
        raise BetsError("NotResolved")

    def claim(self, pid):
        pos = self.positions[pid]
        r = self.round(pos["round"])
        if r["state"] not in ("Delivered", "Failed", "Void"): raise BetsError("NotResolved")
        if not pos["active"]: raise BetsError("PositionNotActive")
        out = self.payout_of(pos)
        pos["active"] = False; r["unclaimed"] -= 1; r["held"] -= out
        assert r["held"] >= 0, "a round paid more than it held"
        return out

    def sweep_dust(self, job_id):
        r = self.round(job_id)
        if r["state"] not in ("Delivered", "Failed", "Void"): raise BetsError("NotResolved")
        if r["unclaimed"] != 0: raise BetsError("PositionsOutstanding")
        dust = r["held"]
        self.treasury += dust; r["held"] = 0; r["state"] = "Settled"
        return dust


_OUTCOME = {"Completed": "Delivered", "Rejected": "Failed", "Cheated": "Failed", "Expired": "Failed"}


def run_bets_script(script: dict) -> dict:
    """Replay a chain-agnostic op list (tests/vectors/bets-scenarios.json) on the reference market."""
    m = BetsMarket({k: int(v) for k, v in script["params"].items()})
    state = {j: "Accepted" for j in script["jobs"]}
    bal: dict = {}
    steps = []

    def add(who, v):
        bal[who] = bal.get(who, 0) + v

    def view(j):
        d = script["jobs"][j]
        return {"buyer": d["buyer"], "seller": d["seller"], "price": int(d["price"]), "deadline": int(d["deadline"]),
                "reviewWindow": int(d["reviewWindow"]), "disputeWindow": int(d["disputeWindow"]),
                "arbitrationWindow": int(d["arbitrationWindow"]), "accepted": state[j] == "Accepted"}

    for i, o in enumerate(script["ops"]):
        value = None
        try:
            op = o["op"]
            if op == "job": state[o["job"]] = o["state"]
            elif op == "openRound": m.open_round(o["caller"], o["job"], o["classId"], view(o["job"]), int(o["now"]))
            elif op == "openFor":
                p = m.open_for(o["caller"], o["job"], int(o["amount"]), state[o["job"]] == "Accepted", int(o["now"])); add(o["caller"], -p["stake"]); value = p["id"]
            elif op in ("openAgainst", "openCover"):
                p = m.open_failure("AGAINST" if op == "openAgainst" else "COVER", o["caller"], o["job"], int(o["x"]), int(o["maxPrice"]), int(o["lockS"]), state[o["job"]] == "Accepted", int(o["now"]))
                add(o["caller"], -(p["stake"] + p["fee"])); value = p["id"]
            elif op == "withdrawFor":
                pos = m.positions[o["pos"]]
                value = m.withdraw_for(o["caller"], o["pos"], int(o["amount"]), state[pos["round"]] == "Accepted", int(o["now"])); add(o["caller"], value)
            elif op == "lock": m.lock(o["job"], state[o["job"]] == "Accepted", int(o["now"]))
            elif op == "resolve": m.resolve(o["job"], _OUTCOME.get(state[o["job"]]))
            elif op == "void": m.void_round(o["job"], int(o["now"]), False, _OUTCOME.get(state[o["job"]]))
            elif op == "claim":
                pos = m.positions[o["pos"]]; value = m.claim(o["pos"]); add(pos["owner"], value)
            elif op == "sweep": value = m.sweep_dust(o["job"])
            elif op == "pause": m.pause(o["caller"])
            elif op == "unpause": m.unpause(o["caller"])
            elif op == "shutdown": m.shutdown(o["caller"])
            if o.get("expect"): raise AssertionError(f"step {i} expected {o['expect']} but succeeded")
            steps.append({"i": i, "s": o["s"], "t": o["t"], "op": op, "ok": True, "error": None, "value": None if value is None else str(value)})
        except BetsError as e:
            if o.get("expect") != e.code: raise AssertionError(f"step {i} ({o['s']} {o['t']}) {o['op']}: {e.code}")
            steps.append({"i": i, "s": o["s"], "t": o["t"], "op": o["op"], "ok": False, "error": e.code, "value": None})
    held = sum(r["held"] for r in m.rounds.values())
    return {"steps": steps, "treasury": str(m.treasury), "held": str(held), "conserved": sum(bal.values()) + m.treasury + held == 0,
            "balances": {k: str(v) for k, v in sorted(bal.items())}}
