/**
 * Formatting.
 *
 * Pure functions. Nothing here knows about the DOM or the network, so the
 * wording of a record can be checked without rendering it.
 */

/** A dollar amount. */
export function money(value) {
  if (value === null || value === undefined || value === "") return "-";
  return `$${value}`;
}

/** The host of a URL, or an empty string. */
export function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * How long ago a check was made, in words.
 *
 * The chain checks are made at a moment, and the answer may be handed to a
 * reader a little later. Saying how much later is the difference between a
 * claim and a fact, so the moment is never hidden.
 *
 * @param {string|null} iso when the check was made
 * @param {number} [now] the current time, in milliseconds
 * @returns {string}
 */
export function ageOf(iso, now = Date.now()) {
  if (!iso) return "at an unknown time";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return "a moment ago";
  if (seconds < 90) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The path of a URL, or the URL itself. */
export function path(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url ?? "";
  }
}

/**
 * The Passport's error codes, in plain English.
 *
 * A judge should never have to know what "session_rule_exceeded" means.
 */
const PLAIN = {
  session_rule_exceeded:
    "over the cap you signed for a single purchase, so the Passport refused to release the money",
  session_total_exceeded:
    "would have taken the session past its total budget, so the Passport refused to release the money",
  separate_session_used_up:
    "the session had nothing left to spend, so nothing was sent",
  payment_target_forbidden:
    "the merchant is not on the Passport's allowlist, so the Passport would not pay it",
  session_endpoint_forbidden: "outside the endpoints the session allows",
  session_asset_forbidden: "the merchant wanted an asset the session does not allow",
  insufficient_balance: "the wallet did not hold enough",
  no_payment_requirement: "the merchant returned no payment request for that call",
  merchant_rejected: "the merchant refused the request",
  merchant_unavailable: "the merchant did not answer",
};

export function plainError(code) {
  if (!code) return "";
  return PLAIN[code] ?? "the Passport refused this purchase";
}
