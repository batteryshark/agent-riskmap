/**
 * The agent-skill risk dimensions (see docs/RISK-TAXONOMY.md).
 *
 * A skill is profiled along seven dimensions. Signals come from two sources:
 *   - ATOMS: the code capability atoms from scan-core (deterministic, syntactic).
 *   - PATTERNS: high-signal instruction phrases matched over the skill's text —
 *     the cheap deterministic hints for the semantic-heavy dimensions.
 * Both are *hints*. They pre-score every skill (pessimistically) for the semantic
 * pass to confirm, refine, or downgrade — never the final word.
 */

import type { TargetKind } from "./scan.js";

export type Dimension =
  | "authority" // ① outward / irreversible effects (send, post, delete, deploy)
  | "data" //      ② sensitive data it can read
  | "latent" //    ③ arbitrary code / delegation / installs — extends the agent's power
  | "guardrail" // ④ weakens or bypasses safety (a multiplier)
  | "steerability" // ⑤ consumes untrusted content that can steer it (injection surface)
  | "reach" //     ⑥ network egress / external services
  | "persistence"; // ⑦ runs unattended / schedules / survives sessions

export const DIMENSIONS: Dimension[] = [
  "authority", "data", "latent", "guardrail", "steerability", "reach", "persistence",
];

/** Facets that hazard composition needs to distinguish within a dimension. */
export type Facet =
  | "authority:outbound" // send / post / share / publish — Unauthorized Communication
  | "authority:destructive" // delete / overwrite / revoke — Destructive Action
  | "reach:egress"
  | "data:sensitive";

export interface DimHint {
  dimension: Dimension;
  facet?: Facet;
  source: "atom" | "pattern";
  detail: string; // atom id or pattern label
  evidence: string; // matched token / phrase
  path?: string;
  line?: number;
}

// ── atom → dimension (the v1 code atoms become hints, not the whole story) ──────

// Code atoms are the PRECISE signals. Note: ARTF.URL (any URL in text) is
// deliberately NOT reach — doc links are everywhere; only real network calls count.
const ATOM_MAP: Array<{ test: (a: string) => boolean; dim: Dimension; facet?: Facet }> = [
  { test: (a) => a.startsWith("CRED"), dim: "data", facet: "data:sensitive" },
  { test: (a) => a === "FSYS.SENSITIVE" || a === "ARTF.CREDENTIAL", dim: "data", facet: "data:sensitive" },
  { test: (a) => a.startsWith("NETW"), dim: "reach", facet: "reach:egress" },
  { test: (a) => a.startsWith("EXEC") || a.startsWith("LOAD"), dim: "latent" },
  { test: (a) => a === "PKGM.INSTALL" || a === "PKGM.BINDOWN" || a === "PKGM.HOOK", dim: "latent" },
  { test: (a) => a === "FSYS.WRITE", dim: "authority" }, // write ≠ destructive by default
  { test: (a) => a === "FSYS.DELETE", dim: "authority", facet: "authority:destructive" },
  // PRIV.* atoms (sudo/token content sigs) are NOT mapped to guardrail — they fire on
  // prose like "no sudo needed". Guardrail comes only from the precise bypass pattern.
  { test: (a) => a.startsWith("PRST") || a === "TIME.SCHED", dim: "persistence" },
  { test: (a) => a.startsWith("AITM"), dim: "steerability" },
];

/** Map observed atoms → dimension hints. */
export function atomHints(
  atoms: Record<string, number>,
  evidence: Array<{ atom: string; path: string; line: number; evidence: string }>,
): DimHint[] {
  const byAtom = new Map<string, { path: string; line: number; evidence: string }>();
  for (const e of evidence) if (!byAtom.has(e.atom)) byAtom.set(e.atom, e);
  const out: DimHint[] = [];
  for (const atom of Object.keys(atoms)) {
    for (const m of ATOM_MAP) {
      if (m.test(atom)) {
        const e = byAtom.get(atom);
        out.push({ dimension: m.dim, facet: m.facet, source: "atom", detail: atom, evidence: e?.evidence ?? atom, path: e?.path, line: e?.line });
        break;
      }
    }
  }
  return out;
}

