# Pump.fun Paper Sprint — Momentum Tape Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Bradestudio/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Bradestudio/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint bounty](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It replays pump.fun bonding curves and trades on momentum in each mint's own tape.

## How it works

- **Tape per mint:** every batch, each mint's trades are folded into one sample — price from virtual reserves, signed net SOL inflow (buys minus sells), buy count, and distinct buyers.
- **Entry:** a mint is bought only when it is at least 20 slots old, its last-10-sample window shows net inflow ≥ 1 SOL, ≥ 4 buys from ≥ 6 distinct buyers, price up 3–25% vs the window start, price ≥ 95% of the window high, and second-half inflow ≥ 2× first-half inflow.
- **Sizing:** first buy 0.03 SOL, adds of 0.02 SOL only to a winner (value above cost) while the signal holds and price is at or above the last buy, max 0.06 SOL per coin, max 5 open positions, max 16 orders per batch. One shot per mint: a coin that was exited is never re-bought.
- **Exits:** stop-loss below 92% of cost, take-profit at 120% of cost, trailing stop below 92% of peak once peak reached 108% of cost, max hold 300 slots, or flow fade (window net inflow < −0.5 SOL).
- **Pacing probe:** a capped backstop (max 25) that only fires when fewer than 20 coins have traded: one tiny 0.01 SOL round-trip on the most liquid recently-active curve, sold once the buy lands.
- **Deterministic:** no clock, no randomness, no environment reads — the same hello and batch stream always produce the same orders.

## Layout

- `main.ts` — the whole strategy (Node 22, runs as `node main.ts`).
- `vendor/makefun-bot.ts` — the kit's agent-fun/replay/v2 shim, copied byte-identical as the rules allow.

## Grade locally

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
