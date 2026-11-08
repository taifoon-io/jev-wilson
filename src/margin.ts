// jev-wilson/margin: the one resale price rule of the coordination layer (_MARGIN_OVER_SELLER_v1_, owner 2026-10-24: "always
// apply 20 % margin", 20 % OVER the seller's price). Pure, integers only (bigint, the token's smallest unit). The Python twin
// (python/taifoon_jev_wilson/margin.py) and the Solidity library (solidity/src/Margin.sol) return the same units on
// tests/vectors/margin-grid.json; every other copy of the rule (the resale payment scheme's wall fee, the site's vendored copy of it,
// the coordination layer's route and listing emitters) is tested against that grid, so there is one definition.
//
//   from a seller price S (we resell S, the seller is paid S on its own venue)
//     fee  = ceil(S × 2,000 / 10,000)       our fee rounds UP: the seller is never paid less than its price
//     list = S + fee                        1,000 → 1,200
//     S = 0 is our own product (nothing owed outside): it lists at OWN_FLOOR_UNITS, all of it our fee
//   from a list price L the market set (a resale at an observed price)
//     seller = floor(L × 10,000 / 12,000)   1,250 → 1,041; the seller's share never exceeds floor(paid / 1.2)
//     fee    = L − seller                   209
//   listPrice(sellerPart(listPrice(S))) = listPrice(S) and sellerPart(listPrice(S)) = S for every S > 0.

export const BPS = 10_000;
/** our fee over the seller's price, in basis points of that price */
export const MARGIN_BPS = 2_000;
/** the list price of our own product (a seller price of 0): 0.002 of a 6-decimal token */
export const OWN_FLOOR_UNITS = 2_000n;

function amount(x: bigint, what: string): bigint {
  if (typeof x !== 'bigint' || x < 0n) throw new RangeError(`${what} must be a non-negative bigint`);
  return x;
}

/** Our fee over a seller price: 20 % of it rounded up; our own product (0) lists at OWN_FLOOR_UNITS. */
export function marginFee(sellerPrice: bigint): bigint {
  const s = amount(sellerPrice, 'sellerPrice');
  if (s === 0n) return OWN_FLOOR_UNITS;
  return (s * BigInt(MARGIN_BPS) + BigInt(BPS) - 1n) / BigInt(BPS);
}

/** What the buyer pays where no venue takes anything: the seller price plus our fee. */
export function listPrice(sellerPrice: bigint): bigint {
  return amount(sellerPrice, 'sellerPrice') + marginFee(sellerPrice);
}

/** The seller's part of a list price the market set (the releaser's bound on a seller share). */
export function sellerPart(list: bigint): bigint {
  return (amount(list, 'list') * BigInt(BPS)) / BigInt(BPS + MARGIN_BPS);
}

/** Our fee out of a list price the market set: list − sellerPart(list). */
export function feeOfList(list: bigint): bigint {
  return amount(list, 'list') - sellerPart(list);
}

export type MarginTerms = { seller: bigint; fee: bigint; list: bigint };

/** The three numbers a wall shows, from the seller price. */
export function marginTerms(sellerPrice: bigint): MarginTerms {
  const fee = marginFee(sellerPrice);
  return { seller: sellerPrice, fee, list: sellerPrice + fee };
}
