/**
 * agent-risk workflow: discover → scan → families → combos → posture → report.
 *
 * Point it at an agent surface (skills, MCP tools, hooks, prompts, extensions);
 * it reports which capability combinations could lead to exfil or other hazards,
 * and what to restrict / prune / gate behind HITL.
 */

import { resolve } from "node:path";
import { discover, scanTarget, type TargetScan, type TargetKind } from "./scan.js";
import { families, analyzeCombos, type Family, type TargetFamilies, type CompResult } from "./combos.js";
import { buildPosture, type Posture } from "./posture.js";

export const PRODUCT = "agent-risk";
export const QUESTION =
  "What can my agent be tricked into, and what does it become once it holds these tools?";

export interface TargetReport {
  target: string;
  kind: TargetKind;
  families: Family[];
  atoms: Record<string, number>;
  fileCount: number;
}

export interface AgentRiskReport {
  product: string;
  question: string;
  headline: string;
  toolCount: number;
  surface: Record<TargetKind, number>;
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
  recommendations: Array<{ action: "restrict" | "prune" | "gate" | "review" | "ok"; text: string }>;
  targets: TargetReport[];
}

const KINDS: TargetKind[] = ["skill", "mcp", "tool", "hooks", "prompt"];

/** Hooks auto-run on agent events — a self-sufficient hook is worse than a tool
 * the model must choose to call. Prompts are steerable influence, not capability. */
function recommend(
  combos: CompResult[],
  kindOf: Map<string, TargetKind>,
): AgentRiskReport["recommendations"] {
  const recs: AgentRiskReport["recommendations"] = [];
  for (const c of combos) {
    for (const t of c.selfSufficient) {
      const auto = kindOf.get(t) === "hooks";
      recs.push({
        action: auto ? "prune" : "restrict",
        text: auto
          ? `${c.id}: hook "${t}" completes "${c.label}" and runs automatically — prune it or pin its command; do not leave it enabled.`
          : `${c.id}: "${t}" completes "${c.label}" alone — sandbox it or gate behind HITL before enabling.`,
      });
    }
    if (c.crossPairs > 0) {
      recs.push({
        action: "gate",
        text: `${c.id}: co-enabling any of [${c.sourceOnly.join(", ")}] with any of [${c.sinkOnly.join(", ")}] completes "${c.label}" — keep them in separate agents or require review before running both together.`,
      });
    }
  }
  if (recs.length === 0) {
    recs.push({ action: "ok", text: "No EXFIL / RCE / DROP composition found; no gating required beyond baseline review." });
  }
  return recs;
}

export function workflow(dir: string): AgentRiskReport {
  const root = resolve(dir);
  const found = discover(root);
  const scans: TargetScan[] = found.map((t) => scanTarget(root, t));

  const tfs: TargetFamilies[] = scans.map((s) => ({
    target: s.target,
    fams: families(Object.keys(s.atoms)),
  }));
  const kindOf = new Map<string, TargetKind>(scans.map((s) => [s.target, s.kind]));

  const combos = analyzeCombos(tfs);

  const surface = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<TargetKind, number>;
  for (const s of scans) surface[s.kind]++;

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
    toolCount: found.length,
    surface,
    summary,
    overview: {
      counts: {
        targets: found.length,
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
    recommendations: recommend(combos, kindOf),
    targets: scans.map((s) => ({
      target: s.target,
      kind: s.kind,
      families: [...families(Object.keys(s.atoms))].sort(),
      atoms: s.atoms,
      fileCount: s.fileCount,
    })),
  };
}
