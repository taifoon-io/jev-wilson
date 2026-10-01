// jev-wilson/prior: the market prior Beta(a0, b0) on a seller's failure rate, fitted by maximum likelihood (Beta-Binomial)
// to every seller's record (correct and incorrect jobs under the seller-verdict rule). lpPremium() uses it as LpParams.a0/b0.
// Pure. The Python twin (python/taifoon_jev_wilson/prior.py) runs the same Lanczos log-gamma and the same Nelder-Mead
// steps; tests/vectors/prior-fit.json holds both answers (they agree to 1e-9).
import type { LpRecord } from './lp.ts';

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ln B(a, b). */
export const lbeta = (a: number, b: number): number => lgamma(a) + lgamma(b) - lgamma(a + b);

/** The negative log-likelihood of Beta(a, b) on the records (the binomial coefficients are left out: they do not depend on a, b). */
export function betaBinomialNll(records: readonly LpRecord[], a: number, b: number): number {
  let s = 0;
  const lb = lbeta(a, b);
  for (const r of records) s -= lbeta(r.incorrect + a, r.correct + b) - lb;
  return s;
}

/** Nelder-Mead on R², fixed coefficients (1, 2, 0.5, 0.5), the same steps in both languages. */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { step?: number; xtol?: number; ftol?: number; maxIter?: number } = {}): { x: number[]; fx: number; iters: number } {
  const step = opts.step ?? 0.5, xtol = opts.xtol ?? 1e-10, ftol = opts.ftol ?? 1e-12, maxIter = opts.maxIter ?? 5_000;
  const n = x0.length;
  let simplex: number[][] = [x0.slice()];
  for (let i = 0; i < n; i++) { const p = x0.slice(); p[i] = p[i]! + step; simplex.push(p); }
  let fs = simplex.map(f);
  let it = 0;
  for (; it < maxIter; it++) {
    const order = fs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]).map((p) => p[1]);
    simplex = order.map((i) => simplex[i]!); fs = order.map((i) => fs[i]!);
    let spread = 0;
    for (let i = 1; i <= n; i++) for (let j = 0; j < n; j++) spread = Math.max(spread, Math.abs(simplex[i]![j]! - simplex[0]![j]!));
    if (spread <= xtol && Math.abs(fs[n]! - fs[0]!) <= ftol) break;
    const c = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] = c[j]! + simplex[i]![j]! / n;
    const at = (t: number) => c.map((cj, j) => cj + t * (simplex[n]![j]! - cj));
    const xr = at(-1); const fr = f(xr);
    if (fr < fs[0]!) {
      const xe = at(-2); const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; fs[n] = fe; } else { simplex[n] = xr; fs[n] = fr; }
    } else if (fr < fs[n - 1]!) {
      simplex[n] = xr; fs[n] = fr;
    } else {
      const outside = fr < fs[n]!;
      const xc = at(outside ? -0.5 : 0.5); const fc = f(xc);
      if (fc < (outside ? fr : fs[n]!)) { simplex[n] = xc; fs[n] = fc; }
      else {
        for (let i = 1; i <= n; i++) { simplex[i] = simplex[i]!.map((v, j) => simplex[0]![j]! + 0.5 * (v - simplex[0]![j]!)); fs[i] = f(simplex[i]!); }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (fs[i]! < fs[best]!) best = i;
  return { x: simplex[best]!, fx: fs[best]!, iters: it };
}

export type PriorFit = {
  a0: number; b0: number; mean: number; nll: number; iters: number;
  sellers: number; jobs: number; incorrect: number; pooledRate: number;
  /** the share of sellers whose own observed rate is above 30 % */ over30: number;
};

/** Fit Beta(a0, b0) to the records with at least one decided job. Pure. */
export function fitPrior(records: readonly LpRecord[]): PriorFit {
  const R = records.filter((r) => r.correct + r.incorrect > 0);
  if (R.length < 2) throw new RangeError('fitPrior needs at least two sellers with a decided job');
  const r = nelderMead((x) => betaBinomialNll(R, Math.exp(x[0]!), Math.exp(x[1]!)), [0, 1]);
  const a0 = Math.exp(r.x[0]!), b0 = Math.exp(r.x[1]!);
  const jobs = R.reduce((s, x) => s + x.correct + x.incorrect, 0);
  const incorrect = R.reduce((s, x) => s + x.incorrect, 0);
  return {
    a0, b0, mean: a0 / (a0 + b0), nll: r.fx, iters: r.iters, sellers: R.length, jobs, incorrect, pooledRate: incorrect / jobs,
    over30: R.filter((x) => x.incorrect / (x.correct + x.incorrect) > 0.3).length / R.length,
  };
}
