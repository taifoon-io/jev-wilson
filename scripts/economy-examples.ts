// node --experimental-strip-types scripts/economy-examples.ts [--md]
// The README's worked examples ("The economy, from the record"), printed by quoteEconomyFor from calibration/8453.json:
// records 1/20, 5/100, 50/1000, 500/10000 (failed / graded) for 1, 10 and 100 USDC jobs on Base. Nothing typed by hand.
import { readFileSync } from 'node:fs';
import { quoteEconomyFor } from '../src/calibration.ts';

const BASE = JSON.parse(readFileSync(new URL('../calibration/8453.json', import.meta.url), 'utf8'));
const usd = (u: bigint) => (Number(u) / 1e6).toFixed(6);
const records: [number, number][] = [[1, 20], [5, 100], [50, 1_000], [500, 10_000]];
const prices = [1n, 10n, 100n];

function table(title: string, opts: { lockSeconds?: number; arbitrator?: boolean }) {
  const lines = [`**${title}**`, '',
    '| record (failed/graded) | price | Wilson bound W | backers need L | fee F | premium | backers | layer | deposit | compensation | cover |',
    '|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|'];
  for (const [f, n] of records) for (const p of prices) {
    const q = quoteEconomyFor(BASE, { price: p * 1_000_000n, record: { correct: n - f, incorrect: f }, ...opts });
    lines.push(`| ${f}/${n.toLocaleString('en-US')} | ${p} | ${usd(q.basis.wilson)} | ${usd(q.basis.lp)} | ${usd(q.basis.fee)} | ${usd(q.premium)} | ${usd(q.toBackers)} | ${usd(q.toLayer)} | ${usd(q.deposit)} | ${usd(q.compensation)} | ${q.covered ? 'sold' : q.reason} |`);
  }
  return lines.join('\n');
}

console.log(table('Base, cover locked 7 days, an arbitrator on the hook (the owner’s 2026-10-06 setting)', { lockSeconds: 7 * 86_400, arbitrator: true }));
console.log('');
console.log(table(`Base, the calibration's own setting (lock ${BASE.premium.lockSeconds} s, arbitrator ${BASE.premium.arbitrator})`, {}));
console.log('');
console.log(`USDC. F = jobFee on the calibration's gas snapshot (block ${BASE.gas_snapshot.block}), stand-in profile; calibration v${BASE.version}, digest ${BASE.digest}.`);
