/**
 * Numbers.
 *
 * A metric is a value with a label and, optionally, a line of context. The
 * session bar is a row of metrics with a meter under them: how much the user
 * signed, how much one call may cost, how much was spent, how much is left.
 */
import { escape, html, raw } from "./dom.js";

/**
 * One number.
 *
 * @param {{
 *   label: string,
 *   value: string,
 *   detail?: string,
 *   tone?: "normal" | "warn" | "good",
 * }} props
 * @returns {string}
 */
export function Metric(props) {
  const tone = props.tone ?? "normal";
  return html`<div class="metric ${tone === "normal" ? "" : tone}">
    <dt class="metric-label">${props.label}</dt>
    <dd class="metric-value">
      ${props.value}${props.detail ? html`<small>${props.detail}</small>` : ""}
    </dd>
  </div>`;
}

/**
 * The session bar.
 *
 * @param {{
 *   budget: string,
 *   perCall: string,
 *   spent: string,
 *   left: string,
 *   spentRatio?: number,
 *   exhausted?: boolean,
 * }} props
 * @returns {string}
 */
export function SessionBar(props) {
  const ratio = Math.max(0, Math.min(100, props.spentRatio ?? 0));
  return html`<dl class="session" id="session">
    <div class="session-row">
    ${raw(
      Metric({ label: "Budget you signed", value: props.budget }) +
        Metric({ label: "Cap per call", value: props.perCall }) +
        Metric({ label: "Spent", value: props.spent }) +
        Metric({
          label: "Left",
          value: props.left,
          tone: props.exhausted ? "warn" : "normal",
        }),
    )}
    </div>
    <div class="meter">
      <div
        class="meter-track"
        role="meter"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow="${Math.round(ratio)}"
        aria-label="How much of the signed budget was spent"
      >
        <div class="meter-fill ${props.exhausted ? "over" : ""}" style="width: ${ratio.toFixed(1)}%"></div>
      </div>
      <div class="meter-legend">
        <span class="legend-left">${props.spent} spent</span>
        <span class="legend-right">${props.budget} signed</span>
      </div>
    </div>
  </dl>`;
}

/**
 * A bare meter, for a page that does not use the whole session bar.
 *
 * @param {{ratio: number, left: string, right: string, label: string, over?: boolean}} props
 * @returns {string}
 */
export function Meter(props) {
  const ratio = Math.max(0, Math.min(100, props.ratio));
  return html`<div class="meter">
    <div
      class="meter-track"
      role="meter"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${Math.round(ratio)}"
      aria-label="${props.label}"
    >
      <div class="meter-fill ${props.over ? "over" : ""}" style="width: ${ratio.toFixed(1)}%"></div>
    </div>
    <div class="meter-legend">
      <span class="legend-left">${props.left}</span>
      <span class="legend-right">${props.right}</span>
    </div>
  </div>`;
}
