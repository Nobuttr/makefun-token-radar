// Launch Radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks launch candidates: protocols that record no token in the snapshot and are not a
// wrapped, staked, bridged or exchange product of an asset that already trades. The snapshot's
// watchlist is a floor, never a ceiling: every watchlist slug is a candidate by the house's own
// rule, and the radar adds every other candidate the record supports, at any TVL the snapshot
// carries (its floor is $5,000,000). Protocols that record a token are set aside as live, with the
// market's own cap; pre-token products of a trading asset are set aside as represented, each with
// the record signal that marks it. Both sets stay visible in the dashboard, apart from the ranking.
//
// Implied value is one stated chain of factors, every input a snapshot figure or a constant the
// dashboard prints:
//
//   multiple    the median market-cap / TVL of the snapshot's own live-token protocols in the
//               protocol's category, shrunk toward the global median by the sample size and
//               clamped to [0.03, 2.5]: what this snapshot's market pays for a dollar of TVL in
//               this kind of protocol, learned from the snapshot, never a hand-kept list
//   launch_fdv  tvl_usd x multiple
//   momentum    1 + clamp(change_7d, -60, 150) / 100 x 0.35 (an unreported change counts as 0)
//   maturity    0.75 + 0.35 x min(age_days, 1460) / 1460 (an unlisted age counts as 365 days):
//               the longer a protocol has run with no token on record, the more proven the launch
//   pool        launch_fdv x momentum x maturity x community_share, the share of a launch that
//               reaches the community, by category group (COMMUNITY_SHARE below)
//   likelihood  0.10 + 0.60 x scale + 0.20 x traction + 0.10 x endurance, clamped to [0.05, 0.95],
//               where scale is TVL on a log ramp from the snapshot floor to $3B, traction is the
//               clamped seven-day change on [0, 1] and endurance is min(age_days, 1460) / 1460
//   implied     round(pool x likelihood): the expected value of the distribution a launch on the
//               protocol's current record would make, weighted by the chance it happens at all
//
// No protocol name is ever special-cased: the same functions score every row, and the page
// recomputes each row from the same figures, so the board and the code cannot drift apart.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'launch-radar-2';

/** The model's stated constants, printed in the dashboard's methodology section. */
export const MODEL = {
  /** A category multiple is trusted in proportion to its live sample, against this many phantom global samples. */
  shrink_samples: 4,
  multiple_floor: 0.03,
  multiple_cap: 2.5,
  growth_floor_pct: -60,
  growth_cap_pct: 150,
  momentum_weight: 0.35,
  maturity_base: 0.75,
  maturity_range: 0.35,
  maturity_days: 1460,
  unknown_age_days: 365,
  likelihood_base: 0.1,
  likelihood_scale_weight: 0.6,
  likelihood_traction_weight: 0.2,
  likelihood_endurance_weight: 0.1,
  likelihood_floor: 0.05,
  likelihood_cap: 0.95,
  /** The top of the likelihood's TVL ramp: a protocol at this TVL gets the full scale term. */
  scale_top_usd: 3_000_000_000,
} as const;

/**
 * The share of a launch's value that reaches the community, by category group. Points-driven
 * categories distribute the most; vault and curator products the least, because their users are
 * already paid in yield. Any category not named takes the default.
 */
export const COMMUNITY_SHARE: Record<string, number> = {
  Dexs: 0.18,
  Derivatives: 0.18,
  'Interest Rate Derivatives': 0.15,
  Options: 0.15,
  Lending: 0.15,
  CDP: 0.12,
  'CDP Manager': 0.12,
  'Prediction Market': 0.2,
  Launchpad: 0.2,
  Yield: 0.12,
  'Yield Aggregator': 0.1,
  Farm: 0.15,
  'Leveraged Farming': 0.12,
  'Risk Curators': 0.1,
  'Onchain Capital Allocator': 0.1,
  'Liquidity Manager': 0.1,
  'Basis Trading': 0.1,
  Restaking: 0.12,
  'Staking Pool': 0.1,
  RWA: 0.1,
  Chain: 0.15,
  Payments: 0.12,
  Indexes: 0.1,
};
export const COMMUNITY_SHARE_DEFAULT = 0.12;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const bySlugAsc = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records a token: a market cap, a CoinGecko id or a symbol, any one of them. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** The snapshot README's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word that marks a wrapped or staked product of another asset. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** An exchange's own name at the head of a product's name. */
const EXCHANGE_HEAD = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** Categories that are products of another asset or an exchange's own book, never a launch of their own. */
const PRODUCT_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Cross Chain Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/**
 * Why a pre-token protocol is a product of an asset that already trades, or null when it is a
 * launch candidate of its own. The signals are the snapshot README's own: the house's watchlist
 * leaves these protocols out for exactly these reasons, and the radar applies the same reading
 * at every TVL, not only above the watchlist floor.
 */
