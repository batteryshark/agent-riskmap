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
};

export const FACET_PLAIN: Record<Facet, string> = {
  "authority:outbound": "send or post things on your behalf (email, messages, PRs)",
  "authority:destructive": "delete or overwrite things",
  "reach:egress": "send data off your machine",
  "data:sensitive": "read sensitive data like passwords, keys, and tokens",
};

/** A plain abuse sentence for a self-sufficient hazard. */
export const HAZARD_PLAIN: Record<HazardId, string> = {
  EXFIL: "It can read sensitive data and send it off your machine, so if it is abused your secrets can leave the building.",
  COMMS: "It can send messages or posts on your behalf and it reads outside content, so a crafted message could make it send something you did not intend.",
  DESTROY: "It can delete or overwrite things and it reads outside content, so a crafted message could make it destroy something you did not intend.",
  GUARDRAIL: "It can run code or delegate to another agent while bypassing safety, so it can act with no one watching.",
  RCE: "It reads outside content and can run code, so untrusted input could drive code execution.",
  PERSIST: "It can run code and it runs unattended, so it keeps operating on its own across sessions.",
};

export const MULTIPLIER_PLAIN: Record<"guardrail" | "steerability" | "persistence", string> = {
  guardrail: "bypasses permission or safety prompts",
  steerability: "reads outside content that could contain hidden instructions",
  persistence: "runs unattended, across sessions",
};

/**
 * For a detected capability (facet, else dimension), which words in the declared
 * description would acknowledge it. If none of them appear, the capability is
 * undisclosed relative to its label.
 */
const DESC_HINTS: Array<{ cap: Facet | Dimension; words: RegExp }> = [
  { cap: "authority:outbound", words: /\b(send|sends|sending|sent|email|mail|post|posts|posting|publish|share|shares|tweet|message|notify|notification|dm|sms|reply|comment|pr\b|pull request|push)\b/i },
  { cap: "authority:destructive", words: /\b(delete|deletes|remove|removes|drop|drops|overwrite|overwrites|revoke|wipe|truncate|destroy|purge|clean|force.?push)\b/i },
  { cap: "data:sensitive", words: /\b(credential|secret|secrets|key|keys|token|tokens|password|oauth|aws|ssh|\.env\b|keychain|private|inbox|mailbox|calendar|contacts?|cookie|api key|api_key)\b/i },
  { cap: "reach:egress", words: /\b(network|http|https|curl|fetch|upload|uploads|webhook|post|posts|request|requests|api|server|servers|remote|url|endpoint|egress|sync|syncs)\b/i },
  { cap: "latent", words: /\b(code|codes|coding|exec|execute|run|runs|running|shell|bash|subprocess|process|spawn|spawns|delegate|delegates|agent|agents|install|installs|build|builds|compile|script|scripts|claude|codex|sandbox|docker)\b/i },
  { cap: "guardrail", words: /\b(permission|permissions|sudo|bypass|bypasses|auto-?accept|auto-?approve|dangerously|yolo|skip|skips|sandbox|guardrail)\b/i },
  { cap: "persistence", words: /\b(schedule|schedules|cron|daemon|background|unattended|hook|hooks|startup|boot|launch|service|services|persist|persists|watch|watches|poll|polls|timer|timers)\b/i },
  { cap: "steerability", words: /\b(fetch|fetches|scrape|scrapes|crawl|crawls|parse|parses|read|reads|ingest|ingests|web|webs|url|urls|email|emails|inbox|rss|feed|feeds|untrusted|external|remote|download|downloads)\b/i },
];

/**
 * Detected capabilities the declared description does not account for, as plain
 * English. Facets win over their bare dimension (more specific), so a dimension
 * only surfaces when it has no facet form detected. A capability counts as
 * "undisclosed" when it is detected but none of its hint words appear in the label.
 */
export function descriptionGap(p: DimensionProfile, description?: string): string[] {
  if (!description) return [];
  const desc = description.toLowerCase();
  const out: string[] = [];
  const coveredDims = new Set<Dimension>();

  const facetEntries = DESC_HINTS.filter((e) => e.cap.includes(":"));
  const dimEntries = DESC_HINTS.filter((e) => !e.cap.includes(":"));

  for (const { cap, words } of facetEntries) {
    const dim = cap.split(":")[0] as Dimension;
    const detected = p.facets.has(cap as Facet);
    if (!detected) continue;
    if (words.test(desc)) {
      coveredDims.add(dim); // the label accounts for this, so don't double-report the dim
      continue;
    }
    out.push(FACET_PLAIN[cap as Facet]);
    coveredDims.add(dim);
  }
  for (const { cap, words } of dimEntries) {
    const dim = cap as Dimension;
    if (coveredDims.has(dim) || !p.dims.has(dim)) continue;
    if (!words.test(desc)) out.push(DIM_PLAIN[dim]);
  }
  return out;
}

