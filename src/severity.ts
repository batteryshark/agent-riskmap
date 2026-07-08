/**
 * Severity / posture — generalized and pessimistic (see docs/RISK-TAXONOMY.md §3).
 *
 * blast radius = worst reachable power dimension, then multipliers push it UP:
 * guardrail-bypass and autonomy default to the worst case ("critical until proven
 * otherwise"). Only the semantic pass may downgrade, on the record. The v1 formula
 * (blast × steerability) is the special case where AITM is the only multiplier.
 */

import { has, type DimensionProfile, type Dimension } from "./dimensions.js";

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
  const strong = new Set(p.hints.filter((h) => h.source === "atom").map((h) => h.dimension));
  if (HIGH_POWER.some((d) => strong.has(d))) return { label: "high", rank: 3 };
  if (HIGH_POWER.some((d) => p.dims.has(d))) return { label: "medium", rank: 2 }; // mention only
  if (MED_POWER.some((d) => p.dims.has(d))) return { label: "medium", rank: 2 };
  return { label: "informational", rank: 0 };
}

/**
 * Pessimistic tier for one profile. guardrail present + any real power → critical;
 * steerability or persistence each push a capable skill up a tier.
 */
export function tierOfProfile(p: DimensionProfile): Posture {
  const { label: blast, rank } = blastOf(p);
  let score = rank;
  const multipliers: Dimension[] = [];

  if (has(p, "guardrail") && score >= 2) {
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
  score = Math.max(0, Math.min(4, score));

  const reach = [...p.dims].filter((d) => HIGH_POWER.includes(d) || MED_POWER.includes(d)).sort();
  const tier = TIERS[score]!;
  const headline =
    tier === "minimal"
      ? "Minimal: no high-reach capability detected."
      : `${cap(tier)}: ${blast} blast radius${multipliers.length ? `, ${multipliers.join("+")} multiplier${multipliers.length > 1 ? "s" : ""}` : ""}; power: ${reach.join(", ") || "none"}.`;
  return { tier, score, blast, multipliers, reach, headline };
}

/** Posture across the whole surface = the worst-case skill. */
export function surfacePosture(profiles: DimensionProfile[]): Posture {
  if (profiles.length === 0) {
    return { tier: "minimal", score: 0, blast: "informational", multipliers: [], reach: [], headline: "Minimal: nothing to assess." };
  }
  let worst = tierOfProfile(profiles[0]!);
  for (const p of profiles.slice(1)) {
    const t = tierOfProfile(p);
    if (t.score > worst.score) worst = t;
  }
  return worst;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
