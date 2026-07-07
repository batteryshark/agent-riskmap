/**
 * agent-risk workflow: sweep → scan → families → combos → posture → report.
 * Output shape faithful to prlx-agent-risk/product.py.
 */

import { resolve } from "node:path";
import { sweep, scanTarget, type TargetScan } from "./scan.js";
import { families, analyzeCombos, type Family, type TargetFamilies, type CompResult } from "./combos.js";
import { buildPosture, type Posture } from "./posture.js";

export const PRODUCT = "agent-risk";
export const QUESTION =
  "What can my agent be tricked into, and what does it become once it holds these tools?";

export interface AgentRiskReport {
  product: string;
  question: string;
  headline: string;
  toolCount: number;
  summary: { capable: number; steerable: number; inert: number };
  overview: {
    counts: { targets: number; selfSufficientTargets: number; crossSkillPairings: number };
    selfSufficientTargets: string[];
    crossSkillCompositions: Array<{
      id: string;
      label: string;
      sourceOnly: string[];
      sinkOnly: string[];
      pairings: number;
    }>;
  };
  posture: Posture;
  combos: CompResult[];
  recommendations: string[];
  targets: Array<{ target: string; families: Family[]; atoms: Record<string, number>; fileCount: number }>;
}

function recommend(combos: CompResult[], selfSuff: string[]): string[] {
  const recs: string[] = [];
  for (const c of combos) {
    if (c.selfSufficient.length) {
      recs.push(
        `${c.id}: ${c.selfSufficient.join(", ")} complete "${c.label}" alone — sandbox or gate before enabling.`,
      );
    }
    if (c.crossPairs > 0) {
      recs.push(
        `${c.id}: co-enabling any of [${c.sourceOnly.join(", ")}] with any of [${c.sinkOnly.join(", ")}] completes "${c.label}" — require review before running both in one agent.`,
      );
    }
  }
  if (recs.length === 0) recs.push("No abuse-path compositions found; no gating required beyond baseline review.");
  return recs;
}

export function workflow(dir: string): AgentRiskReport {
  const root = resolve(dir);
  const targets = sweep(root);
  const scans: TargetScan[] = targets.map((t) => scanTarget(root, t));

  const tfs: TargetFamilies[] = scans.map((s) => ({
    target: s.target,
    fams: families(Object.keys(s.atoms)),
  }));

  const combos = analyzeCombos(tfs);

  const capFams = (f: Set<Family>) => [...f].some((x) => x !== "AITM");
  const summary = {
    capable: tfs.filter((t) => capFams(t.fams)).length,
    steerable: tfs.filter((t) => t.fams.has("AITM")).length,
    inert: tfs.filter((t) => t.fams.size === 0).length,
  };

  const selfSuffSet = new Set<string>();
  for (const c of combos) c.selfSufficient.forEach((t) => selfSuffSet.add(t));
  const selfSufficientTargets = [...selfSuffSet].sort();
  const crossSkillPairings = combos.reduce((n, c) => n + c.crossPairs, 0);

  let headline: string;
  if (selfSufficientTargets.length === 0 && crossSkillPairings === 0) {
    headline = "No abuse-path combinations found across this surface.";
  } else if (selfSufficientTargets.length > 0) {
    const n = selfSufficientTargets.length;
    headline = `${n} target${n > 1 ? "s" : ""} complete an abuse path alone; ${crossSkillPairings} co-enable pairing${crossSkillPairings !== 1 ? "s" : ""}.`;
  } else {
    headline = `No single target completes an abuse path alone; ${crossSkillPairings} co-enable pairing${crossSkillPairings !== 1 ? "s" : ""} ${crossSkillPairings === 1 ? "does" : "do"}.`;
  }

  const allFams = new Set<Family>();
  for (const t of tfs) for (const f of t.fams) allFams.add(f);
  const posture = buildPosture(allFams);

  return {
    product: PRODUCT,
    question: QUESTION,
    headline,
    toolCount: targets.length,
    summary,
    overview: {
      counts: {
        targets: targets.length,
        selfSufficientTargets: selfSufficientTargets.length,
        crossSkillPairings,
      },
      selfSufficientTargets,
      crossSkillCompositions: combos
        .filter((c) => c.crossPairs > 0)
        .map((c) => ({ id: c.id, label: c.label, sourceOnly: c.sourceOnly, sinkOnly: c.sinkOnly, pairings: c.crossPairs })),
    },
    posture,
    combos,
    recommendations: recommend(combos, selfSufficientTargets),
    targets: scans.map((s) => ({
      target: s.target,
      families: [...families(Object.keys(s.atoms))].sort(),
      atoms: s.atoms,
      fileCount: s.fileCount,
    })),
  };
}