// ── instruction patterns: the new deterministic hints for semantic-heavy dims ──
// High recall on purpose (a pessimistic prior); the semantic pass prunes FPs.

interface DimPattern { dimension: Dimension; facet?: Facet; re: RegExp; label: string }

// Tuned for PRECISION, not recall — a pattern hit should mean the phrase is a real
// signal, not a casual mention. Recall is the semantic pass's job (it reads every
// skill). Broad keyword nets (bare `token`, any `https://`, `hook`, `schedule`) were
// removed because they flagged nearly everything.
export const DIM_PATTERNS: DimPattern[] = [
  // ④ guardrail — the cheapest, highest-signal win (flags claude-code/codex for free)
  { dimension: "guardrail", label: "permission-bypass", re: /--dangerously-skip-permissions|--yolo\b|bypass(ing|es)?\s+(the\s+)?(permission|confirmation|safety|guard)|skip(ping|s)?\s+(the\s+)?(permission|confirmation)\s*(prompt|dialog|check|s)?|auto[-\s]?(approve|accept|confirm)\s+(the\s+)?(permission|dialog|prompt|tool|action|command)|disabl(e|es|ed|ing)\s+(the\s+)?(safety|sandbox|protection|guardrail)|without\s+asking\s+(for\s+)?(permission|confirmation|approval|the\s+user)/i },
  // ③ latent capability / delegation (real delegation phrases; code-exec is covered by EXEC/LOAD atoms)
  { dimension: "latent", label: "delegation", re: /spawn(s|ing)?\s+(a\s+|an\s+)?(sub-?agent|autonomous|coding\s+agent)|delegate(s|d)?\s+(coding|the\s+task|tasks?|work|to\s+(claude|codex|an?\s+agent))|autonomous\s+(coding\s+)?agent|\bsub-?agents?\b|\bclaude\s+code\b|\bcodex\s+(cli|agent)|run(s|ning)?\s+arbitrary\s+(shell|code|commands?)/i },
  // ⑥ reach — real network calls come from NETW atoms; here only explicit egress phrases
  { dimension: "reach", facet: "reach:egress", label: "egress", re: /\bwebhook\b|\bexfiltrat|POST(ing|s)?\s+(it|them|the\s+\w+|data|to\s+https?)|upload(s|ing|ed)?\s+(it|them|the\s+\w+|to\s+(a\s+)?(server|url|endpoint|bucket|s3|cloud|api))|send(s|ing)?\s+(it|them|the\s+\w+|data)\s+to\s+(a\s+)?(https?|server|url|endpoint|remote)/i },
  // ⑦ persistence — standing/unattended only (not "hook"/"background"/"schedule")
  { dimension: "persistence", label: "persistence", re: /\bcron(tab|\s+job)?\b|launchd|systemd|\.plist\b|launch\s?agent|on\s+(boot|login|startup)|\bdaemon\b|runs?\s+(unattended|in\s+the\s+background\s+(indefinitely|continuously)|continuously)|long-?running\s+(process|server|daemon|service)|installs?\s+a\s+(hook|service|daemon|cron)/i },
  // ① authority — outbound (send/post/publish something on your behalf)
  { dimension: "authority", facet: "authority:outbound", label: "outbound-action", re: /\bsend(s|ing)?\s+(an?\s+|the\s+|your\s+)?(e-?mail|message|text|dm|sms|reply|notification)|\be-?mails?\s+(it|them|the|your|a\b)|\bpost(s|ing)?\s+(to|on|a\s+(tweet|message|comment|status|reply))|\bpublish(es|ing|ed)?\s+(to|the|a\b)|\btweet(s|ing|ed)?\b|create(s|d)?\s+(a\s+)?(pull\s+request|pr\b|issue|comment)|git\s+push|\bshares?\s+(it|them|the|your)\b/i },
  // ① authority — destructive (delete/overwrite/revoke on your behalf)
  { dimension: "authority", facet: "authority:destructive", label: "destructive-action", re: /\brm\s+-[rf]|\bdelete(s|d)?\s+(the|a|an|all|your|every|files?|records?|repo|branch|message|email|the\s+entire)|force[-\s]?push|\brevoke(s|d)?\s+(the|a|access|token|key|credential)|\boverwrite(s|n|ing)?\s+(the|a|your|existing)|\btruncate(s|d)?\s+(the|a|table)|drop(s|ping|ped)?\s+(the\s+)?(table|database|collection|schema)|\bwipe(s|d)?\s+(the|a|all|your)/i },
  // ② data — sensitive scope (specific stores/paths; not bare token/key)
  { dimension: "data", facet: "data:sensitive", label: "sensitive-data", re: /\bcredentials?\b|\bapi[_\s-]?keys?\b|\baccess[_\s-]?token|\boauth[_\s-]?token|\bpasswords?\b|\.aws\b|\.ssh\b|\.env\b|keychain|\bprivate\s+key|your\s+(inbox|mailbox|calendar|contacts|emails?|messages)|\bbrowser\s+(history|cookies)|\.git-credentials|\bsecret[_\s-]?(key|token|value)/i },
  // ⑤ steerability — consumes untrusted external content that could steer it
  { dimension: "steerability", label: "untrusted-input", re: /ignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions|untrusted\s+(input|content|source|data|user)|prompt\s+injection|follow(s|ing)?\s+(the\s+)?instructions?\s+(in|from)\s+(the|any|a\b)|(fetch|scrape|read|parse|process)(es|s|ing)?\s+(the\s+|a\s+|remote\s+|external\s+|incoming\s+)?(web\s?page|url|website|email|inbox|pdf|html|the\s+response|external\s+\w+|untrusted)/i },
];

