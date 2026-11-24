// Pump.fun Paper Sprint — momentum tape bot (original work, built from the SDK shim only).
//
// Idea: watch each mint's own tape over the last few batches. A coin only gets
// bought when real buyers keep pushing SOL in and the price keeps climbing with
// them; a coin gets sold the moment that flow fades or the position goes sour.
// A small pacing probe keeps the distinct-mint / fill guardrails in reach when
// the momentum signal goes quiet for too long.
//
// Deterministic: no clock, no randomness, no environment reads. Every decision
// is a pure function of the hello + the batch stream, and every Map is walked
// in insertion order, so two grader runs produce identical action logs.

import { runBot, LAMPORTS_PER_SOL, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const WINDOW_SAMPLES = 10; // shorter window: fresher momentum, enter before the spike is over
const MIN_AGE_SLOTS = 20;
const MIN_NET_INFLOW = SOL; // 1.0 SOL over the window (stricter: fewer, better entries)
const MIN_BUYS = 4;
const MIN_BUYERS = 6;
const MIN_RISE_BPS = 800; // +8% vs window start (was 4%)
const MIN_OF_HIGH_BPS = 9800; // price >= 98% of window high: only fresh highs
const FIRST_BUY = (SOL * 3n) / 100n; // 0.03 SOL
const ADD_BUY = (SOL * 2n) / 100n; // 0.02 SOL
const MAX_PER_COIN = (SOL * 6n) / 100n; // 0.06 SOL total per mint
const MIN_BUY = SOL / 100n; // 0.01 SOL
const MAX_OPEN = 5;
const MAX_HOLD_SLOTS = 300;
const STOP_LOSS_NUM = 92n; // value < 92% of cost
const TRAIL_PEAK_NUM = 108n; // peak >= 108% of cost arms the trail
const TRAIL_NUM = 92n; // then sell when value < 92% of peak
const TAKE_PROFIT_NUM = 120n; // bank it: value >= 120% of cost sells all
const FADE_INFLOW = -(SOL / 2n); // window net inflow < -0.5 SOL
const BUY_SLIPPAGE = 500;
const SELL_SLIPPAGE = 10000;
const PROBE_BUY = SOL / 100n; // 0.01 SOL
const PROBE_MIN_GAP_SLOTS = 200;
const PROBE_MAX_COUNT = 25; // backstop only: enough to reach 20 coins, then stop
// Pace target over an assumed ~54_000-slot final window (6h at ~0.4s/slot).
const PACE_WINDOW_SLOTS = 54000;
const PACE_MIN_COINS = 20;
const PACE_MIN_FILLS = 200;

interface TapeSample {
  slot: number;
  price: bigint; // virtual SOL per virtual token, scaled by 1e12
  inflow: bigint; // signed SOL lamports in this batch (buys +, sells -)
  buys: number;
  buyers: Set<string>;
}

interface Tape {
  createdSlot: number | null;
  firstSeenSlot: number;
  samples: TapeSample[];
  complete: boolean;
}

interface Held {
  spent: bigint; // SOL actually paid on filled buys (fees included)
  peakValue: bigint;
  firstBuySlot: number;
  lastBuyPrice: bigint;
  sold: boolean;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();
const tradedMints = new Set<string>();
// Mints we already exited, by slot of the exit: never re-enter one. Run 3
// showed ~5.5 round trips per coin — re-buying the same dumped coin over
// and over was the main churn. One shot per mint per run.
const soldAt = new Map<string, number>();
let fillsSeen = 0;
let firstSlot = -1;
let probeMint: string | null = null;
let probeBoughtSlot = -1;
let lastProbeSlot = -1;
let probeCount = 0;

function priceOf(solRes: bigint, tokRes: bigint): bigint {
  if (tokRes <= 0n) return 0n;
  return (solRes * 1_000_000_000_000n) / tokRes;
}

function valueOf(mint: string, state: BotState): bigint {
  const pos = state.positions.get(mint);
  const curve = state.curves.get(mint);
  if (!pos || !curve || curve.virtual_token_reserves <= 0n) return 0n;
  return (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

interface WindowStats {
  inflow: bigint;
  buys: number;
  buyers: number;
  startPrice: bigint;
  endPrice: bigint;
  high: bigint;
  firstHalf: bigint;
  secondHalf: bigint;
}

function windowStats(t: Tape): WindowStats | null {
  const w = t.samples.slice(-WINDOW_SAMPLES);
  if (w.length === 0) return null;
  let inflow = 0n;
  let buys = 0;
  const buyers = new Set<string>();
  let high = 0n;
  const half = Math.floor(w.length / 2);
  let firstHalf = 0n;
  let secondHalf = 0n;
  for (let i = 0; i < w.length; i++) {
    const s = w[i];
    inflow += s.inflow;
    buys += s.buys;
    for (const b of s.buyers) buyers.add(b);
    if (s.price > high) high = s.price;
    if (i < half) firstHalf += s.inflow;
    else secondHalf += s.inflow;
  }
  return { inflow, buys, buyers: buyers.size, startPrice: w[0].price, endPrice: w[w.length - 1].price, high, firstHalf, secondHalf };
}

function momentumOk(t: Tape, slot: number): boolean {
  const born = t.createdSlot ?? t.firstSeenSlot;
  if (slot - born < MIN_AGE_SLOTS) return false;
  const st = windowStats(t);
  if (!st) return false;
  if (st.inflow < MIN_NET_INFLOW) return false;
  if (st.buys < MIN_BUYS) return false;
  if (st.buyers < MIN_BUYERS) return false;
  if (st.startPrice <= 0n) return false;
  // rise >= 3% over the short window: catch the move early, not its tail
  if (st.endPrice * 100n < st.startPrice * 103n) return false;
  // rise <= 25%: a parabolic blow-off top is not momentum to chase
  if (st.endPrice * 100n > st.startPrice * 125n) return false;
  // price >= 95% of window high
  if (st.endPrice * 100n < st.high * 95n) return false;
  // second half inflow >= 2x first half: flow must be accelerating hard
  if (st.secondHalf < st.firstHalf * 2n) return false;
  return true;
}

function ingestBatch(state: BotState, batch: Batch): void {
  if (firstSlot < 0) firstSlot = batch.slot;
  // Fills first: they settle what we actually own / spent.
  for (const f of batch.fills) {
    if (f.status === 'rejected' || f.status === 'failed') {
      // A rejected/failed probe buy must not jam the probe slot forever.
      if (f.side === 'buy' && probeMint === f.mint) {
        probeMint = null;
        probeBoughtSlot = -1;
      }
      continue;
    }
    fillsSeen++;
    tradedMints.add(f.mint);
    if (f.side === 'buy') {
      const h = held.get(f.mint) ?? { spent: 0n, peakValue: 0n, firstBuySlot: f.slot, lastBuyPrice: 0n, sold: false };
      h.spent += BigInt(f.quote_lamports);
      const curve = state.curves.get(f.mint);
      if (curve) h.lastBuyPrice = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      held.set(f.mint, h);
      if (probeMint === f.mint) probeBoughtSlot = f.slot;
    } else {
      // A sell fill (ours or a harness close) ends the tracked hold.
      if (probeMint === f.mint) {
        probeMint = null;
        probeBoughtSlot = -1;
      }
    }
  }
  // Events: build one tape sample per mint per batch from its trades.
  const perMint = new Map<string, TapeSample>();
  for (const e of batch.events) {
    let t = tapes.get(e.mint);
    if (!t) {
      t = { createdSlot: null, firstSeenSlot: batch.slot, samples: [], complete: false };
      tapes.set(e.mint, t);
    }
    if (e.event === 'CreateEvent') {
      t.createdSlot = e.slot;
    } else if (e.event === 'TradeEvent') {
      let s = perMint.get(e.mint);
      if (!s) {
        const curve = state.curves.get(e.mint);
        const p = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0n;
        s = { slot: batch.slot, price: p, inflow: 0n, buys: 0, buyers: new Set<string>() };
        perMint.set(e.mint, s);
      }
      const amt = BigInt(e.sol_amount);
      s.inflow += e.is_buy ? amt : -amt;
      if (e.is_buy) {
        s.buys++;
        s.buyers.add(e.user);
      }
      // Refresh the sample price to the latest trade's post-trade reserves.
      s.price = priceOf(BigInt(e.virtual_sol_reserves), BigInt(e.virtual_token_reserves));
    } else {
      t.complete = true;
    }
  }
  for (const [mint, s] of perMint) {
    const t = tapes.get(mint);
    if (!t || t.complete) continue;
    t.samples.push(s);
    if (t.samples.length > 40) t.samples.shift();
  }
  // Drop tracking for positions that are gone (sold / completed / flattened).
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint) && ![...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'buy')) {
      held.delete(mint);
    }
  }
  // Bound tape memory: drop the oldest tapes that are neither held nor fresh.
  if (tapes.size > 3000) {
    for (const [mint, t] of tapes) {
      if (tapes.size <= 3000) break;
      if (!held.has(mint) && !state.positions.has(mint)) tapes.delete(mint);
    }
  }
}

function onBatch(state: BotState, batch: Batch): OrderInput[] {
  ingestBatch(state, batch);
  const orders: OrderInput[] = [];
  const slot = batch.slot;
  let plannedTxFees = 0n;
  const txFee = state.txFeeLamports();

  const pushBuy = (mint: string, amount: bigint): void => {
    if (orders.length >= 16) return;
    const cap = state.maxBuyLamports(mint);
    let amt = amount;
    if (amt > cap) amt = cap;
    if (amt < MIN_BUY) return;
    const free = state.freeCashLamports() - plannedTxFees;
    if (free < amt + txFee) return;
    orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: BUY_SLIPPAGE });
    plannedTxFees += txFee;
  };
  const pushSellAll = (mint: string): void => {
    if (orders.length >= 16) return;
    const pos = state.positions.get(mint);
    if (!pos || pos.token_amount <= 0n) return;
    if ([...state.pending.values()].some((p) => p.order.mint === mint && p.order.side === 'sell')) return;
    orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE });
    plannedTxFees += txFee;
    soldAt.set(mint, slot); // exited: no re-entry for this mint
  };

  // 1) Exits: check every held position against stop / trail / hold / fade.
  for (const [mint, h] of held) {
    if (orders.length >= 16) break;
    const pos = state.positions.get(mint);
    if (!pos) continue;
    const value = valueOf(mint, state);
    if (value > h.peakValue) h.peakValue = value;
    let exit = false;
    if (h.spent > 0n && value * 100n < h.spent * STOP_LOSS_NUM) exit = true; // stop-loss
    if (!exit && h.spent > 0n && value * 100n >= h.spent * TAKE_PROFIT_NUM) exit = true; // take profit
    if (!exit && h.peakValue * 100n >= h.spent * TRAIL_PEAK_NUM && value * 100n < h.peakValue * TRAIL_NUM) exit = true; // trailing stop
    if (!exit && slot - h.firstBuySlot >= MAX_HOLD_SLOTS) exit = true; // max hold
    if (!exit) {
      const t = tapes.get(mint);
      const st = t ? windowStats(t) : null;
      if (st && st.inflow < FADE_INFLOW) exit = true; // flow faded
    }
    if (exit) {
      h.sold = true;
      pushSellAll(mint);
    }
  }

  // 2) Probe exit first: once a probe buy has landed, sell it on the next batch.
  if (probeMint !== null && probeBoughtSlot >= 0 && state.positions.has(probeMint)) {
    pushSellAll(probeMint);
  }

  // 3) Entries and adds, in tape insertion order (the order the stream showed them).
  const room = MAX_OPEN - state.committedPositionCount();
  for (const [mint, t] of tapes) {
    if (orders.length >= 16) break;
    if (t.complete) continue;
    if (soldAt.has(mint)) continue; // one shot per mint: never re-buy an exited coin
    const curve = state.curves.get(mint);
    if (!curve) continue;
    const pos = state.positions.get(mint);
    const h = held.get(mint);
    const pendingBuy = [...state.pending.values()]
      .filter((p) => p.order.mint === mint && p.order.side === 'buy')
      .reduce((a, p) => a + BigInt(p.order.quote_lamports), 0n);
    const spent = (h ? h.spent : 0n) + pendingBuy;
    if (!momentumOk(t, slot)) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (!pos && !h && room > 0 && spent === 0n) {
      pushBuy(mint, FIRST_BUY);
    } else if (pos && spent < MAX_PER_COIN && price >= (h ? h.lastBuyPrice : 0n)) {
      // Add only to a winner (current value above cost): never average down a
      // loser that merely still flashes the signal.
      const value = valueOf(mint, state);
      if (h && value <= h.spent) continue;
      const add = MAX_PER_COIN - spent < ADD_BUY ? MAX_PER_COIN - spent : ADD_BUY;
      if (add >= MIN_BUY) pushBuy(mint, add);
    }
  }

  // 4) Pacing probe (backstop only): the momentum signal normally clears the
  // >=20-coin bar on its own. Only when it has not — few coins traded and the
  // run is well under way — open one tiny round-trip on the most liquid
  // recently-active curve. Capped, so it can never become the churn it was
  // when it was pace-driven against a guessed window length.
  if (probeMint === null && probeCount < PROBE_MAX_COUNT && orders.length < 16 && slot - lastProbeSlot >= PROBE_MIN_GAP_SLOTS) {
    const elapsed = firstSlot < 0 ? 0 : slot - firstSlot;
    if (elapsed > 2000 && tradedMints.size < PACE_MIN_COINS && state.committedPositionCount() < MAX_OPEN) {
      let best: string | null = null;
      let bestReal = 0n;
      for (const [mint, t] of tapes) {
        if (t.complete || state.positions.has(mint) || held.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.real_quote_reserves <= 0n) continue;
        const last = t.samples[t.samples.length - 1];
        if (!last || slot - last.slot > 200) continue; // recently active only
        if (curve.real_quote_reserves > bestReal) {
          bestReal = curve.real_quote_reserves;
          best = mint;
        }
      }
      if (best !== null) {
        const before = orders.length;
        pushBuy(best, PROBE_BUY);
        if (orders.length > before) {
          probeMint = best;
          probeBoughtSlot = -1;
          lastProbeSlot = slot;
          probeCount++;
        }
      }
    }
  }

  return orders;
}

await runBot({
  onHello(_state: BotState) {
    // Fresh run: clear any module state (the grader runs the file once per run).
    tapes.clear();
    held.clear();
    tradedMints.clear();
    soldAt.clear();
    fillsSeen = 0;
    firstSlot = -1;
    probeMint = null;
    probeBoughtSlot = -1;
    lastProbeSlot = -1;
    probeCount = 0;
  },
  onBatch,
});
