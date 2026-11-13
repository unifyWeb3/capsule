/**
 * The sections.
 *
 * Each section of the page is one component that takes the props its section
 * needs and returns the whole section's markup. The controller asks for a
 * section; it never assembles one.
 */
import { html, raw } from "./dom.js";
import { StatusChip } from "./status.js";
import { DataTable } from "./table.js";
import { Panel, Caveat } from "./blocks.js";

/**
 * What the limit cost.
 *
 * @param {{
 *   headline: string,
 *   note: string,
 *   rows: Array<{fact: string, covered: boolean, blocked: {blocked_by: string, wanted_price_usd: string} | null}>,
 *   contrast: {rows: Array<Array<string|number>>, paidTheSame: {price: string, tx: string} | null} | null,
 * }} props
 * @returns {string}
 */
export function CostPanel(props) {
  if (!props.rows.length) {
    return html`<div class="state state-empty">
      <p>This record carries no cost report.</p>
    </div>`;
  }
  const rows = props.rows.map((row) => [
    row.fact,
    row.covered
      ? StatusChip({ kind: "verified", label: "covered" })
      : row.blocked
        ? html`<span class="blocked">blocked by the ${row.blocked.blocked_by} — $${row.blocked.wanted_price_usd}</span>`
        : html`<span class="blocked">not attempted — the budget was gone</span>`,
  ]);

  const body = html`${raw(
    DataTable({
      head: ["The answer needed", "What the record says"],
      rows,
      columnClass: (index) => (index === 0 ? "wrap" : ""),
    }),
  )}
    <p class="caveat">
      The refusals were not free attempts. Each one names the endpoint the agent wanted, the
      price it walked away from, and the limit that stopped it. The cost is the sum of those
      prices, taken from the catalog.
    </p>`;

  const contrast = props.contrast
    ? html`<div class="verify" style="margin-top:14px">
        <div class="verify-head">
          <span class="headline">The same task, a different limit</span>
          <span class="spacer"></span>
          <span class="verify-note">only the number the user signed changed</span>
        </div>
        ${raw(
          DataTable({
            head: ["", "This run", "The contrast run"],
            rows: props.contrast.rows,
            columnClass: (index) => (index === 0 ? "wrap" : ""),
          }),
        )}
        ${
          props.contrast.paidTheSame
            ? html`<div class="hashline">
                The $${props.contrast.paidTheSame.price} endpoint that was <b>refused</b> above
                was <b>paid</b> here — ${props.contrast.paidTheSame.tx}.<br />
                The refusals were not a broken agent. They were the limit, doing its job.
              </div>`
            : ""
        }
      </div>`
    : "";

  return html`${raw(
    Panel({
      head: props.headline,
      note: props.note,
      body,
      headlineStyle: "font-size:1.15rem",
    }),
  )}${raw(contrast)}`;
}

/**
 * What the agent bought instead, for every refusal.
 *
 * @param {{rows: Array<{
 *   seq: number, wanted: string, wantedPrice: string, reason: string,
 *   agentReason: string,
 *   instead: {service: string, price: string, outcome: string, errorCode: string} | null,
 *   insteadReason: string,
 * }>}} props
 * @returns {string}
 */
export function SubstitutionList(props) {
  if (!props.rows.length) {
    return html`<div class="state state-empty">
      <h3>Nothing was refused</h3>
      <p>
        Every purchase the agent proposed was allowed by the session. The record below shows
        only the settlements.
      </p>
    </div>`;
  }
  const side = (row) => {
    if (!row.instead) {
      return html`<div class="side">
        <div class="label">Bought instead</div>
        <div class="name">nothing — the budget was gone</div>
        <div class="note">The session was exhausted, so the run ended with the gap named.</div>
      </div>`;
    }
    if (row.instead.outcome === "bought") {
      return html`<div class="side got">
        <div class="label">Bought instead</div>
        <div class="name">${row.instead.service}</div>
        <div class="note">
          ${row.instead.price}${row.insteadReason ? ` — ${row.insteadReason}` : ""}
        </div>
      </div>`;
    }
    return html`<div class="side tried">
      <div class="label">Tried instead</div>
      <div class="name">${row.instead.service}</div>
      <div class="note">
        ${row.instead.price} — refused too${row.instead.errorCode
          ? ` (${row.instead.errorCode})`
          : ""}.
      </div>
    </div>`;
  };

  return html`<div class="subs">
    ${props.rows.map(
      (row) => html`<div class="sub">
        <div class="sub-head">
          <span class="who">attempt ${row.seq}</span>
          ${raw(StatusChip({ kind: "refused" }))}
          <span class="who sub-reason">${row.reason}</span>
        </div>
        <div class="swap">
          <div class="side wanted">
            <div class="label">Wanted</div>
            <div class="name">${row.wanted}</div>
            <div class="note">${row.wantedPrice} — ${row.reason}.</div>
          </div>
          <span class="arrow" aria-hidden="true">→</span>
          ${raw(side(row))}
        </div>
        ${row.agentReason
          ? html`<div class="plain">
              The agent's own reason for wanting it: <b>${row.agentReason}</b>
            </div>`
          : ""}
      </div>`,
    )}
  </div>`;
}