export function representedReason(p: SnapshotProtocol): string | null {
  const category = p.category ?? '';
  if (PRODUCT_CATEGORIES.has(category)) {
    if (category === 'CEX') return 'an exchange’s own book: its balances are the exchange’s, and any token is the exchange’s to issue';
    if (category.includes('Staking') || category.includes('Restaking') || category === 'Restaked BTC') {
      return 'a staking product of an asset that already trades: the position is the asset, restated';
    }
    return 'a bridge product: it moves assets that already trade, and a bridge of a trading asset is not a launch of its own';
  }
  if (VERSIONED_NAME.test(p.name)) return 'a versioned pool of another protocol: the name ends in a release marker';
  if (WRAPPED_WORD.test(p.name)) return 'a wrapped or staked product of an asset that already trades, by its own name';
  if (EXCHANGE_HEAD.test(p.name)) return 'an exchange’s product by its own name: any launch is the exchange’s, not this product’s';
  return null;
}

/** Whether a protocol is a launch candidate the board ranks: no token on record, and not a product of one that trades. */
export function isCandidate(p: SnapshotProtocol): boolean {
  return !recordsToken(p) && representedReason(p) === null;
}

/** One category's live multiple: the sample behind it, its raw median and the shrunk value the model uses. */
export interface CategoryMultiple {
  category: string;
  samples: number;
  median: number | null;
  used: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The multiples the model uses, learned from the snapshot itself: for every category, the median
 * market-cap / TVL of its live-token protocols, shrunk toward the global median in proportion to
 * the sample, then clamped. A category with no live sample uses the global median outright.
 */
export function categoryMultiples(snapshot: Snapshot): { table: CategoryMultiple[]; globalMedian: number } {
  const liveRatios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (!recordsToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(ratio) || ratio <= 0) continue;
    const category = p.category ?? 'Uncategorised';
    const list = liveRatios.get(category) ?? [];
    list.push(ratio);
    liveRatios.set(category, list);
    all.push(ratio);
  }
  const globalMedian = all.length > 0 ? median(all) : 0.2;
  const categories = new Set<string>();
  for (const p of snapshot.protocols) categories.add(p.category ?? 'Uncategorised');
  const table: CategoryMultiple[] = [...categories].sort(bySlugAsc).map((category) => {
    const samples = liveRatios.get(category) ?? [];
    if (samples.length === 0) return { category, samples: 0, median: null, used: round4(clamp(globalMedian, MODEL.multiple_floor, MODEL.multiple_cap)) };
    const raw = median(samples);
    const shrunk = (samples.length * raw + MODEL.shrink_samples * globalMedian) / (samples.length + MODEL.shrink_samples);
    return { category, samples: samples.length, median: round4(raw), used: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)) };
  });
  return { table, globalMedian: round4(globalMedian) };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The community share a category takes at a launch. */
export function communityShare(category: string | null): number {
  return COMMUNITY_SHARE[category ?? ''] ?? COMMUNITY_SHARE_DEFAULT;
}

/** A candidate's scored factors, before ranking. */
export interface Scored {
  protocol: SnapshotProtocol;
  age_days: number | null;
  multiple: number;
  launch_fdv_usd: number;
  momentum: number;
  maturity: number;
  pool_usd: number;
  likelihood: number;
  implied_value_usd: number;
}

