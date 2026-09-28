#!/usr/bin/env bash
# npm test: the TypeScript, Python and Solidity tests, all on tests/vectors/premium-grid.json.
# Python and Solidity are skipped (with a line saying so) when pytest or forge is not installed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== TypeScript"
node --experimental-strip-types --no-warnings --test tests/*.test.ts

echo "== Python"
if command -v python3 >/dev/null && python3 -c 'import pytest' 2>/dev/null; then
  python3 -m pytest tests -q -rs
else
  echo "SKIPPED Python: pytest not installed (pip install pytest)"
fi

echo "== Solidity"
if command -v forge >/dev/null; then
  (cd solidity && forge test)
else
  echo "SKIPPED Solidity: forge not installed (https://getfoundry.sh)"
fi
