/**
 * Hazards = dangerous compositions of dimensions (see docs/RISK-TAXONOMY.md).
 *
 * Each hazard is two roles, A and B, each a predicate over a skill's dimension
 * profile. A skill is **self-sufficient** for a hazard when it fills both roles
 * alone; two skills form a **cross-skill pairing** when one fills A-only and the
 * other B-only — harmless apart, an abuse path once co-enabled in one agent.
 * This generalizes v1's EXFIL/RCE/DROP source→sink model to seven dimensions.
 */

import { has, hasFacet, type DimensionProfile } from "./dimensions.js";

export type HazardId = "EXFIL" | "COMMS" | "DESTROY" | "GUARDRAIL" | "RCE" | "PERSIST";

interface HazardDef {
  id: HazardId;
  label: string;
  aName: string;
  bName: string;
  a: (p: DimensionProfile) => boolean;
  b: (p: DimensionProfile) => boolean;
}

export const HAZARDS: HazardDef[] = [
  {
    id: "EXFIL",
    label: "read sensitive data, then send it off-host",
    aName: "reads sensitive data",
    bName: "can send off-host",
    a: (p) => hasFacet(p, "data:sensitive"),
    b: (p) => hasFacet(p, "reach:egress"),
  },
  {
    id: "COMMS",
    label: "sends something out you didn't intend (on untrusted input)",
    aName: "outbound authority",
    bName: "reads untrusted input",
    a: (p) => hasFacet(p, "authority:outbound"),
    b: (p) => has(p, "steerability"),
  },
  {
    id: "DESTROY",
    label: "destroys something you didn't intend (on untrusted input)",
    aName: "destructive authority",
    bName: "reads untrusted input",
    a: (p) => hasFacet(p, "authority:destructive"),
    b: (p) => has(p, "steerability"),
  },
  {
    id: "GUARDRAIL",
    label: "runs code / delegates while bypassing safety",
    aName: "arbitrary code / delegation",
    bName: "bypasses a guardrail",
    a: (p) => has(p, "latent"),
    b: (p) => has(p, "guardrail"),
  },
  {
    id: "RCE",
    label: "untrusted input drives code execution",
    aName: "reads untrusted input",
    bName: "runs code",
    a: (p) => has(p, "steerability"),
    b: (p) => has(p, "latent"),
  },
  {
    id: "PERSIST",
    label: "standing autonomous capability that survives sessions",
    aName: "arbitrary code / delegation",
    bName: "persists / runs unattended",
    a: (p) => has(p, "latent"),
    b: (p) => has(p, "persistence"),
  },
];

export interface HazardResult {
  id: HazardId;
  label: string;
  aName: string;
  bName: string;
  selfSufficient: string[];
  aOnly: string[];
  bOnly: string[];
  crossPairs: number;
}

/** Analyze every hazard across the profiled skills. */
export function analyzeHazards(profiles: DimensionProfile[]): HazardResult[] {
  return HAZARDS.map((h) => {
    const selfSufficient: string[] = [];
    const aOnly: string[] = [];
    const bOnly: string[] = [];
    for (const p of profiles) {
      const a = h.a(p);
      const b = h.b(p);
      if (a && b) selfSufficient.push(p.target);
      else if (a) aOnly.push(p.target);
      else if (b) bOnly.push(p.target);
    }
    return {
      id: h.id,
      label: h.label,
      aName: h.aName,
      bName: h.bName,
      selfSufficient,
      aOnly,
      bOnly,
      crossPairs: aOnly.length * bOnly.length,
    };
  });
}

/** Hazards a single profile is self-sufficient for (used to headline a skill). */
export function selfSufficientHazards(p: DimensionProfile): HazardId[] {
  return HAZARDS.filter((h) => h.a(p) && h.b(p)).map((h) => h.id);
}