/** Score one candidate protocol: the factor chain the dashboard prints, in order. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, multiples: Map<string, number>, globalMedian: number): Scored {
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? MODEL.unknown_age_days;
  const multiple = multiples.get(p.category ?? 'Uncategorised') ?? clamp(globalMedian, MODEL.multiple_floor, MODEL.multiple_cap);
  const launchFdv = p.tvl_usd * multiple;
  const growthPct = clamp(finite(p.change_7d, 0), MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const momentum = 1 + (growthPct / 100) * MODEL.momentum_weight;
  const endurance = clamp(ageForModel, 0, MODEL.maturity_days) / MODEL.maturity_days;
  const maturity = MODEL.maturity_base + MODEL.maturity_range * endurance;
  const pool = launchFdv * momentum * maturity * communityShare(p.category);
  const scale = clamp(Math.log10(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log10(MODEL.scale_top_usd / 5_000_000), 0, 1);
  const traction = (growthPct - MODEL.growth_floor_pct) / (MODEL.growth_cap_pct - MODEL.growth_floor_pct);
  const likelihood = clamp(
    MODEL.likelihood_base + MODEL.likelihood_scale_weight * scale + MODEL.likelihood_traction_weight * traction + MODEL.likelihood_endurance_weight * endurance,
    MODEL.likelihood_floor,
    MODEL.likelihood_cap,
  );
  return {
    protocol: p,
    age_days: age,
    multiple,
    launch_fdv_usd: Math.round(launchFdv),
    momentum: round4(momentum),
    maturity: round4(maturity),
    pool_usd: Math.round(pool),
    likelihood: round4(likelihood),
    implied_value_usd: Math.max(1, Math.round(pool * likelihood)),
  };
}

// ---------------------------------------------------------------- farm plans
//
// A candidate's farm plan is built from its own record: its category picks the playbook, its
// chains pick where the gas is paid and what it costs, its TVL picks the capital tier a position
// needs to register, and its age picks the hold window. Every step states its cost and its time;
// the board carries the steps as plain strings, the page splits the cost and time back out.

/** A farm step before it is flattened: the action, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** How expensive gas is on a chain, in the words a farmer budgets with: a tier and a per-action dollar figure. */
function gasFor(chain: string): { tier: string; usd: number } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { tier: 'Ethereum mainnet', usd: 9 };
  if (c === 'bitcoin') return { tier: 'Bitcoin', usd: 4 };
  if (c === 'solana') return { tier: 'Solana', usd: 1 };
  if (c === 'tron' || c === 'binance' || c === 'bsc') return { tier: chain, usd: 1 };
  return { tier: `${chain} (a low-fee chain)`, usd: 1 };
}

/** The capital a qualifying position needs, from the protocol's own TVL: bigger protocols dilute small wallets. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 500;
  if (p.tvl_usd >= 500_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: a young protocol needs the longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category playbooks: the core action and the weekly qualifying action, in a farmer's words. */
interface Playbook {
  open: (name: string, chain: string, capital: number) => string;
  weekly: (name: string) => string;
  second: (name: string, chain: string) => string;
}

