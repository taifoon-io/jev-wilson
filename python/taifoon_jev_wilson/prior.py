"""The market prior Beta(a0, b0) on a seller's failure rate, fitted by maximum likelihood (the twin of src/prior.ts).

Same Lanczos log-gamma and the same Nelder-Mead steps as the TypeScript; tests/vectors/prior-fit.json holds the answers.
"""
import math

_LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
]


def lgamma(x):
    if x < 0.5:
        return math.log(math.pi / math.sin(math.pi * x)) - lgamma(1 - x)
    z = x - 1
    a = _LANCZOS[0]
    t = z + 7.5
    for i in range(1, 9):
        a += _LANCZOS[i] / (z + i)
    return 0.5 * math.log(2 * math.pi) + (z + 0.5) * math.log(t) - t + math.log(a)


def lbeta(a, b):
    return lgamma(a) + lgamma(b) - lgamma(a + b)


def beta_binomial_nll(records, a, b):
    s = 0.0
    lb = lbeta(a, b)
    for r in records:
        s -= lbeta(r["incorrect"] + a, r["correct"] + b) - lb
    return s


def nelder_mead(f, x0, step=0.5, xtol=1e-10, ftol=1e-12, max_iter=5000):
    n = len(x0)
    simplex = [list(x0)]
    for i in range(n):
        p = list(x0)
        p[i] = p[i] + step
        simplex.append(p)
    fs = [f(p) for p in simplex]
    it = 0
    while it < max_iter:
        order = sorted(range(n + 1), key=lambda i: (fs[i], i))
        simplex = [simplex[i] for i in order]
        fs = [fs[i] for i in order]
        spread = 0.0
        for i in range(1, n + 1):
            for j in range(n):
                spread = max(spread, abs(simplex[i][j] - simplex[0][j]))
        if spread <= xtol and abs(fs[n] - fs[0]) <= ftol:
            break
        c = [0.0] * n
        for i in range(n):
            for j in range(n):
                c[j] = c[j] + simplex[i][j] / n

        def at(t):
            return [c[j] + t * (simplex[n][j] - c[j]) for j in range(n)]

        xr = at(-1)
        fr = f(xr)
        if fr < fs[0]:
            xe = at(-2)
            fe = f(xe)
            if fe < fr:
                simplex[n], fs[n] = xe, fe
            else:
                simplex[n], fs[n] = xr, fr
        elif fr < fs[n - 1]:
            simplex[n], fs[n] = xr, fr
        else:
            outside = fr < fs[n]
            xc = at(-0.5 if outside else 0.5)
            fc = f(xc)
            if fc < (fr if outside else fs[n]):
                simplex[n], fs[n] = xc, fc
            else:
                for i in range(1, n + 1):
                    simplex[i] = [simplex[0][j] + 0.5 * (simplex[i][j] - simplex[0][j]) for j in range(n)]
                    fs[i] = f(simplex[i])
        it += 1
    best = 0
    for i in range(1, n + 1):
        if fs[i] < fs[best]:
            best = i
    return {"x": simplex[best], "fx": fs[best], "iters": it}


def fit_prior(records):
    R = [r for r in records if r["correct"] + r["incorrect"] > 0]
    if len(R) < 2:
        raise ValueError("fit_prior needs at least two sellers with a decided job")
    r = nelder_mead(lambda x: beta_binomial_nll(R, math.exp(x[0]), math.exp(x[1])), [0.0, 1.0])
    a0, b0 = math.exp(r["x"][0]), math.exp(r["x"][1])
    jobs = sum(x["correct"] + x["incorrect"] for x in R)
    incorrect = sum(x["incorrect"] for x in R)
    return {
        "a0": a0, "b0": b0, "mean": a0 / (a0 + b0), "nll": r["fx"], "iters": r["iters"], "sellers": len(R), "jobs": jobs,
        "incorrect": incorrect, "pooledRate": incorrect / jobs,
        "over30": len([x for x in R if x["incorrect"] / (x["correct"] + x["incorrect"]) > 0.3]) / len(R),
    }
