"""jev-wilson/margin: the one resale price rule, 20 % over the seller's price (_MARGIN_OVER_SELLER_v1_).

Integers only; the same units as the TypeScript (src/margin.ts) and Solidity (solidity/src/Margin.sol) on
tests/vectors/margin-grid.json. Our fee rounds UP over the seller price (the seller is never paid less than its price); a seller
price of 0 is our own product and lists at OWN_FLOOR_UNITS; the seller's part of a market-set list rounds DOWN.
"""

BPS = 10_000
MARGIN_BPS = 2_000
OWN_FLOOR_UNITS = 2_000


def _amount(x, what):
    if not isinstance(x, int) or isinstance(x, bool) or x < 0:
        raise ValueError(f"{what} must be a non-negative int")
    return x


def margin_fee(seller_price):
    """Our fee over a seller price: ceil(S x 2000 / 10000); 0 lists at OWN_FLOOR_UNITS."""
    s = _amount(seller_price, "seller_price")
    if s == 0:
        return OWN_FLOOR_UNITS
    return (s * MARGIN_BPS + BPS - 1) // BPS


def list_price(seller_price):
    """The seller price plus our fee (1000 -> 1200)."""
    return _amount(seller_price, "seller_price") + margin_fee(seller_price)


def seller_part(list_units):
    """The seller's part of a list the market set: floor(L x 10000 / 12000) (1250 -> 1041)."""
    return _amount(list_units, "list") * BPS // (BPS + MARGIN_BPS)


def fee_of_list(list_units):
    """Our fee out of a list the market set: L - seller_part(L) (1250 -> 209)."""
    return _amount(list_units, "list") - seller_part(list_units)
