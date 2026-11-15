/**
 * The live Kite service catalog, read over plain HTTPS.
 *
 * `docs/menu.json` is a photograph of the catalog on one day. That is the
 * right thing for the recorded run, whose prices belong to the day it ran, and
 * the wrong thing for a visitor asking what *their* limit costs today.
 *
 * So the calculator reads the catalog live when it can, and says which catalog
 * it used. The read is public: no key, no account, no payment, no allowance.
 * It is the same endpoint the Kite CLI reads (`ksearch service list`), so the
 * prices are the catalog's own and not ours.
 *
 * Three things this module refuses to do:
 *
 * 1. **Guess a price.** An endpoint with no price in the catalog is not
 *    priced here. It would be a number we made up.
 * 2. **Mix chains.** Only endpoints that settle in USDC on Base mainnet are
 *    eligible, because that is the rail a Passport session funds. An endpoint
 *    that settles on Solana or Kite is a different payment, and quoting its
 *    dollar price against a Base budget would be false.
 * 3. **Fail loudly by falling back quietly.** If the catalog cannot be read,
 *    this returns null and the caller says so in the answer. It never returns
 *    a stale catalog as if it were live.
 */
import type { Menu, MenuEntry } from "./menu.js";
import { BASE_MAINNET } from "./chains.js";

/** The public catalog endpoint. The same one `ksearch service list` reads. */
export const CATALOG_URL =
  "https://service-discovery.prod.gokite.ai/v1/catalog/services";

/** How many services to ask for per page. */
const PAGE_SIZE = 100;
/** How many pages to walk before giving up. */
const MAX_PAGES = 5;
/** How long the catalog gets to answer. */
const TIMEOUT_MS = 8000;
/** How many times a read is attempted before the snapshot answers instead. */
const ATTEMPTS = 2;
/** How long a read is reused before it is read again. */
const CACHE_MS = 5 * 60 * 1000;

interface LiveEndpoint {
  method?: string;
  path?: string;
  endpoint_url?: string;
  summary?: string;
  tags?: string[];
  query_params?: Array<{ name?: string }>;
  payment_chain?: string;
  payment_asset?: string;
  payment_assets?: string[];
  starting_price?: { amount?: string; asset?: string; unit?: string };
  probe_status?: string;
}

interface LiveService {
  display_name?: string;
  host_name?: string;
  summary?: string;
  featured_endpoints?: LiveEndpoint[];
  updated_at?: string;
}

interface LiveCatalogPayload {
  services?: LiveService[];
  next_cursor?: string | null;
}

/**
 * Whether a chain string names Base mainnet.
 *
 * The catalog is not consistent about it: some endpoints say `eip155:8453`,
 * some say `base`, and some say nothing at all. All three name the same rail,
 * and the asset check below is the real gate.
 */
function isBaseChain(chain: string | undefined): boolean {
  const value = (chain ?? "").trim().toLowerCase();
  if (!value) return true;
  return (
    value === BASE_MAINNET.network.toLowerCase() ||
    value === BASE_MAINNET.id ||
    value === String(BASE_MAINNET.chainId)
  );
}

/** The asset an endpoint settles in, from whichever field the catalog used. */
function assetOf(endpoint: LiveEndpoint): string {
  return (
    endpoint.payment_asset ??
    endpoint.starting_price?.asset ??
    (endpoint.payment_assets ?? [])[0] ??
    ""
  );
}

/** Whether an endpoint settles in the USDC this project prices against. */
function isBaseUsdc(endpoint: LiveEndpoint): boolean {
  const wanted = BASE_MAINNET.assetAddress.toLowerCase();
  // The endpoint's own settlement asset is the one that counts. The list of
  // accepted assets is a fallback for endpoints that only give the list, not a
  // way for an endpoint priced in another token to borrow the right one.
  const primary = endpoint.payment_asset ?? endpoint.starting_price?.asset;
  if (primary) return primary.toLowerCase() === wanted;
  const accepted = (endpoint.payment_assets ?? []).filter(
    (asset) => typeof asset === "string" && asset.length > 0,
  );
  return accepted.some((asset) => asset.toLowerCase() === wanted);
}

