/**
 * Reader + matcher for `riskmap-signature-pack/v1` packs.
 *
 * The ruleset owns the surface→atom mappings (what a callee or pattern means); this
 * module owns the extraction mechanics (loading, normalization, matching). It reads
 * the JSON packs under `data/signatures/`, so detection knowledge lives in one place.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type MatchMode =
  | "exact"
  | "base"
  | "suffix"
  | "exact_or_suffix"
  | "substring"
  | "regex";

export type GateAction = "drop" | "downweight";

export interface SignatureRule {
  readonly id: string;
  readonly atom: string;
  readonly surface: string;
  readonly method: string;
  readonly languages: readonly string[];
  readonly mode: MatchMode;
  readonly values: readonly string[];
  readonly confidence: number;
  readonly summary: string;
  readonly priority: number;
  /** Index within the pack's `signatures` list — the stable tiebreak. */
  readonly order: number;
  readonly caseSensitive: boolean;
}

export interface ObservationGate {
  readonly id: string;
  readonly atom: string;
  readonly languages: readonly string[];
  readonly needs: readonly string[];
  readonly action: GateAction;
  readonly downweightMultiplier: number;
}

export interface CalleeClassification {
  readonly atom: string;
  readonly confidence: number;
  readonly summary: string;
}

/** A parsed `content`-surface signature (regex → atom over raw text). */
export interface ContentSignature {
  readonly id: string;
  readonly atom: string;
  readonly regex: RegExp;
  readonly confidence: number;
  readonly summary: string;
  readonly capPerFile: number | null;
  readonly mechanic: boolean;
  readonly contextRegex: RegExp | null;
  readonly order: number;
}

/** Map pack `regex_flags` names to JS RegExp flag letters. */
function reFlagLetters(spec: unknown): string {
  const map: Record<string, string> = { ignore_case: "i", multiline: "m", dotall: "s" };
  const out = new Set<string>();
  if (Array.isArray(spec)) for (const f of spec) { const m = map[String(f)]; if (m) out.add(m); }
  return [...out].join("");
}

/**
 * Compile a Python-authored pattern as a JS RegExp. Handles leading inline flag
 * groups (`(?im)…` — valid in Python, not JS) by hoisting them to JS flags, and
 * returns null when the pattern uses syntax JS can't express (skipped, not fatal).
 */
export function compilePattern(src: string, flagSpec: unknown, extra = ""): RegExp | null {
  let pattern = src;
  let flags = reFlagLetters(flagSpec) + extra;
  const lead = pattern.match(/^\(\?([imsxau]+)\)/);
  if (lead) {
    for (const c of lead[1]!) if ("ims".includes(c) && !flags.includes(c)) flags += c;
    pattern = pattern.slice(lead[0].length);
  }
  try {
    return new RegExp(pattern, [...new Set(flags)].join(""));
  } catch {
    return null;
  }
}

export class SignaturePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignaturePackError";
  }
}

const SCHEMA_VERSION = "riskmap-signature-pack/v1";

/** Mirror of Python `_norm`: fold member separators, then lowercase. */
function norm(callee: string, caseSensitive: boolean): string {
  const out = callee.replaceAll("::", ".").replaceAll("->", ".");
  return caseSensitive ? out : out.toLowerCase();
}

/** Mirror of Python `_matches`. */
function matches(callee: string, rule: SignatureRule): boolean {
  const n = norm(callee, rule.caseSensitive);
  const values = rule.caseSensitive
    ? rule.values
    : rule.values.map((v) => v.toLowerCase());
  const base = n.split(".").at(-1) ?? n;
  switch (rule.mode) {
    case "exact":
      return values.includes(n);
    case "base":
      return values.includes(base);
    case "suffix":
      return values.some((v) => n.endsWith(v));
    case "exact_or_suffix":
      return values.some((v) => n === v || n.endsWith("." + v));
    case "substring":
      return values.some((v) => n.includes(v));
    case "regex": {
      const flags = rule.caseSensitive ? "" : "i";
      return rule.values.some((v) => new RegExp(v, flags).test(n));
    }
    default:
      throw new SignaturePackError(
        `unsupported match mode ${JSON.stringify(rule.mode)} in ${rule.id}`,
      );
  }
}

export class SignaturePack {
  constructor(
    readonly id: string,
    readonly version: string,
    readonly path: string,
    readonly rules: readonly SignatureRule[],
    readonly observationGates: readonly ObservationGate[],
    readonly contentSignatures: readonly ContentSignature[] = [],
  ) {}

  /** First matching `callee`-surface rule for `lang`, highest priority first. */
  classifyCallee(callee: string, lang: string): CalleeClassification | null {
    for (const rule of this.rulesFor(lang)) {
      if (rule.surface === "callee" && matches(callee, rule)) {
        return { atom: rule.atom, confidence: rule.confidence, summary: rule.summary };
      }
    }
    return null;
  }

  /** Match an engine-normalized binary import symbol to (atom, summary), pack order. */
  classifyImport(symbol: string): { atom: string; summary: string } | null {
    for (const rule of this.rules) {
      if (rule.surface !== "binary-import") continue;
      if (rule.values.some((v) => symbol.includes(v))) {
        return { atom: rule.atom, summary: rule.summary };
      }
    }
    return null;
  }

