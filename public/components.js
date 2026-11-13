/**
 * The component gallery.
 *
 * Every component, with its props and a live example. It is the usage
 * documentation, and it cannot drift from the code, because it renders the
 * components rather than describing them.
 *
 * The controller's whole job is to hold the examples and hand them to the
 * gallery component; the markup belongs to `components/gallery.js`.
 */
import {
  Callout,
  Caveat,
  DataTable,
  Field,
  GalleryGrid,
  Meter,
  Metric,
  Panel,
  RecordList,
  RunList,
  SessionBar,
  StatusChip,
  SurfaceGrid,
  Tag,
  TraceList,
  empty,
  failed,
  html,
  loading,
  mount,
} from "./components/index.js";

const EXAMPLES = [
  {
    name: "StatusChip",
    props: "{ kind: 'settled' | 'refused' | 'verified' | 'fault' | 'neutral', label?: string }",
    example: `<p class="chips">
      ${StatusChip({ kind: "settled" })}
      ${StatusChip({ kind: "refused" })}
      ${StatusChip({ kind: "verified" })}
      ${StatusChip({ kind: "fault" })}
      ${StatusChip({ kind: "neutral" })}
      ${Tag({ text: "beta", tone: "accent" })}
    </p>`,
  },
  {
    name: "Metric",
    props: "{ label: string, value: string, detail?: string, tone?: 'normal' | 'warn' }",
    example: `<dl class="session" style="margin:0">${Metric({
      label: "Budget you signed",
      value: "$0.0025",
      detail: "the session's total budget",
    })}</dl>`,
  },
  {
    name: "SessionBar",
    props: "{ budget, perCall, spent, left, spentRatio, exhausted }, all strings except the ratio and the flag",
    example: SessionBar({
      budget: "$0.0025",
      perCall: "$0.002",
      spent: "$0.0020",
      left: "$0.0005",
      spentRatio: 80,
      exhausted: false,
    }),
  },
  {
    name: "Meter",
    props: "{ ratio: number, left: string, right: string, label: string, over?: boolean }",
    example: Meter({
      ratio: 80,
      left: "$0.0020 spent",
      right: "$0.0025 signed",
      label: "How much of the signed budget was spent",
    }),
  },
  {
    name: "RecordList",
    props: "{ rows: Array<{ n, path, host, price, outcome, reason, fact?, thinking?, tx? }> }",
    example: RecordList({
      rows: [
        {
          n: 0,
          path: "/api/crypto-price",
          host: "agent402.tools",
          price: "$0.001",
          outcome: "paid",
          reason: "the session allowed it",
          fact: "current ETH price and 24h change",
          thinking:
            "This purchase adds the fact to cover: current ETH price and 24h change, which is the best available direct match within budget.",
          tx: {
            hash: "0xf222835b302b905f6d00c5e620cfc59a7b97c1f1d9672eb4c9cdd682e3ecde4e",
            explorer: "https://basescan.org",
            confirmations: 138848,
            recipient: "0xabf4fabd7c416fb0000000000000000000000",
          },
        },
        {
          n: 1,
          path: "/trend-over-time",
          host: "google-trends.use.x402atlas.com",
          price: "$0.05",
          outcome: "refused",
          reason:
            "over the cap you signed for a single purchase, so the Passport refused to release the money",
          fact: "search interest and trend over the last month",
          errorCode: "session_rule_exceeded",
        },
      ],
    }),
  },
  {
    name: "DataTable",
    props: "{ head: string[], rows: Array<Array<string | { html }>>, caption?, columnClass? }",
    example: DataTable({
      head: ["Merchant", "Transaction", "On chain"],
      rows: [
        [
          "agent402.tools",
          html`<a href="https://basescan.org" target="_blank" rel="noreferrer">0xf222835b30…</a>`,
          StatusChip({ kind: "verified", label: "confirmed" }),
        ],
        ["x402.ottoai.services", "0x9203108377…", StatusChip({ kind: "verified", label: "confirmed" })],
      ],
    }),
  },
  {
    name: "Callout",
    props: "{ title?: string, body: string, tone?: 'warn' | 'quiet' }",
    example: Callout({
      title: "The payments are chain-verified. The refusals are the owner's claim.",
      body: "A payment leaves a transaction, so anyone can re-read it. A refusal leaves nothing behind.",
    }),
  },
  {
    name: "Caveat",
    props: "{ body: string }",
    example: Caveat({
      body: "These rows were read from the chain 12 seconds ago. Every time this answer is made, the chain is read again.",
    }),
  },
  {
    name: "Panel",
    props: "{ head: string, note?: string, body: string }",
    example: Panel({
      head: "USDC on eip155:8453",
      note: "2 payments read from the chain",
      body: '<p class="caveat" style="margin:0;padding-left:0;border:none">The panel body.</p>',
    }),
  },
  {
    name: "TraceList",
    props: "{ steps: Array<{ label, detail, state }> }",
    example: TraceList({
      steps: [
        { label: "fetched the log", detail: "https://example.com/decision-log.jsonl, 3458 bytes", state: "ok" },
        { label: "parsed the records", detail: "4 decisions read", state: "info" },
        {
          label: "checked the hash chain",
          detail: "not in Capsule's format, skipped. The payments below were still verified.",
          state: "warn",
        },
        {
          label: "read the payment for Agent402 Tools",
          detail: "a transfer of 0.001 was confirmed at block 56361241",
          state: "ok",
        },
      ],
    }),
  },
  {
    name: "RunList",
    props: "{ runs: Array<{ id, label, summary, head, figures, href }> }",
    example: RunList({
      runs: [
        {
          id: "recorded",
          label: "The recorded run",
          summary: "$0.002 per call · $0.0025 in total",
          head: "0xd6af6f6b610a…",
          href: "/run.html?id=recorded",
          figures: [
            { value: "2", label: "settled" },
            { value: "2", label: "refused" },
            { value: "$0.002", label: "spent" },
            { value: "20.4×", label: "cost of limit" },
          ],
        },
      ],
    }),
  },
  {
    name: "SurfaceGrid",
    props: "{ cards: Array<{ kind, value, detail, href }> }",
    example: SurfaceGrid({
      cards: [
        {
          kind: "The log itself",
          value: "/decision-log.jsonl",
          detail: "The hash-chained decisions, one JSON object per line.",
          href: "/decision-log.jsonl",
        },
      ],
    }),
  },
  {
    name: "Field",
    props: "{ id, name, label, placeholder?, buttonLabel?, hint? }",
    example: Field({
      id: "gallery-field",
      name: "gallery-log",
      label: "The URL of a published decision log",
      placeholder: "https://example.com/decision-log.jsonl",
      hint: "A hint, described by the input for screen readers.",
    }),
  },
  {
    name: "The states",
    props: "loading(message), failed(heading, message, { onRetry }), empty(heading, message)",
    example: `${loading("Loading the recorded run…")}
      ${empty("No runs recorded", "The receipts file is written by npm run demo.")}
      ${failed("The record could not be loaded", "The chain could not be read.", {
        onRetry: () => {},
      })}`,
  },
];

mount("gallery-body", GalleryGrid({ examples: EXAMPLES }));
