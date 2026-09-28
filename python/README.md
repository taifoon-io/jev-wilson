# taifoon-jev-wilson

Price assurance from a seller's record: the Wilson score interval on delivered and failed jobs, mapped to a coverage premium for the next job. Same numbers as the npm package `@taifoon/jev-wilson`, bit for bit.

```sh
pip install "git+https://github.com/taifoon-io/jev-wilson#subdirectory=python"   # PyPI soon
```

```py
from taifoon_jev_wilson import wilson_lower, premium

wilson_lower(60, 62)                                  # 0.8897953040501456
premium({"k": 60, "n": 62}, price=10 * 10**18)
# {'insurable': True, 'ratio': 0.11020469594985441, 'amount': 1102050000000000000, 'covered': True, 'basis': 'record'}
```

Optional grading goes through TypeSafe AI's own SDK: `pip install "taifoon-jev-wilson[jev]"`, then
`grade(state, client=typesafe_sdk.TypeSafeClient())` asks the four RUBRIC_v1 questions pinned to `jev-1.13.0`.

Bit for bit with the npm package `@taifoon/jev-wilson` and with the Taifoon coordination layer's quotes.
Source, vectors and the frozen curve: https://github.com/taifoon-io/jev-wilson

Independent project. Jev and TypeSafe are products of TypeSafe AI, Inc., which does not endorse this package.

Apache-2.0.
