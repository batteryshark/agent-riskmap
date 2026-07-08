/**
 * Posture tier = blast radius (capability severity) × steerability (AITM present).
 * Mirror of prlx-agent-risk/posture.py `_tier`.
 */

import type { Family } from "./combos.js";

export type Tier = "critical" | "elevated" | "moderate" | "minimal";
export type Sev = "informational" | "low" | "medium" | "high" | "critical";

const RANK: Record<Sev, number> = { informational: 0, low: 1, medium: 2, high: 3, critical: 4 };

// Capability-surface severities (interpret/common.py _CAP_SURFACES).
const HIGH: ReadonlySet<Family> = new Set(["EXEC", "BROWSER", "LOAD", "CRED"]);
const MEDIUM: ReadonlySet<Family> = new Set(["NET", "FSWRITE", "INSTALL"]);

export function blastRadius(fams: Set<Family>): Sev {
  if ([...fams].some((f) => HIGH.has(f))) return "high";
  if ([...fams].some((f) => MEDIUM.has(f))) return "medium";
  return "informational";
}

function tierOf(blast: Sev, steerable: boolean): Tier {
  const b = RANK[blast];
  if (b >= RANK.critical && steerable) return "critical";
  if (b >= RANK.high || (steerable && b >= RANK.medium)) return "elevated";
  if (b >= RANK.medium) return "moderate";
  return "minimal";
}

export interface Posture {
  tier: Tier;
  blastRadius: Sev;
  steerable: boolean;
  headline: string;
  reach: Family[];
}

/** Posture across the whole scanned surface (union of all target families). */
export function buildPosture(allFams: Set<Family>): Posture {
  const steerable = allFams.has("AITM");
  const blast = blastRadius(allFams);
  const tier = tierOf(blast, steerable);
  const reach = [...allFams].filter((f) => f !== "AITM").sort();
  const headline =
    tier === "minimal"
      ? "Minimal agent risk: no high-reach capabilities on this surface."
      : `${tier[0]!.toUpperCase()}${tier.slice(1)} agent risk: ${blast} blast radius${
          steerable ? ", steerable" : ""
        }; reachable capabilities: ${reach.join(", ") || "none"}.`;
  return { tier, blastRadius: blast, steerable, headline, reach };
}
