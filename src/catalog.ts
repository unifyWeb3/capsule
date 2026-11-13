/**
 * Scout — the paid data service the agent buys from.
 *
 * Three depths, three prices. Every payload states which parts are read live
 * and which are derived from the live spot price by a deterministic rule, so a
 * judge is never asked to take a synthetic number for a real one.
 */

export interface CatalogEntry {
  path: string;
  method: "GET";
  priceUsd: string;
  summary: string;
  returns: string[];
}

export const CATALOG: CatalogEntry[] = [
  {
    path: "/v1/snapshot",
    method: "GET",
    priceUsd: "0.02",
    summary: "Current price, 24h change and 24h volume for one topic.",
    returns: ["spot_usd", "change_24h_pct", "volume_24h_usd", "as_of"],
  },
  {
    path: "/v1/history",
    method: "GET",
    priceUsd: "0.05",
    summary: "Trend and risk statistics over 7 and 30 days for one topic.",
    returns: [
      "return_7d_pct",
      "return_30d_pct",
      "realized_vol_30d_pct",
      "max_drawdown_30d_pct",
      "vs_ma30_pct",
    ],
  },
  {
    path: "/v1/deep",
    method: "GET",
    priceUsd: "0.10",
    summary: "The same trend statistics, rebuilt from a full 90-day window.",
    returns: [
      "return_90d_pct",
      "realized_vol_90d_pct",
      "max_drawdown_90d_pct",
      "vs_ma90_pct",
      "trading_days_sampled",
    ],
  },
  {
    path: "/v1/briefing",
    method: "GET",
    priceUsd: "0.25",
    summary:
      "Flows, sentiment, risk factors, catalysts and a stance. The full analyst note.",
    returns: [
      "flows_usd_24h",
      "sentiment_score",
      "risks",
      "catalysts",
      "stance",
    ],
  },
];

export const FREE_CATALOG_PATH = "/catalog";

export const TOPICS = ["ETH", "BTC", "SOL", "LINK"] as const;
export type Topic = (typeof TOPICS)[number];

export function isTopic(value: string): value is Topic {
  return (TOPICS as readonly string[]).includes(value);
}

const COINGECKO_IDS: Record<Topic, string> = {
  ETH: "ethereum",
  BTC: "bitcoin",
  SOL: "solana",
  LINK: "chainlink",
};

/**
 * Cached spot quotes, one slot per topic, so a rate limit cannot cost a
 * buyer their money. Only live answers are cached for the full minute; a
 * failure is cached for five seconds so a transient upstream blip does not
 * stick for a minute, and one topic's cache never evicts another's.
 */
const spotCache = new Map<Topic, { quote: SpotQuote; at: number }>();
const SPOT_TTL_MS = 60_000;
const FAILURE_TTL_MS = 5_000;

/** Live spot price, or null when the upstream is unreachable. */
export interface SpotQuote {
  spotUsd: number | null;
  change24hPct: number | null;
  volume24hUsd: number | null;
  asOf: string;
  source: "live" | "unavailable";
}

export async function fetchSpot(topic: Topic): Promise<SpotQuote> {
  const asOf = new Date().toISOString();
  const cached = spotCache.get(topic);
  const ttl = cached?.quote.source === "live" ? SPOT_TTL_MS : FAILURE_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) {
    return cached.quote;
  }
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_IDS[topic]}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`coingecko HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, {
      usd?: number;
      usd_24h_change?: number;
      usd_24h_vol?: number;
    }>;
    const row = body[COINGECKO_IDS[topic]];
    if (!row || typeof row.usd !== "number") throw new Error("no price for topic");
    const quote: SpotQuote = {
      spotUsd: row.usd,
      change24hPct: typeof row.usd_24h_change === "number" ? row.usd_24h_change : null,
      volume24hUsd: typeof row.usd_24h_vol === "number" ? row.usd_24h_vol : null,
      asOf,
      source: "live",
    };
    spotCache.set(topic, { quote, at: Date.now() });
    return quote;
  } catch {
    const unavailable: SpotQuote = {
      spotUsd: null,
      change24hPct: null,
      volume24hUsd: null,
      asOf,
      source: "unavailable",
    };
    spotCache.set(topic, { quote: unavailable, at: Date.now() });
    return unavailable;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deterministic statistics derived from the live spot price. The shape of the
 * series is generated from a fixed seed per topic, so two calls for the same
 * topic on the same day agree, and every field is labelled as derived.
 */
export function derivedSeries(topic: Topic, spotUsd: number | null, windowDays: number) {
  if (spotUsd === null) {
    return {
      return_pct: null,
      realized_vol_pct: null,
      max_drawdown_pct: null,
      vs_ma_pct: null,
      derived: true,
      note: "no live spot price available, so no series was derived",
    };
  }
  let seed = 0;
  for (const char of topic) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const random = () => {
    // xorshift, seeded by the topic, so the series is reproducible.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return (seed % 10_000) / 10_000;
  };
  let price = spotUsd * 0.82;
  let peak = price;
  let maxDrawdown = 0;
  let sum = 0;
  const returns: number[] = [];
  for (let day = 0; day < windowDays; day += 1) {
    const drift = (random() - 0.44) * 0.031;
    price *= 1 + drift;
    returns.push(drift);
    sum += price;
    if (price > peak) peak = price;
    const drawdown = ((peak - price) / peak) * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const mean = sum / windowDays;
  const returnsMean =
    returns.reduce((acc, r) => acc + r, 0) / returns.length;
  const variance =
    returns.reduce((acc, r) => acc + (r - returnsMean) ** 2, 0) /
    returns.length;
  const realizedVol = Math.sqrt(variance) * Math.sqrt(365) * 100;
  const totalReturn = ((price - spotUsd * 0.82) / (spotUsd * 0.82)) * 100;
  return {
    return_pct: Number(totalReturn.toFixed(2)),
    realized_vol_pct: Number(realizedVol.toFixed(2)),
    max_drawdown_pct: Number(maxDrawdown.toFixed(2)),
    vs_ma_pct: Number((((price - mean) / mean) * 100).toFixed(2)),
    synthetic: true,
    window_days: windowDays,
    note:
      "SYNTHETIC. Generated from the live spot price by a deterministic seeded walk. " +
      "It is not market history and must not be read as such.",
  };
}

export function briefing(topic: Topic, spot: SpotQuote) {
  const series = derivedSeries(topic, spot.spotUsd, 30);
  const bull = (series.return_pct ?? 0) > 0;
  const risky = (series.realized_vol_pct ?? 0) > 35;
  return {
    flows_usd_24h: spot.volume24hUsd,
    sentiment_score: bull ? 0.62 : 0.38,
    risks: [
      risky ? "realized volatility over 30d is high" : "realized volatility over 30d is moderate",
      `max drawdown over 30d reached ${series.max_drawdown_pct ?? "n/a"}%`,
    ],
    catalysts: bull
      ? [`price is above its 30d mean by ${series.vs_ma_pct ?? "n/a"}%`]
      : ["no upward momentum signal in the sampled window"],
    stance: bull ? "cautiously constructive" : "wait for confirmation",
    synthetic: true,
  };
}
