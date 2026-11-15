/**
 * The menu of paid endpoints the agent may buy from.
 *
 * It is the live Kite service catalog, filtered to the chain and asset our
 * session is funded for. The prices come from the catalog, not from us, so the
 * model is reasoning over real costs.
 *
 * The shortlist below is a *relevance* shortlist only — the endpoints that
 * could answer a fact, cheapest first. It is deliberately NOT a budget
 * filter: deciding what the agent may afford is the Passport's job, and the
 * per-transaction ceiling in particular is deliberately not applied here.
 */
import { readFile } from "node:fs/promises";
import { MENU_PATH } from "./paths.js";

export interface MenuEntry {
  id: string;
  service: string;
  method: string;
  path: string;
  url: string;
  price_usd: string;
  chain: string;
  asset: string;
  probe_status: string;
  summary: string;
  query_params: string[];
  /** The fields the endpoint returns, from the catalog. */
  returns: string[];
  /** The catalog's own tags for the endpoint. */
  tags: string[];
  /**
   * How the catalog qualifies the price.
   *
   * "exact" is a fixed price. "upto" is a ceiling: the call costs at most
   * this. The live catalog says which, and the solver quotes the number the
   * catalog gives while the answer says which kind it is, so a ceiling is
   * never read as a fixed price.
   */
  price_unit?: string;
}

export interface Menu {
  generated_at: string;
  source: string;
  asset: string;
  chain: string;
  endpoints: MenuEntry[];
}

export async function loadMenu(): Promise<Menu> {
  const raw = await readFile(MENU_PATH, "utf8");
  const menu = JSON.parse(raw) as Menu;
  if (!menu.endpoints || menu.endpoints.length === 0) {
    throw new Error("the menu is empty; run `npm run menu` first");
  }
  return menu;
}

/**
 * The endpoints that could answer a fact, cheapest first.
 *
 * This is the decision the code makes, and it is the right one to make: whether
 * an endpoint is *relevant* to a missing fact is mechanical, and it is read out
 * of the catalog's own metadata rather than judged by a model.
 *
 * It is deliberately NOT a budget filter. Deciding what the agent may afford
 * is the Passport's job, and doing it here would put the limit back inside the
 * code that wants to spend it — the thing this whole project exists to avoid.
 */
export function relevantTo(menu: Menu, fact: string): MenuEntry[] {
  const matched = menu.endpoints
    .map((entry) => ({ entry, score: matchScore(entry, fact) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || Number(a.entry.price_usd) - Number(b.entry.price_usd),
    )
    .map((row) => row.entry);
  if (matched.length) return matched;
  // No endpoint in the catalog claims this fact. The model still gets to try
  // the cheapest ones for partial coverage, and the record will say that it
  // could not cover the fact rather than that it never looked.
  return [...menu.endpoints]
    .sort((a, b) => Number(a.price_usd) - Number(b.price_usd))
    .slice(0, 3);
}

/**
 * A loose match between a fact the answer needs and the fields an endpoint
 * returns, so the record can say which catalog endpoint would have covered it.
 */
export function factWords(fact: string): string[] {
  return fact
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

/** How many of a fact's words an endpoint's own words cover. */
export function matchScore(entry: MenuEntry, fact: string): number {
  const words = factWords(fact);
  if (!words.length) return 0;
  const haystack = `${entry.summary ?? ""} ${(entry.returns ?? []).join(" ")} ${entry.path ?? ""} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length;
}

/**
 * The endpoint in the catalog that best covers a fact, cheapest among the best
 * matches. Used to say what the evidence for an uncovered fact would have cost
 * when the agent never got as far as asking for it.
 */
export function bestEndpointForFact(
  menu: Menu,
  fact: string,
): MenuEntry | null {
  const scored = menu.endpoints
    .map((entry) => ({ entry, score: matchScore(entry, fact) }))
    .filter((row) => row.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || Number(a.entry.price_usd) - Number(b.entry.price_usd),
    );
  return scored[0]?.entry ?? null;
}

/**
 * The words that carry no meaning when matching a fact to an endpoint.
 *
 * One list, used by the agent's shortlist and by the calculator, so the two
 * agree about what "could answer this" means.
 */
export const STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "that",
  "this",
  "from",
  "were",
  "what",
  "price",
  "current",
  "over",
  "last",
  "month",
  "risk",
  "main",
  "fact",
  "facts",
  "covered",
]);
