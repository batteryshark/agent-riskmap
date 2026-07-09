/**
 * Plain-English render layer: turns the dimension/hazard jargon into language a
 * non-security reader can act on, and computes the "description gap" — detected
 * capability the skill's declared description does not account for.
 *
 * The description (frontmatter / manifest) is a discovery label, not ground truth.
 * Capability beyond what it implies is undisclosed power, and that gap is itself a
 * risk signal. This is a cheap heuristic prior; the triage loop confirms it.
 */

import type { Dimension, DimensionProfile, Facet } from "./dimensions.js";
import type { HazardId } from "./hazards.js";

export const DIM_PLAIN: Record<Dimension, string> = {
  authority: "take outward actions on your behalf",
  data: "read data",
  latent: "run code or hand off to another agent",
  guardrail: "bypass permission or safety prompts",
  steerability: "read outside content that could carry hidden instructions",
  reach: "talk to the network",
  persistence: "run unattended or survive across sessions",
  "delegated-trust": "hand power to an opaque third party you can't read and that can change under you",
};

export const FACET_PLAIN: Record<Facet, string> = {
  "authority:outbound": "send or post things on your behalf (email, PRs, comments)",
  "authority:broadcast": "message people directly — text, iMessage, or SMS to anyone",
  "authority:destructive": "delete or overwrite things",
  "reach:egress": "send data off your machine",
  "data:sensitive": "read sensitive data like passwords, keys, and tokens",
  "trust:opaque": "run code you can't see the source of",
  "trust:volatile": "change its tools or behavior at any time",
  "trust:poisoning": "feed hidden instructions into your agent's context",
  "trust:sampling": "borrow your agent's model to run its own prompts",
  "trust:elicitation": "pop prompts to your user through your agent",
};

/** A plain, one-sentence abuse description for a self-sufficient hazard. */
export const HAZARD_PLAIN: Record<HazardId, string> = {
  EXFIL: "It can read secrets and it can send data off your machine — misused, your secrets could leave.",
  COMMS: "It can send things out and it reads untrusted content — a crafted message could make it send something you didn't intend.",
  DESTROY: "It can delete or overwrite and it reads untrusted content — a crafted message could make it destroy something you didn't intend.",
  GUARDRAIL: "It runs code (or hands off to another agent) with safety prompts bypassed — it can act with nobody watching.",
  RCE: "It reads untrusted content and it can run code — that input could end up running as code.",
  PERSIST: "It runs code and it keeps running unattended — a one-time risk becomes a standing one.",
};

/** Plain, headline-style titles for a hazard (shared by the HTML appendix and the CLI). */
export const HAZARD_TITLE: Record<HazardId, string> = {
  EXFIL: "Secrets could leave your machine",
  COMMS: "Could be tricked into sending something out",
  DESTROY: "Could be tricked into deleting something",
  GUARDRAIL: "Could run code with safety turned off",
  RCE: "Untrusted input could end up running as code",
  PERSIST: "Could keep running unattended",
};

export const MULTIPLIER_PLAIN: Record<"guardrail" | "steerability" | "persistence" | "delegated-trust", string> = {
  guardrail: "bypasses permission or safety prompts",
  steerability: "reads outside content that could contain hidden instructions",
  persistence: "runs unattended, across sessions",
  "delegated-trust": "hands power to an opaque third party that can change under you",
};

/**
 * For a detected capability (facet, else dimension), which words in the declared
 * description would acknowledge it. If none of them appear, the capability is
 * undisclosed relative to its label.
 */
const DESC_HINTS: Array<{ cap: Facet | Dimension; words: RegExp }> = [
  { cap: "authority:outbound", words: /\b(send|sends|sending|sent|email|mail|post|posts|posting|publish|share|shares|tweet|reply|comment|pr\b|pull request|push|notify|notification)\b/i },
  { cap: "authority:broadcast", words: /\b(message|messages|messaging|imessage|imessages|sms|text|texts|texting|dm|dms|whatsapp|telegram|signal|chat|chats|contacts?)\b/i },
  { cap: "authority:destructive", words: /\b(delete|deletes|remove|removes|drop|drops|overwrite|overwrites|revoke|wipe|truncate|destroy|purge|clean|force.?push)\b/i },
  { cap: "data:sensitive", words: /\b(credentials?|secrets?|keys?|tokens?|passwords?|oauth|aws|ssh|\.env\b|keychain|private|inbox|mailbox|calendar|contacts?|cookies?|api[_\s-]?keys?)\b/i },
  { cap: "reach:egress", words: /\b(network|http|https|curl|fetch|upload|uploads|webhook|post|posts|request|requests|api|server|servers|remote|url|endpoint|egress|sync|syncs)\b/i },
  { cap: "latent", words: /\b(code|codes|coding|exec|execute|run|runs|running|shell|bash|subprocess|process|spawn|spawns|delegate|delegates|agent|agents|install|installs|build|builds|compile|script|scripts|claude|codex|sandbox|docker)\b/i },
  { cap: "guardrail", words: /\b(permission|permissions|sudo|bypass|bypasses|auto-?accept|auto-?approve|dangerously|yolo|skip|skips|sandbox|guardrail)\b/i },
  { cap: "persistence", words: /\b(schedule|schedules|cron|daemon|background|unattended|hook|hooks|startup|boot|launch|service|services|persist|persists|watch|watches|poll|polls|timer|timers)\b/i },
  { cap: "steerability", words: /\b(fetch|fetches|scrape|scrapes|crawl|crawls|parse|parses|read|reads|ingest|ingests|web|webs|url|urls|email|emails|inbox|rss|feed|feeds|untrusted|external|remote|download|downloads)\b/i },
];