const PLAYBOOKS: { match: (category: string) => boolean; book: Playbook }[] = [
  {
    match: (c) => c.includes('dex'),
    book: {
      open: (n, ch, k) => `Swap about $${Math.round(k / 5)} of ETH or a stablecoin on ${n} on ${ch}, then provide the rest of the $${k} as liquidity in its most-traded pair`,
      weekly: (n) => `Make two swaps of $25 or more on ${n} and leave the liquidity in place; volume plus time in the pool is what a points season counts`,
      second: (n, ch) => `Open ${n}'s governance or points page from the app itself and link the same wallet, so swaps, liquidity and any vote sit under one address`,
    },
  },
  {
    match: (c) => c.includes('lend') || c.includes('cdp') || c.includes('collateral'),
    book: {
      open: (n, ch, k) => `Supply $${k} of USDC or ETH as collateral to ${n} on ${ch}, then borrow no more than 40% of it so the health factor survives a bad week`,
      weekly: (n) => `Repay a slice of the borrow and draw it again on ${n} once a week; the supply stays, the borrow cycles, and both sides of the market see the wallet`,
      second: (n, ch) => `Keep the supplied position open through the weekly rate snapshots ${n} takes, and add a second collateral type only if the first position is already a month old`,
    },
  },
  {
    match: (c) => c.includes('derivative') || c.includes('perpetual') || c.includes('basis') || c.includes('option'),
    book: {
      open: (n, ch, k) => `Deposit $${k} of USDC as margin on ${n} and open one small hedged position, long and short the same size, so the account trades without betting on direction`,
      weekly: (n) => `Trade at least $500 of hedged volume a week on ${n}, in two or three sittings; consistent weekly volume is what a trading season rewards, not one large bet`,
      second: (n, ch) => `Hold a small open position over each weekly settlement on ${n} and record every fee paid; fees are the real cost of this farm and the log keeps them honest`,
    },
  },
  {
    match: (c) => c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager') || c.includes('yield'),
    book: {
      open: (n, ch, k) => `Deposit $${k} into a ${n} vault on ${ch} with a track record of at least a month, and keep the vault shares in the same wallet`,
      weekly: (n) => `Check the vault's allocation page on ${n} once a week and add $25 whenever the vault rebalances into a new market, so deposits span more than one allocation`,
      second: (n, ch) => `Split a second, smaller deposit into a different ${n} vault on ${ch}; two vaults under one wallet show a curator breadth, not a single parked balance`,
    },
  },
  {
    match: (c) => c.includes('restak') || c.includes('staking'),
    book: {
      open: (n, ch, k) => `Stake $${k} of the chain's native staking asset through ${n} and keep the receipt token in the wallet; do not sell or lend the receipt`,
      weekly: (n) => `Claim and restake the rewards on ${n} once a week, however small; a receipt that keeps compounding is the activity a restaking season counts`,
      second: (n, ch) => `Delegate or opt into one extra service or pool ${n} offers, if it asks for nothing but a signature, so the wallet carries more than a bare stake`,
    },
  },
  {
    match: (c) => c.includes('rwa'),
    book: {
      open: (n, ch, k) => `Complete any onboarding ${n} asks for, then subscribe $${k} to its shortest-duration yield asset on ${ch} and hold the position to term`,
      weekly: (n) => `Open the position page on ${n} once a week and claim any distribution the moment it lands; an asset held through a distribution is the record that counts`,
      second: (n, ch) => `When the first asset matures, roll at least half into the next ${n} offering instead of withdrawing, so the wallet shows a second term, not a single touch`,
    },
  },
  {
    match: (c) => c === 'chain',
    book: {
      open: (n, ch, k) => `Bridge $${k} of stablecoins to ${n} from Ethereum with the network's own bridge and keep at least half of it on the network`,
      weekly: (n) => `Make three ordinary transactions a week on ${n}: a swap, a transfer to your second wallet and one contract call in a native app; steady weeks beat one busy day`,
      second: (n, ch) => `Hold a small balance of ${n}'s gas asset the whole season and use two different native apps, so the wallet reads as a resident, not a passer-by`,
    },
  },
  {
    match: (c) => c.includes('launchpad'),
    book: {
      open: (n, ch, k) => `Register the wallet on ${n} and complete its participation checks, then commit $${k} to the next sale it opens on ${ch}`,
      weekly: (n) => `Open ${n}'s upcoming-sales page once a week and join every allowlist the wallet qualifies for; allowlist history is what later sales draw on`,
      second: (n, ch) => `Hold any allocation the wallet wins for at least two weeks after listing instead of selling on the first day, and keep the sale records in the farm log`,
    },
  },
  {
    match: (c) => c.includes('prediction'),
    book: {
      open: (n, ch, k) => `Fund the wallet with $${k} of USDC on ${ch} and take one position in a liquid market on ${n}, sized under a fifth of the fund`,
      weekly: (n) => `Place two or three positions a week on ${n} in different markets and let at least one settle; settled history across markets is the record that counts`,
      second: (n, ch) => `Provide a small amount of liquidity to one long-dated market on ${n} and leave it for a month, so the wallet is both a trader and a maker there`,
    },
  },
];

const DEFAULT_BOOK: Playbook = {
  open: (n, ch, k) => `Deposit $${k} of USDC into ${n} on ${ch} through its own app and keep the position open; a deposit the protocol can count is the whole start`,
  weekly: (n) => `Make one qualifying action a week on ${n}, a deposit, a withdrawal of part, or a claim, so the wallet shows a rhythm and not a single visit`,
  second: (n, ch) => `Open ${n}'s points, rewards or governance page from inside its app and link this wallet there too, so every surface counts the same address`,
};

function playbookFor(category: string | null): Playbook {
  const c = (category ?? '').toLowerCase();
  for (const entry of PLAYBOOKS) if (entry.match(c)) return entry.book;
  return DEFAULT_BOOK;
}