const PATTERN_CAP = 3; // hints per pattern per file — enough to evidence, not flood

/** Match dimension patterns over one file's text → hints (capped). */
export function scanDimensionPatterns(text: string, path: string): DimHint[] {
  const out: DimHint[] = [];
  for (const p of DIM_PATTERNS) {
    let n = 0;
    const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
    for (const m of text.matchAll(re)) {
      if (n >= PATTERN_CAP) break;
      n++;
      let line = 1;
      const idx = m.index ?? 0;
      for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") line++;
      out.push({ dimension: p.dimension, facet: p.facet, source: "pattern", detail: p.label, evidence: m[0].slice(0, 60), path, line });
    }
  }
  return out;
}

// ── the per-skill profile ──────────────────────────────────────────────────────

export interface DimensionProfile {
  target: string;
  kind: TargetKind;
  dims: Set<Dimension>;
  facets: Set<Facet>;
  hints: DimHint[];
}

export function has(p: DimensionProfile, d: Dimension): boolean {
  return p.dims.has(d);
}
export function hasFacet(p: DimensionProfile, f: Facet): boolean {
  return p.facets.has(f);
}

/** Combine atom hints + pattern hints into a per-skill dimension profile. */
export function buildProfile(
  target: string,
  kind: TargetKind,
  atoms: Record<string, number>,
  atomEvidence: Array<{ atom: string; path: string; line: number; evidence: string }>,
  patternHints: DimHint[],
): DimensionProfile {
  const hints = [...atomHints(atoms, atomEvidence), ...patternHints];
  const dims = new Set<Dimension>();
  const facets = new Set<Facet>();
  for (const h of hints) {
    dims.add(h.dimension);
    if (h.facet) facets.add(h.facet);
  }
  return { target, kind, dims, facets, hints };
}
