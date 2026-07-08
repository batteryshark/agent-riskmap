/**
 * agent-riskmap workflow: discover → scan → profile → hazards → posture → report.
 *
 * Point it at an agent surface; it profiles each skill along the seven risk
 * dimensions (docs/RISK-TAXONOMY.md), composes them into the six agent-native
 * hazards, assigns a pessimistic posture, and says what to restrict / prune / gate.
 * The deterministic pass is a high-recall floor; the triage loop refines it.
 */

import { resolve } from "node:path";
import { discover, scanTarget, type TargetScan, type TargetKind } from "./scan.js";
import {
  buildProfile, DIMENSIONS,
  type Dimension, type Facet, type DimensionProfile, type DimHint,
} from "./dimensions.js";
import { analyzeHazards, selfSufficientHazards, type HazardResult, type HazardId } from "./hazards.js";
import { tierOfProfile, surfacePosture, type Posture, type Tier } from "./severity.js";
import { descriptionGap } from "./plain.js";

export const PRODUCT = "agent-riskmap";
export const QUESTION =
  "What can each of these skills be tricked into, and what does my agent become once it holds them?";

export interface TargetReport {
  target: string;
  kind: TargetKind;
  description?: string;
  dimensions: Dimension[];
  facets: Facet[];
  hazards: HazardId[]; // self-sufficient for these
  tier: Tier;
  multipliers: Dimension[]; // which fired (guardrail / steerability / persistence)
  undisclosed: string[]; // detected capability (plain English) the declared description doesn't account for
  hints: DimHint[]; // capped, for triage evidence
  verdict?: { status: string; label: string | null; result: string }; // triage, when a ledger is merged
}

export interface AgentRiskReport {
  product: string;
  question: string;
  headline: string;
  toolCount: number;
  surface: Record<TargetKind, number>;
  summary: { capable: number; steerable: number; inert: number };
  posture: Posture;
  hazards: HazardResult[];
  overview: {
    counts: { targets: number; selfSufficientTargets: number; crossSkillPairings: number };
    selfSufficientTargets: string[];
    crossSkillCompositions: Array<{ id: HazardId; label: string; aName: string; bName: string; aOnly: string[]; bOnly: string[]; pairings: number }>;
  };
  recommendations: Array<{ action: "restrict" | "prune" | "gate" | "review" | "ok"; text: string }>;
  targets: TargetReport[];
}

const KINDS: TargetKind[] = ["skill", "mcp", "tool", "hooks", "prompt"];

function recommend(hazards: HazardResult[], kindOf: Map<string, TargetKind>): AgentRiskReport["recommendations"] {
  const recs: AgentRiskReport["recommendations"] = [];
  for (const h of hazards) {
    for (const t of h.selfSufficient) {
      const auto = kindOf.get(t) === "hooks";
      recs.push({
        action: auto ? "prune" : "restrict",
        text: auto
          ? `${h.id}: hook "${t}" is self-sufficient (${h.label}) and runs automatically — prune or pin it.`
          : `${h.id}: "${t}" is self-sufficient for this hazard (${h.label}) — sandbox or gate behind HITL before enabling.`,
      });
    }
    if (h.crossPairs > 0) {
      recs.push({
        action: "gate",
        text: `${h.id}: co-enabling any of [${h.aOnly.join(", ")}] (${h.aName}) with any of [${h.bOnly.join(", ")}] (${h.bName}) enables this hazard (${h.label}) — keep them in separate agents or require review.`,
      });
    }
  }
  if (recs.length === 0) recs.push({ action: "ok", text: "No hazard composition found; no gating required beyond baseline review." });
  return recs;
}

/** Assemble a full report from a set of dimension profiles (static skills and/or
 * live-probed MCP servers). Profiles carry their kind, so this is source-agnostic. */