/**
 * Verification: the chain checks, the log, the identity, the payer.
 *
 * @param {{
 *   ok: boolean, head: string, network: string, note: string, checkedAt: string,
 *   rows: Array<{merchant: string, tx: string, explorer: string, block: string|number, confirmations: string|number, recipient: string, outcome: string}>,
 *   log: {algorithm: string, records: number, head: string, intact: boolean} | null,
 *   attestation: {did: string, address: string, signature: string} | null,
 *   payer: string | null,
 * }} props
 * @returns {string}
 */
export function VerificationPanel(props) {
  const verdict = props.verdict ?? {
    kind: props.ok ? "verified" : "fault",
    label: props.ok ? "every payment confirmed on chain" : "a payment is unconfirmed",
  };
  const head = html`<div class="verify-head">
    ${raw(StatusChip(verdict))}
    <span class="headline">${props.head} on ${props.network}</span>
    <span class="spacer"></span>
    <span class="verify-note">${props.note}</span>
  </div>
    ${props.log
      ? html`<div class="hashline">
          <b>Decision log</b> ${props.log.algorithm} · ${props.log.records} records ·
          ${props.log.intact ? "chain intact" : "chain broken"}<br />
          <b>head</b> ${props.log.head}
        </div>`
      : ""}
    ${props.attestation
      ? html`<div class="hashline">
          <b>Identity</b> ${props.attestation.covers === false
            ? html`the key Kite publishes for this DID signed an <b>earlier</b> head of this log
                (${props.attestation.signedHead.slice(0, 14)}…), not the current one — it does
                not cover this log until it is re-signed`
            : "the head is signed by the key Kite publishes for this DID"}<br />
          <b>did</b> ${props.attestation.did}<br />
          <b>signing address</b> ${props.attestation.address}<br />
          <b>signature</b> ${props.attestation.signature.slice(0, 26)}…
          <span style="color:var(--ink-3)">— check it yourself:</span>
          <code>curl -s https://passport.prod.gokite.ai/v1/agents/${props.attestation.did}/signingKeys</code>
        </div>`
      : ""}
    ${props.payer
      ? html`<div class="hashline">
          <b>Money</b> every transfer above was paid by this wallet<br />
          <b>paying wallet</b> ${props.payer}
          <span style="color:var(--ink-3)">— the Passport's settlement wallet for this session</span>
        </div>`
      : ""}`;

  const table = DataTable({
    head: ["Merchant", "Transaction", "Block", "Confirms", "Recipient", "On chain"],
    rows: props.rows.map((row) => [
      row.merchant,
      row.tx
        ? html`<a href="${row.explorer}/tx/${row.tx}" target="_blank" rel="noreferrer">${row.tx.slice(
            0,
            12,
          )}…</a>`
        : html`<span class="muted">no hash recorded</span>`,
      String(row.block),
      String(row.confirmations),
      row.recipient,
      StatusChip({
        kind:
          row.outcome === "confirmed"
            ? "verified"
            : row.outcome === "unavailable"
              ? "neutral"
              : "fault",
        label:
          row.outcome === "confirmed"
            ? "confirmed"
            : row.outcome === "unavailable"
              ? "could not read"
              : "did not match",
      }),
    ]),
  });

  const notes = (props.notes ?? []).length
    ? html`<ul class="caveat">${props.notes.map((note) => html`<li>${note}</li>`)}</ul>`
    : "";

  return html`${raw(Panel({ head: "", body: head + table }))}
    ${notes}
    ${raw(
      Caveat({
        body:
          `These rows were read from the chain ${props.checkedAt}. Every time this answer ` +
          "is made, the chain is read again; the edge may hand you the answer it already " +
          "made, for up to thirty seconds. Editing an earlier decision in the log breaks every " +
          "link after it, and the verifier says which record broke. The hash chain shows the " +
          "file is consistent; only a signature over its head shows who wrote it.",
      }),
    )}`;
}
