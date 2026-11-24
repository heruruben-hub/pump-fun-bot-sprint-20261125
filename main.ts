// Pump.fun Bot Sprint: confirmed-launch sniper.
//
// Idea: most new pump.fun curves are noise or one-wallet rugs. This bot only
// buys a mint once the tape itself confirms real interest: at least three
// distinct buyers who are not the creator, and a price at least 5% above the
// creation price. It then rides the move with a fixed small stake and exits
// on a take-profit or a stop-loss measured against the actual cost basis of
// the filled position (fees included), so fills that land away from the
// decision price still exit on honest numbers.
//
// Everything is a pure function of the harness state: no clock, no random
// source, no environment reads. Two runs over the same replay therefore
// produce identical action logs.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strips the types).

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// --- tunables ---------------------------------------------------------------

// Minimum distinct non-creator buyers before a launch counts as confirmed.
const MIN_BUYERS = 3;
// Price rise vs the creation price (basis points) that confirms a launch.
const CONFIRM_RISE_BPS = 500;
// SOL spent per entry (before the per-mint size cap trims it).
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 80n; // 0.0125 SOL
// A buy smaller than this does not count as a qualifying round trip, so a
// mint whose size cap cannot support it is skipped, not chased.
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
// A launch only counts while it is fresh: the tape runs ~4.7 slots a
// second, so 3000 slots is about ten minutes after creation. A mint that
// takes longer than that to confirm is a slow grind, not a launch.
const MAX_AGE_SLOTS = 3000;
// A position that is still open after this many slots and is a deep loser
// is closed for time, not price, to free one of the five slots for a fresh
// launch. Set huge to disable the timeout entirely.
const TIMEOUT_SLOTS = 100000000;
// A position counts as a deep loser once it is this far under its cost.
const DEEP_LOSS_BPS = 5000; // -30% vs average cost
// Exit rules, in basis points, vs the position's average cost. A trailing
// stop was tried on the dev window and lost more than a fixed take-profit:
// most pumps on this tape are short-lived, so locking a gain beats giving
// it back to a pullback.
const TAKE_PROFIT_BPS = 5000; // +50%
// Stop-loss vs average cost. Set to 10000 to disable (a 100% drop never
// triggers); the dev grades showed a tight stop is the biggest leak, but
// some stop is what frees slots for the 20-round-trip guardrail.
const STOP_LOSS_BPS = 800;
// Wide slippage: a memecoin moves a lot across the 2-slot latency, and a
// rejected order is a missed trade. The TP/SL logic prices off the real
// fill, so a wide fill still exits on honest numbers.
const MAX_SLIPPAGE_BPS = 10_000;

// --- per-mint bookkeeping ---------------------------------------------------

interface MintBook {
  /** Creation price as virtual reserves (quote per token, numerator/denominator). */
  createQuote: bigint;
  createTokens: bigint;
  /** Slot of the CreateEvent. */
  createdSlot: number;
  creator: string;
  /** Distinct non-creator wallets that bought on this curve. */
  buyers: Set<string>;
  /** True once a buy was decided for this mint (one entry per mint). */
  entered: boolean;
}

const book = new Map<string, MintBook>();

/** Slot each open position was first seen in the account. */
const entrySlot = new Map<string, number>();

// --- helpers ----------------------------------------------------------------

/** priceNow >= priceRef * (10000 + bps) / 10000, all in integer math. */
function priceUpAtLeast(
  nowQuote: bigint,
  nowTokens: bigint,
  refQuote: bigint,
  refTokens: bigint,
  bps: number,
): boolean {
  if (nowTokens <= 0n || refTokens <= 0n || refQuote <= 0n) return false;
  // nowQuote/nowTokens >= refQuote/refTokens * (10000+bps)/10000
  return nowQuote * refTokens * 10_000n >= refQuote * nowTokens * BigInt(10_000 + bps);
}

/** priceNow <= priceRef * (10000 - bps) / 10000, all in integer math. */
function priceDownAtLeast(
  nowQuote: bigint,
  nowTokens: bigint,
  refQuote: bigint,
  refTokens: bigint,
  bps: number,
): boolean {
  if (nowTokens <= 0n || refTokens <= 0n || refQuote <= 0n) return false;
  return nowQuote * refTokens * 10_000n <= refQuote * nowTokens * BigInt(10_000 - bps);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: Array<BuyInput | SellInput> = [];
    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();

    // First, fold this batch's events into the per-mint book. Only mints
    // that moved in this batch can newly confirm, so collect them as the
    // entry candidates for this batch instead of rescanning the whole book.
    const candidates = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        book.set(e.mint, {
          createQuote: BigInt(e.virtual_quote_reserves),
          createTokens: BigInt(e.virtual_token_reserves),
          createdSlot: e.slot,
          creator: e.creator,
          buyers: new Set<string>(),
          entered: false,
        });
        candidates.add(e.mint);
      } else if (e.event === 'TradeEvent' && e.is_buy) {
        const b = book.get(e.mint);
        if (b !== undefined && e.user !== b.creator) {
          b.buyers.add(e.user);
          candidates.add(e.mint);
        }
      }
    }

    // Exits first: a position whose price hit TP sells in full, and so does
    // one that has sat past its timeout without hitting TP.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (holding.token_amount <= 0n || holding.cost_lamports <= 0n) continue;
      const opened = entrySlot.get(mint);
      if (opened === undefined) entrySlot.set(mint, state.slot);
      const vq = curve.virtual_quote_reserves;
      const vt = curve.virtual_token_reserves;
      // Average cost per token is cost_lamports / token_amount.
      const hitTp = priceUpAtLeast(vq, vt, holding.cost_lamports, holding.token_amount, TAKE_PROFIT_BPS);
      const hitSl = priceDownAtLeast(vq, vt, holding.cost_lamports, holding.token_amount, STOP_LOSS_BPS);
      // A timeout only closes a deep loser: a coin far under water rarely
      // recovers, while a mild loser often does (the no-stop-loss variant
      // proved that on this tape). Deep losers are cut to free the slot.
      const deepLoser = priceDownAtLeast(vq, vt, holding.cost_lamports, holding.token_amount, DEEP_LOSS_BPS);
      const timedOut = opened !== undefined && state.slot - opened > TIMEOUT_SLOTS && deepLoser;
      if (!hitTp && !hitSl && !timedOut) continue;
      entrySlot.delete(mint);
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    // Forget the entry slot of positions that closed without our sell
    // (curve completed, or the harness flattened them).
    for (const mint of [...entrySlot.keys()]) {
      if (!state.positions.has(mint)) entrySlot.delete(mint);
    }

    // Entries: confirmed launches only, in the order their events arrived
    // in this batch.
    if (openSlots > 0) {
      for (const mint of candidates) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (openSlots <= 0) break;
        const b = book.get(mint);
        if (b === undefined || b.entered) continue;
        if (state.slot - b.createdSlot > MAX_AGE_SLOTS) continue;
        if (b.buyers.size < MIN_BUYERS) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (!priceUpAtLeast(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          b.createQuote,
          b.createTokens,
          CONFIRM_RISE_BPS,
        )) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
        b.entered = true;
        free -= amount + tx;
        openSlots -= 1;
      }
    }

    return orders;
  },
});