/**
 * Turns the catalog's payload into the menu shape the solver reads.
 *
 * Pure, so it can be tested against a recorded payload without a network.
 * The endpoint's own text is what it carries: service, path, address,
 * summary and tags. The solver's coverage rule reads that text and nothing
 * else, so a cover is still the merchant's claim about itself.
 */
export function normalizeCatalog(
  payload: unknown,
  now: string = new Date().toISOString(),
): Menu {
  const body = (payload ?? {}) as LiveCatalogPayload;
  const services = Array.isArray(body.services) ? body.services : [];

  const rows: MenuEntry[] = [];
  let updatedAt = "";

  for (const service of services) {
    const name = (service.display_name ?? service.host_name ?? "").trim();
    if (!name) continue;
    if (service.updated_at && service.updated_at > updatedAt) {
      updatedAt = service.updated_at;
    }
    for (const endpoint of service.featured_endpoints ?? []) {
      if (!isBaseChain(endpoint.payment_chain)) continue;
      if (!isBaseUsdc(endpoint)) continue;

      const amount = endpoint.starting_price?.amount;
      if (!amount || amount === "unknown") continue;
      const price = Number(amount);
      if (!Number.isFinite(price) || price < 0) continue;

      const url = (endpoint.endpoint_url ?? "").trim();
      if (!url) continue;

      rows.push({
        id: "",
        service: name,
        method: endpoint.method ?? "GET",
        path: endpoint.path ?? "",
        url,
        price_usd: amount,
        chain: endpoint.payment_chain ?? BASE_MAINNET.network,
        asset: assetOf(endpoint),
        probe_status: endpoint.probe_status ?? "unknown",
        summary: (endpoint.summary ?? "").slice(0, 320),
        query_params: (endpoint.query_params ?? [])
          .map((param) => param.name ?? "")
          .filter(Boolean),
        returns: [],
        tags: endpoint.tags ?? [],
        price_unit: endpoint.starting_price?.unit ?? "exact",
      });
    }
  }

  rows.sort(
    (a, b) => Number(a.price_usd) - Number(b.price_usd) || a.url.localeCompare(b.url),
  );

  const seen = new Set<string>();
  const unique = rows.filter((entry) => {
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
  // Short ids, the same convention the snapshot uses.
  unique.forEach((entry, index) => {
    entry.id = `e${String(index + 1).padStart(2, "0")}`;
  });

  return {
    generated_at: updatedAt || now,
    source: `the live Kite service catalog, read over plain HTTPS at ${CATALOG_URL}`,
    asset: BASE_MAINNET.assetAddress,
    chain: BASE_MAINNET.network,
    endpoints: unique,
  };
}

/**
 * Reads the whole live catalog.
 *
 * The catalog is paginated, so this walks the cursor. Every page is a public
 * GET; nothing here is paid for and nothing here needs a credential.
 */
export async function fetchLiveMenu(signal?: AbortSignal): Promise<Menu> {
  const services: LiveService[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(CATALOG_URL);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetch(url, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`the live catalog answered ${response.status}`);
    }
    const payload = (await response.json()) as LiveCatalogPayload;
    if (Array.isArray(payload.services)) services.push(...payload.services);
    cursor = payload.next_cursor ?? null;
    if (!cursor) break;
  }

  const menu = normalizeCatalog({ services });
  if (!menu.endpoints.length) {
    throw new Error("the live catalog returned no priced endpoints on Base USDC");
  }
  return menu;
}

let cached: { at: number; menu: Menu } | null = null;

/**
 * The live catalog, or null when it cannot be read.
 *
 * A read is reused for five minutes: the calculator is called by a browser on
 * every keystroke, and a public catalog should not be read once per
 * keystroke. The clock inside the answer says when the catalog was read, so
 * a reused read never passes as a fresh one.
 *
 * A read that fails is tried once more, because a page that falls back to the
 * snapshot on one slow response would show yesterday's prices without saying
 * why. When both attempts fail the answer falls back to the snapshot and says
 * that in the notes, so the reader is never left guessing which catalog they
 * are looking at.
 */
export async function loadLiveMenu(): Promise<Menu | null> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.menu;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const menu = await fetchLiveMenu(controller.signal);
      cached = { at: Date.now(), menu };
      return menu;
    } catch {
      // Try again, then give up and let the caller use the snapshot.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Drops the cached read. Used by the tests. */
export function resetLiveCatalogCache(): void {
  cached = null;
}