  /** Flatten observation gates to the legacy `(lang, atom, needs, action)` shape. */
  legacyImportGates(): Array<[string, string, readonly string[], GateAction]> {
    const out: Array<[string, string, readonly string[], GateAction]> = [];
    for (const gate of this.observationGates) {
      for (const lang of gate.languages) {
        out.push([lang, gate.atom, gate.needs, gate.action]);
      }
    }
    return out;
  }

  private rulesFor(lang: string): SignatureRule[] {
    return this.rules
      .filter((r) => r.languages.includes(lang) || r.languages.includes("*"))
      .sort((a, b) => b.priority - a.priority || a.order - b.order);
  }
}

export function loadSignaturePack(path: string): SignaturePack {
  const abs = resolve(path);
  if (!abs.toLowerCase().endsWith(".json")) {
    throw new SignaturePackError(
      `unsupported signature pack extension for ${abs} ` +
        `(signature packs must be JSON, e.g. data/signatures/packs/*.json)`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    throw new SignaturePackError(`cannot read signature pack ${abs}: ${(e as Error).message}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new SignaturePackError(`malformed signature pack ${abs}: ${(e as Error).message}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new SignaturePackError(
      `malformed signature pack ${abs}: top-level document must be an object`,
    );
  }
  const doc = data as Record<string, unknown>;
  structuralValidate(doc, abs);
  return parsePack(doc, abs);
}

function structuralValidate(data: Record<string, unknown>, path: string): void {
  const required = ["schema_version", "id", "version", "signatures"];
  const missing = required.filter((k) => !(k in data));
  if (missing.length) {
    throw new SignaturePackError(`invalid signature pack ${path}: missing ${missing.join(", ")}`);
  }
  if (data.schema_version !== SCHEMA_VERSION) {
    throw new SignaturePackError(
      `invalid signature pack ${path}: unsupported schema_version ${JSON.stringify(
        data.schema_version,
      )}`,
    );
  }
  if (!Array.isArray(data.signatures)) {
    throw new SignaturePackError(`invalid signature pack ${path}: signatures must be a list`);
  }
}

function parsePack(data: Record<string, unknown>, path: string): SignaturePack {
  const rules: SignatureRule[] = [];
  const signatures = (data.signatures as Array<Record<string, unknown>>) ?? [];
  signatures.forEach((row, i) => {
    const surface = String(row.surface);
    // `callee` + `binary-import` are `match`-based rules. `content` is regex-based
    // and parsed separately below.
    if (surface !== "callee" && surface !== "binary-import") return;
    const match = (row.match as Record<string, unknown>) ?? {};
    try {
      rules.push({
        id: String(row.id),
        atom: String(row.atom),
        surface,
        method: String(row.method ?? "static-source"),
        languages: (row.languages as unknown[]).map(String),
        mode: String(match.mode) as MatchMode,
        values: (match.values as unknown[]).map(String),
        confidence: Number(row.confidence),
        summary: String(row.summary),
        priority: Number(row.priority ?? 0),
        order: i,
        caseSensitive: Boolean(match.case_sensitive ?? false),
      });
    } catch (e) {
      throw new SignaturePackError(
        `invalid signature in ${path} at signatures[${i}]: ${(e as Error).message}`,
      );
    }
  });

  const contentSignatures: ContentSignature[] = [];
  signatures.forEach((row, i) => {
    if (String(row.surface) !== "content") return;
    const regex = compilePattern(String(row.regex), row.regex_flags, "g");
    if (regex === null) return; // JS-incompatible pattern — skipped, not fatal
    const ctx = (row.requires_context as Record<string, unknown>) ?? {};
    const anyRegex = ctx.any_regex as unknown[] | undefined;
    const contextRegex =
      anyRegex && anyRegex.length
        ? compilePattern(anyRegex.map(String).join("|"), ctx.regex_flags)
        : null;
    contentSignatures.push({
      id: String(row.id),
      atom: String(row.atom),
      regex,
      confidence: Number(row.confidence),
      summary: String(row.summary),
      capPerFile: row.cap_per_file != null ? Number(row.cap_per_file) : null,
      mechanic: Boolean(row.mechanic ?? false),
      contextRegex,
      order: i,
    });
  });

  const gates: ObservationGate[] = [];
  const rawGates = (data.observation_gates as Array<Record<string, unknown>>) ?? [];
  rawGates.forEach((row, i) => {
    const ctx = (row.requires_context as Record<string, unknown>) ?? {};
    const needs =
      (ctx.any_text as unknown[]) ??
      (ctx.imports_any as unknown[]) ??
      (ctx.all_text as unknown[]) ??
      (ctx.imports_all as unknown[]);
    try {
      gates.push({
        id: String(row.id),
        atom: String(row.atom),
        languages: (row.languages as unknown[]).map(String),
        needs: (needs as unknown[]).map(String),
        action: String(ctx.on_missing) as GateAction,
        downweightMultiplier: Number(ctx.downweight_multiplier ?? 0.5),
      });
    } catch (e) {
      throw new SignaturePackError(
        `invalid observation gate in ${path} at observation_gates[${i}]: ${(e as Error).message}`,
      );
    }
  });

  if (rules.length === 0 && contentSignatures.length === 0) {
    throw new SignaturePackError(`invalid signature pack ${path}: no usable signatures found`);
  }
  return new SignaturePack(String(data.id), String(data.version), path, rules, gates, contentSignatures);
}
