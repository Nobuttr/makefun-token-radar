[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Nobuttr/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Nobuttr/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Launch Radar

A token launch radar: a program that reads one frozen snapshot of the protocol universe
(DefiLlama's protocol index, 758 protocols at or above $5,000,000 of TVL) and writes a ranked
board of the launches worth farming before they exist, plus the dashboard that presents it.

A protocol is a **launch candidate** when the snapshot records no token for it (no market cap,
no CoinGecko id, no symbol) and it is not a wrapped, staked, bridged or exchange product of an
asset that already trades — the same reading the snapshot's own watchlist states, applied at
every TVL instead of only above the watchlist's $50,000,000 floor. The watchlist's 40 protocols
are all on the board; the radar adds every other candidate the record supports. Protocols that
record a token are set aside as live, with the market's own cap; pre-token products of a
trading asset are set aside as represented, each with the record signal that marks it.

## The model

Every candidate is scored by one stated chain of factors, each input a snapshot figure or a
constant printed here and in the dashboard:

- **Category multiple** — the median market-cap / TVL of the snapshot's own live-token
  protocols in the protocol's category, shrunk toward the global median by sample size and
  clamped to [0.03×, 2.5×]. Learned from the snapshot on every run: a future snapshot
  re-prices itself, and no protocol name is ever special-cased.
- **Launch FDV** = TVL × multiple.
- **Momentum** = 1 + clamp(7-day TVL change, −60%, +150%) × 0.35.
- **Maturity** = 0.75 + 0.35 × min(age, 4 years) / 4 years — the longer a protocol has run
  with no token on record, the more proven the launch. An unrecorded age counts as one year.
- **Pool** = FDV × momentum × maturity × community share (10–20% by category): the part of a
  launch that would reach the community.
- **Likelihood** = clamp(0.10 + 0.60·scale + 0.20·traction + 0.10·endurance, 0.05, 0.95),
  with scale TVL on a log ramp to $3B, traction the clamped 7-day change, endurance the age
  term above.
- **Implied value** = round(pool × likelihood): the expected value of the distribution a
  launch on the protocol's current record would make. The board ranks by it.

Each row also carries a six-step farm plan built from its own record — its category picks the
playbook, its chains pick the gas, its TVL picks the capital tier, its age picks the hold
window — and every step states what it costs and how long it takes.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22, standard library only, no network. The program writes `board.json` (the ranked
board), `data.js` (the dashboard's dataset), `dashboard/` and `screenshots/` (copied from
this repository) and `dossier.json` (built with `vendor/makefun-board.ts`, byte for byte what
make.fun's scorer rebuilds) into the output directory. It is deterministic: the same snapshot
writes the same bytes twice. Open `out/dashboard/index.html` to read the radar.

## Layout

- `main.ts` — the program: snapshot in, board, data, dashboard, screenshots and dossier out.
- `lib/model.ts` — the model: classification, multiples, the factor chain, the farm playbooks.
- `dashboard/` — the static page (index.html, app.css, app.js). It recomputes every row's
  implied value from the snapshot figures on the page, so the screen and the board cannot
  drift apart.
- `screenshots/` — the board, a protocol's detail view and a filtered view, captured from the
  dashboard rendered on this snapshot.
- `vendor/makefun-board.ts` — make.fun's dossier library, shipped byte for byte.

Implied value is this model's estimate from one frozen snapshot — not a prediction that a
token will exist, not a price, and not investment advice.