// Power capabilities (the ones that carry blast radius). Steerability/persistence are
// multipliers, not power — an undisclosed multiplier alone isn't the "surprise" that
// escalates a skill; undisclosed *power* is.
const POWER_CAPS: ReadonlySet<Facet | Dimension> = new Set<Facet | Dimension>([
  "data:sensitive", "reach:egress", "latent", "authority", "authority:outbound", "authority:broadcast", "authority:destructive", "guardrail",
]);

/**
 * Detected capabilities the declared description does not account for, as structured
 * caps (facet or bare dimension). Facets win over their bare dimension (more specific),
 * so a dimension only surfaces when it has no facet form detected. A capability counts
 * as "undisclosed" when it is detected but none of its hint words appear in the label.
 */
export function descriptionGapCaps(p: DimensionProfile, description?: string): Array<Facet | Dimension> {
  if (!description) return [];
  const desc = description.toLowerCase();
  const out: Array<Facet | Dimension> = [];
  const coveredDims = new Set<Dimension>();

  const facetEntries = DESC_HINTS.filter((e) => e.cap.includes(":"));
  const dimEntries = DESC_HINTS.filter((e) => !e.cap.includes(":"));

  for (const { cap, words } of facetEntries) {
    const dim = cap.split(":")[0] as Dimension;
    if (!p.facets.has(cap as Facet)) continue;
    if (words.test(desc)) {
      coveredDims.add(dim); // the label accounts for this, so don't double-report the dim
      continue;
    }
    out.push(cap as Facet);
    coveredDims.add(dim);
  }
  for (const { cap, words } of dimEntries) {
    const dim = cap as Dimension;
    if (coveredDims.has(dim) || !p.dims.has(dim)) continue;
    if (!words.test(desc)) out.push(dim);
  }
  return out;
}

/** The description gap as plain-English capability phrases. */
export function descriptionGap(p: DimensionProfile, description?: string): string[] {
  return descriptionGapCaps(p, description).map((c) =>
    typeof c === "string" && c.includes(":") ? FACET_PLAIN[c as Facet] : DIM_PLAIN[c as Dimension],
  );
}

/**
 * Does the skill hold POWER its label doesn't disclose, on STRONG evidence? This is the
 * "surprise" signal — the thing that makes a skill lead the report.
 *
 * A terse description ("Debug Python", "Search GIFs") names almost none of a skill's
 * capability, so "not in the label" alone flags nearly every capable skill — that just
 * relabels the noise. To be a real surprise, the undisclosed capability must be
 * DEMONSTRATED, not merely a prose mention: a code atom / live-observed MCP tool, or a
 * guardrail bypass (whose pattern — `--dangerously-skip-permissions` &c. — is itself
 * high-signal). Subtler, purpose-incongruent surprises are the triage loop's job to find.
 */
export function hasUndisclosedPower(p: DimensionProfile, description?: string): boolean {
  const strongDims = new Set(p.hints.filter((h) => h.source === "atom" || h.source === "mcp").map((h) => h.dimension));
  const demonstrated = (c: Facet | Dimension): boolean => {
    const dim = (typeof c === "string" && c.includes(":") ? c.split(":")[0] : c) as Dimension;
    return dim === "guardrail" || strongDims.has(dim);
  };
  if (!description) {
    return [...p.facets].some((f) => POWER_CAPS.has(f) && demonstrated(f)) || [...p.dims].some((d) => POWER_CAPS.has(d) && demonstrated(d));
  }
  return descriptionGapCaps(p, description).some((c) => POWER_CAPS.has(c) && demonstrated(c));
}

