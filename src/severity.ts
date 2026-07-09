/**
 * Severity / posture — generalized and pessimistic (see docs/RISK-TAXONOMY.md §3).
 *
 * blast radius = worst reachable power dimension, then multipliers push it UP:
 * guardrail-bypass and autonomy default to the worst case ("critical until proven
 * otherwise"). Only the semantic pass may downgrade, on the record. The v1 formula
 * (blast × steerability) is the special case where AITM is the only multiplier.
 */

import { has, type DimensionProfile, type Dimension } from "./dimensions.js";
import { hasUndisclosedPower } from "./plain.js";

export type Tier = "critical" | "elevated" | "moderate" | "minimal";

const TIERS: Tier[] = ["minimal", "minimal", "moderate", "elevated", "critical"]; // score 0..4

// Power dimensions carry blast radius. guardrail, steerability, and persistence are
// MULTIPLIERS (they amplify capability), not blast on their own — so they are not
// listed here; a bare "cron" or "bypass" mention with no capability is not a blast.
const HIGH_POWER: Dimension[] = ["latent", "data"];
const MED_POWER: Dimension[] = ["authority", "reach"];

export interface Posture {
  tier: Tier;
  score: number;
  blast: "high" | "medium" | "informational";
  multipliers: Dimension[]; // which multipliers fired (guardrail / steerability / persistence)
  reach: Dimension[]; // power dimensions present
  headline: string;
}

/**
 * Blast radius, weighting evidence: an ATOM-backed power dimension (real code that
 * reads creds / runs exec) is high; a PATTERN-only mention (the skill just *talks*
 * about API keys) is medium — a mention is not an access.
 */
function blastOf(p: DimensionProfile): { label: Posture["blast"]; rank: number } {
  // Person-reaching authority (text/iMessage/SMS to anyone, DM your contacts) is high blast
  // on its own: contacting real people is irreversible and enables impersonation / social
  // engineering / spam — a lot of standing authority regardless of code-vs-instruction.
  if (p.facets.has("authority:broadcast")) return { label: "high", rank: 3 };
  // Strong = real evidence: code atoms OR a live MCP server's advertised tools.
  // Prose pattern mentions are weaker (a mention is not an access).
  const strong = new Set(p.hints.filter((h) => h.source === "atom" || h.source === "mcp").map((h) => h.dimension));
  if (HIGH_POWER.some((d) => strong.has(d))) return { label: "high", rank: 3 };
  if (HIGH_POWER.some((d) => p.dims.has(d))) return { label: "medium", rank: 2 }; // mention only
  if (MED_POWER.some((d) => p.dims.has(d))) return { label: "medium", rank: 2 };
  return { label: "informational", rank: 0 };
}

/**
 * Pessimistic tier for one profile. guardrail present + any real power → critical
 * (absolute). steerability / persistence / delegated-trust each amplify a capable skill,
 * but they escalate to CRITICAL only when the amplified power is a "surprise" — power the
 * skill's label doesn't disclose — or a guardrail bypass is present. Expected, disclosed
 * power (an email client that sends email) caps at "elevated" (gate it), not "critical"
 * (alarm). Pass `undisclosedPower` from `hasUndisclosedPower` at the caller.
 */
export function tierOfProfile(p: DimensionProfile, opts: { undisclosedPower?: boolean } = {}): Posture {
  const { label: blast, rank } = blastOf(p);
  let score = rank;
  const multipliers: Dimension[] = [];
  const surprise = opts.undisclosedPower ?? false;

  const guardrail = has(p, "guardrail") && score >= 2;
  if (guardrail) {
    multipliers.push("guardrail");
    score = 4; // capable + bypasses safety → critical, until proven otherwise
  }
  if (has(p, "steerability") && rank >= 2) {
    multipliers.push("steerability");
    score += 1;
  }
  if (has(p, "persistence") && rank >= 2) {
    multipliers.push("persistence");
    score += 1;
  }
  // ⑧ delegated-trust: an opaque, mutable third party you can't pin amplifies
  // everything — you're trusting code you can't read and that can change under you.
  if (has(p, "delegated-trust") && rank >= 2) {
    multipliers.push("delegated-trust");
    score += 1;
  }
  score = Math.max(0, Math.min(4, score));

  // Surprise gate: a multiplier alone doesn't make disclosed power "critical". Reserve the
  // top tier for a guardrail bypass, an opaque third party you can't read (delegated-trust
  // is an inherent surprise), or power the label hides. "Does what it says, and it's a lot"
  // is a gate decision (elevated), not an alarm (critical).
  if (score >= 4 && !guardrail && !surprise && !has(p, "delegated-trust")) score = 3;

  const reach = [...p.dims].filter((d) => HIGH_POWER.includes(d) || MED_POWER.includes(d)).sort();
  const tier = TIERS[score]!;
  const headline =
    tier === "minimal"
      ? "Minimal: no high-reach capability detected."
      : `${cap(tier)}: ${blast} blast radius${multipliers.length ? `, ${multipliers.join("+")} multiplier${multipliers.length > 1 ? "s" : ""}` : ""}; power: ${reach.join(", ") || "none"}.`;
  return { tier, score, blast, multipliers, reach, headline };
}

/** Tier a profile, computing its own surprise signal from its description. */
export function tierOf(p: DimensionProfile): Posture {
  return tierOfProfile(p, { undisclosedPower: hasUndisclosedPower(p, p.description) });
}

/** Posture across the whole surface = the worst-case skill. */
export function surfacePosture(profiles: DimensionProfile[]): Posture {
  if (profiles.length === 0) {
    return { tier: "minimal", score: 0, blast: "informational", multipliers: [], reach: [], headline: "Minimal: nothing to assess." };
  }
  let worst = tierOf(profiles[0]!);
  for (const p of profiles.slice(1)) {
    const t = tierOf(p);
    if (t.score > worst.score) worst = t;
  }
  return worst;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