/**
 * A candidate's farm plan: six steps from its own record. The wallet step and the claim-safety
 * step are the same advice for everyone, because they are; the four middle steps are the
 * protocol's own playbook, chains, capital and hold window.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const book = playbookFor(p.category);
  const mainChain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const gas = gasFor(mainChain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const otherChain = p.chains.length > 1 ? p.chains[1]! : null;
  const steps: FarmStep[] = [
    {
      text: `Use a fresh wallet that holds only the funds this farm needs, and keep its seed phrase offline; one wallet per protocol keeps a bad approval from reaching the rest`,
      cost: 'nothing to create, under $3 of gas to fund it',
      time: '5 minutes',
    },
    {
      text: book.open(p.name, mainChain, capital),
      cost: `$${capital} of capital and about $${gas.usd} of gas on ${gas.tier}`,
      time: '15 minutes to set up',
    },
    {
      text: book.weekly(p.name),
      cost: `about $${Math.max(1, Math.round(gas.usd / 3))} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text:
        otherChain !== null
          ? `Repeat the core position with $50 on ${otherChain}, ${p.name}'s second chain; multi-chain activity is the cheapest breadth a farm can show`
          : book.second(p.name, mainChain),
      cost: otherChain !== null ? `$50 of capital and about $${gasFor(otherChain).usd} of gas on ${otherChain}` : 'no new capital, a few dollars of gas at most',
      time: '15 minutes, once',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity stands in more than one weekly snapshot, and never withdraw the week a points season is rumoured to close`,
      cost: `the $${capital} stays in the position, earning or at risk as the position is`,
      time: `${hold} days`,
    },
    {
      text: `When a distribution is announced, claim only from the link ${p.name} publishes in its own app, and log the wallet, the dates and every transaction hash so the farm can be repeated or unwound`,
      cost: 'nothing to check, and never pay anyone to claim',
      time: '10 minutes',
    },
  ];
  return steps;
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row, with the model's factors beside the value. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  multiple: number;
  launch_fdv_usd: number;
  momentum: number;
  maturity: number;
  community_share: number;
  pool_usd: number;
  likelihood: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the page shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** A pre-token product of a trading asset, set aside with the record signal that marks it. */
export interface RepresentedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard renders, written beside it as data.js by main.ts. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: typeof MODEL;
  global_multiple: number;
  multiples: CategoryMultiple[];
  counts: {
    protocols: number;
    candidates: number;
    watchlist: number;
    live: number;
    represented: number;
  };
  pool_total_usd: number;
  rows: BoardRow[];
  live: LiveRow[];
  represented: RepresentedRow[];
}

/** How many live-token protocols the dashboard's Live view carries in full. */
export const LIVE_ROWS = 36;
/** How many represented products the dashboard's Set aside view carries in full. */
export const REPRESENTED_ROWS = 48;

/** Build the ranked board and the dashboard's data from one snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { table, globalMedian } = categoryMultiples(snapshot);
  const multiples = new Map(table.map((m) => [m.category, m.used]));
  const watch = new Set(snapshot.watchlist);

  const scored = snapshot.protocols
    .filter(isCandidate)
    .map((p) => scoreProtocol(p, snapshot.as_of, multiples, globalMedian));
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || bySlugAsc(a.protocol.slug, b.protocol.slug));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.protocol.slug,
    name: s.protocol.name,
    category: s.protocol.category,
    chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd,
    change_7d: s.protocol.change_7d,
    mcap_usd: s.protocol.mcap_usd,
    listed_at: s.protocol.listed_at,
    gecko_id: s.protocol.gecko_id,
    symbol: s.protocol.symbol,
    token_status: 'pre-token',
    watchlist: watch.has(s.protocol.slug),
    age_days: s.age_days,
    multiple: s.multiple,
    launch_fdv_usd: s.launch_fdv_usd,
    momentum: s.momentum,
    maturity: s.maturity,
    community_share: communityShare(s.protocol.category),
    pool_usd: s.pool_usd,
    likelihood: s.likelihood,
    implied_value_usd: s.implied_value_usd,
    farm_steps: farmSteps(s.protocol, s.age_days).map(stepText),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter(recordsToken)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || bySlugAsc(a.slug, b.slug))
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d, symbol: p.symbol }));

  const represented: RepresentedRow[] = snapshot.protocols
    .filter((p) => !recordsToken(p) && representedReason(p) !== null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug))
    .slice(0, REPRESENTED_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: representedReason(p)! }));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: MODEL,
    global_multiple: globalMedian,
    multiples: table,
    counts: {
      protocols: snapshot.protocols.length,
      candidates: board.length,
      watchlist: snapshot.watchlist.length,
      live: snapshot.protocols.filter(recordsToken).length,
      represented: snapshot.protocols.filter((p) => !recordsToken(p) && representedReason(p) !== null).length,
    },
    pool_total_usd: board.reduce((n, r) => n + r.pool_usd, 0),
    rows: board,
    live,
    represented,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
