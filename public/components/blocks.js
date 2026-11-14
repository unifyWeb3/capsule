/**
 * Blocks.
 *
 * The pieces that hold prose: a callout for the one thing that matters, a
 * caveat for the thing that is true but limited, and the grid of surfaces
 * that tells a reader where else to go.
 */
import { html, raw } from "./dom.js";

/**
 * A callout: the thing on the page that must not be missed.
 *
 * @param {{title?: string, body: string, tone?: "warn" | "quiet"}} props
 * @returns {string}
 */
export function Callout(props) {
  const tone = props.tone ?? "warn";
  return html`<aside class="callout callout-${tone}">
    ${props.title ? html`<strong>${props.title}</strong>` : ""}
    <span>${props.body}</span>
  </aside>`;
}

/**
 * A caveat: true, and limited, and it says so.
 *
 * @param {{body: string}} props
 * @returns {string}
 */
export function Caveat(props) {
  return html`<p class="caveat">${props.body}</p>`;
}

/**
 * A panel with a heading, a note and a slot.
 *
 * @param {{head: string, note?: string, body: string}} props
 * @returns {string}
 */
export function Panel(props) {
  return html`<div class="verify">
    ${
      props.head
        ? html`<div class="verify-head">
            <span class="headline">${props.head}</span>
            <span class="spacer"></span>
            ${props.note ? html`<span class="verify-note">${props.note}</span>` : ""}
          </div>`
        : ""
    }
    ${raw(props.body)}
  </div>`;
}

/**
 * A link to somewhere else: a surface, a document, an endpoint.
 *
 * @param {{kind: string, value: string, detail: string, href: string}} props
 * @returns {string}
 */
export function SurfaceCard(props) {
  return html`<a class="surface" href="${props.href}">
    <div class="k">${props.kind}</div>
    <div class="v">${props.value}</div>
    <div class="d">${props.detail}</div>
  </a>`;
}

/**
 * A grid of surfaces.
 *
 * @param {{cards: Array<Parameters<typeof SurfaceCard>[0]>}} props
 * @returns {string}
 */
export function SurfaceGrid(props) {
  return html`<div class="surfaces">
    ${props.cards.map((card) => html`${raw(SurfaceCard(card))}`)}
  </div>`;
}
