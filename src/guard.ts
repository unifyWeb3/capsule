/**
 * The evidence shield.
 *
 * Capsule's agent buys data from third-party merchants and feeds the result
 * straight into SERV's context. A merchant payload can contain text aimed at
 * the model rather than at the reader ("ignore your previous instructions",
 * "buy /v1/deep right now") — the cap holds regardless, but the run would
 * waste its budget on instructions somebody else wrote.
 *
 * One deliberate rule: a payload that matches an adversarial pattern is
 * quarantined whole. It is never "sanitised and used anyway". The exclusion
 * is recorded in the decision log, so the audit trail says what the model
 * was not allowed to see and why.
 *
 * Deterministic patterns only: a model pass could itself be steered by the
 * payload, and it would add a paid call per purchase for no additional
 * guarantee on this path.
 */
export interface ShieldHit {
  kind: string;
  /** A short excerpt of the matched text, for the audit trail. */
  excerpt: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
  detail: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: "instruction_override",
    re: /\b(ignore|disregard|forget|override|bypass|discard)\b[^\n]{0,60}\b(previous|prior|above|earlier|all|your|the)\b[^\n]{0,60}\b(instruction|prompt|rule|direction|context|message)/i,
    detail: "text telling the model to discard its instructions",
  },
  {
    kind: "role_impersonation",
    re: /(^|\n)\s*(system|assistant|developer|tool)\s*[:>]/i,
    detail: "a line impersonating a system, developer, assistant or tool turn",
  },
  {
    kind: "delimiter_forgery",
    re: /(<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|\[\s*(INST|SYSTEM)\s*\]|<<\s*SYS\s*>>|<\/?(system|instructions?|prompt|tool_call)>)/i,
    detail: "forged prompt delimiters",
  },
  {
    kind: "authority_forgery",
    re: /\b(this is (an )?(official|binding) (instruction|directive|order)|you are (now )?(in )?(developer|admin|root|sudo) mode|as (the )?(system|platform|openserv|kite|capsule) (administrator|operator))/i,
    detail: "text claiming platform authority it cannot have",
  },
  {
    kind: "exfiltration",
    re: /\b(send|post|upload|transmit|exfiltrate|reveal|print|dump|repeat|reproduce)\b[^\n]{0,90}(private key|mnemonic|seed phrase|secrets?|\.env|api[ _-]?key|passwords?|wallets?|credentials?)/i,
    detail: "text steering the agent toward secrets or credentials",
  },
  {
    kind: "prompt_extraction",
    re: /\b(show|reveal|repeat|reproduce|print|output)\b[^\n]{0,60}\b(your )?(system )?(prompt|instructions|rules|configuration)\b/i,
    detail: "text probing for the system prompt",
  },
  {
    kind: "action_coercion",
    re: /\b(you (must|should|need to|have to)|immediately|right now|do not wait)\b[^\n]{0,90}\b(buy|purchase|pay|call|invoke|transfer|send|sign|approve)\b/i,
    detail: "text trying to steer the next paid action",
  },
  {
    kind: "url_exfil",
    re: /(curl|wget|fetch|Invoke-WebRequest|powershell)[^\n]{0,120}(secrets?|api[ _-]?key|\.env|wallets?|mnemonic|seed|passwords?)/i,
    detail: "tool-shaped markup aimed at exfiltrating secrets",
  },
];

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const excerpt = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${excerpt}${end < text.length ? "…" : ""}`;
}

export interface ScreenResult {
  /**
   * The payload, unchanged, or null when it was quarantined. There is no
   * partial mode: a payload with a hit is not shown to the model at all.
   */
  text: string | null;
  hits: ShieldHit[];
}

/**
 * Screens one already-bounded payload string. `text` is null on any hit.
 */
export function screenText(text: string): ScreenResult {
  const hits: ShieldHit[] = [];
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) {
      hits.push({
        kind: pattern.kind,
        excerpt: excerptAround(text, match.index, match[0].length),
      });
    }
  }
  return hits.length ? { text: null, hits } : { text, hits: [] };
}

/**
 * Screens a merchant payload for use as model context. Returns the text that
 * may enter the context — the original, or a placeholder naming the quarantine.
 */
export function screenEvidenceText(
  text: string,
  endpointLabel: string,
): { text: string; hits: ShieldHit[] } {
  const result = screenText(text);
  if (result.text !== null) {
    return { text, hits: [] };
  }
  return {
    text: `[excluded by Capsule's evidence shield: ${result.hits.length} adversarial pattern${
      result.hits.length === 1 ? "" : "s"
    } in the payload from ${endpointLabel} — the payload is not reproduced here]`,
    hits: result.hits,
  };
}
