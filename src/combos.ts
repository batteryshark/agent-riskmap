/**
 * Capability families and the dangerous compositions (EXFIL / RCE / DROP).
 *
 * A target is "self-sufficient" for a composition when it holds both the source
 * and sink families alone. Two targets form a "cross-skill" pairing when one is
 * source-only and the other sink-only — dangerous once both are co-enabled.
 * Faithful to prlx-agent-risk/combos.py.
 */

export type Family = "NET" | "BROWSER" | "EXEC" | "LOAD" | "CRED" | "FSWRITE" | "INSTALL" | "AITM";

/** Map observed atoms to capability families (mirror of combos.py `_families`). */
export function families(atoms: Iterable<string>): Set<Family> {
  const f = new Set<Family>();
  for (const a of atoms) {
    if (a.startsWith("NETW")) f.add("NET");
    else if (a === "EXEC.BROWSER") f.add("BROWSER");
    else if (a.startsWith("EXEC")) f.add("EXEC");
    else if (a.startsWith("LOAD")) f.add("LOAD");
    else if (a.startsWith("CRED")) f.add("CRED");
    else if (a === "FSYS.WRITE" || a === "FSYS.DELETE") f.add("FSWRITE");
    else if (a === "PKGM.INSTALL") f.add("INSTALL");
    else if (a.startsWith("AITM")) f.add("AITM");
  }
  return f;
}

const NETROLE: ReadonlySet<Family> = new Set(["NET", "BROWSER"]);
const EXECROLE: ReadonlySet<Family> = new Set(["EXEC", "LOAD"]);

interface Comp {
  id: "EXFIL" | "RCE" | "DROP";
  label: string;
  src: ReadonlySet<Family>;
  snk: ReadonlySet<Family>;
}

const COMPS: Comp[] = [
  { id: "EXFIL", label: "read secrets, then send them off-host", src: new Set(["CRED"]), snk: NETROLE },
  { id: "RCE", label: "network input drives code execution", src: NETROLE, snk: EXECROLE },
  { id: "DROP", label: "write a file, then execute it", src: new Set(["FSWRITE"]), snk: EXECROLE },
];

const intersects = (a: Set<Family>, b: ReadonlySet<Family>): boolean => [...a].some((x) => b.has(x));

export interface TargetFamilies {
  target: string;
  fams: Set<Family>;
}

export interface CompResult {
  id: string;
  label: string;
  selfSufficient: string[];
  sourceOnly: string[];
  sinkOnly: string[];
  crossPairs: number;
}

export function analyzeCombos(targets: TargetFamilies[]): CompResult[] {
  return COMPS.map((c) => {
    const selfSufficient: string[] = [];
    const sourceOnly: string[] = [];
    const sinkOnly: string[] = [];
    for (const t of targets) {
      const hasSrc = intersects(t.fams, c.src);
      const hasSnk = intersects(t.fams, c.snk);
      if (hasSrc && hasSnk) selfSufficient.push(t.target);
      else if (hasSrc) sourceOnly.push(t.target);
      else if (hasSnk) sinkOnly.push(t.target);
    }
    return {
      id: c.id,
      label: c.label,
      selfSufficient,
      sourceOnly,
      sinkOnly,
      crossPairs: sourceOnly.length * sinkOnly.length,
    };
  });
}