export function assembleReport(profiles: DimensionProfile[]): AgentRiskReport {
  const kindOf = new Map<string, TargetKind>(profiles.map((p) => [p.target, p.kind]));
  const hazards = analyzeHazards(profiles);
  const posture = surfacePosture(profiles);

  const surface = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<TargetKind, number>;
  for (const p of profiles) surface[p.kind]++;

  const POWER: Dimension[] = ["authority", "data", "latent", "reach", "persistence"];
  const summary = {
    capable: profiles.filter((p) => POWER.some((d) => p.dims.has(d))).length,
    steerable: profiles.filter((p) => p.dims.has("steerability")).length,
    inert: profiles.filter((p) => p.dims.size === 0).length,
  };

  const selfSet = new Set<string>();
  for (const h of hazards) h.selfSufficient.forEach((t) => selfSet.add(t));
  const selfSufficientTargets = [...selfSet].sort();
  const crossSkillPairings = hazards.reduce((n, h) => n + h.crossPairs, 0);

  let headline: string;
  if (selfSufficientTargets.length === 0 && crossSkillPairings === 0) {
    headline = "No hazard compositions found across this surface.";
  } else if (selfSufficientTargets.length > 0) {
    const n = selfSufficientTargets.length;
    headline = `${n} skill${n > 1 ? "s" : ""} can complete a hazard alone; ${crossSkillPairings} co-enable pairing${crossSkillPairings !== 1 ? "s" : ""}.`;
  } else {
    headline = `No single skill completes a hazard alone; ${crossSkillPairings} co-enable pairing${crossSkillPairings !== 1 ? "s" : ""} ${crossSkillPairings === 1 ? "does" : "do"}.`;
  }

  return {
    product: PRODUCT,
    question: QUESTION,
    headline,
    toolCount: profiles.length,
    surface,
    summary,
    posture,
    hazards,
    overview: {
      counts: { targets: profiles.length, selfSufficientTargets: selfSufficientTargets.length, crossSkillPairings },
      selfSufficientTargets,
      crossSkillCompositions: hazards
        .filter((h) => h.crossPairs > 0)
        .map((h) => ({ id: h.id, label: h.label, aName: h.aName, bName: h.bName, aOnly: h.aOnly, bOnly: h.bOnly, pairings: h.crossPairs })),
    },
    recommendations: recommend(hazards, kindOf),
    targets: profiles.map((p) => {
      const posture = tierOfProfile(p);
      return {
        target: p.target,
        kind: p.kind,
        description: p.description,
        dimensions: DIMENSIONS.filter((d) => p.dims.has(d)),
        facets: [...p.facets].sort(),
        hazards: selfSufficientHazards(p),
        tier: posture.tier,
        multipliers: posture.multipliers,
        undisclosed: descriptionGap(p, p.description),
        hints: p.hints.slice(0, 12),
      };
    }),
  };
}

/** Static scan of a directory surface (skills / tools / hooks / prompts / MCP refs). */
export function workflow(dir: string): AgentRiskReport {
  const root = resolve(dir);
  const found = discover(root);
  const scans: TargetScan[] = found.map((t) => scanTarget(root, t));
  const profiles: DimensionProfile[] = scans.map((s) =>
    buildProfile(s.target, s.kind, s.atoms, s.evidence, s.dimHints, s.description),
  );
  return assembleReport(profiles);
}

/**
 * Full surface scan: the static pass, plus (when `connect`) live introspection of
 * every MCP server declared in the surface's configs — the opaque servers fold in
 * as delegated-trust targets alongside the skills. Async + side-effecting (it
 * connects to servers), so it's opt-in and separate from the pure `workflow`.
 */
export async function scanSurface(
  dir: string,
  opts: { connect?: boolean; readResources?: boolean; driveSearch?: boolean; secretsEnv?: string } = {},
): Promise<AgentRiskReport> {
  const root = resolve(dir);
  const found = discover(root);
  const scans = found.map((t) => scanTarget(root, t));
  // Static profiles, minus the shallow "mcp ref" targets we're about to probe live.
  const staticProfiles = scans
    .filter((s) => !(opts.connect && s.kind === "mcp"))
    .map((s) => buildProfile(s.target, s.kind, s.atoms, s.evidence, s.dimHints, s.description));

  if (!opts.connect) return assembleReport(staticProfiles);

  const { findMcpConfigFiles } = await import("./scan.js");
  const { scanMcpConfig } = await import("./mcp/index.js");
  const live: DimensionProfile[] = [];
  for (const cfgPath of findMcpConfigFiles(root)) {
    try {
      const reports = await scanMcpConfig(cfgPath, { secretsEnv: opts.secretsEnv, readResources: opts.readResources, driveSearch: opts.driveSearch });
      for (const r of reports) live.push(r.profile);
    } catch { /* a config that can't be probed is skipped; static targets remain */ }
  }
  return assembleReport([...staticProfiles, ...live]);
}
