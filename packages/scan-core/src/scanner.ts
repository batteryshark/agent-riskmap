/**
 * Text scanner: apply a content pack's regex signatures and extract+classify
 * call tokens against a callee pack, producing atom observations.
 *
 * Callee extraction uses the regex fallback (`token(`) — the same fallback the
 * Python engine uses when tree-sitter is unavailable. A tree-sitter frontend can
 * replace `extractCalls` later for higher fidelity; the classification is shared.
 */

import { join } from "node:path";
import { loadSignaturePack, type SignaturePack } from "./signature-pack.js";

export interface Observation {
  readonly atom: string;
  readonly confidence: number;
  readonly summary: string;
  readonly evidence: string;
  readonly line: number;
  readonly rule: string;
}

const CALL_RE = /\b([A-Za-z_$][\w$.]*)\s*\(/g;

function lineNo(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end === -1) end = text.length;
  return text.slice(start, end);
}

export class Scanner {
  constructor(
    private readonly callee: SignaturePack | null,
    private readonly content: SignaturePack | null,
  ) {}

  /** Scan one file's text → atom observations. `lang` scopes callee classification. */
  scanText(text: string, lang = "*"): Observation[] {
    const obs: Observation[] = [];

    if (this.content) {
      for (const sig of this.content.contentSignatures) {
        let emitted = 0;
        const seen = new Set<string>();
        sig.regex.lastIndex = 0;
        for (const m of text.matchAll(sig.regex)) {
          const idx = m.index ?? 0;
          if (sig.contextRegex && !sig.contextRegex.test(lineAt(text, idx))) continue;
          const matched = m[0];
          if (seen.has(matched)) continue;
          seen.add(matched);
          if (sig.capPerFile != null && emitted >= sig.capPerFile) break;
          emitted++;
          obs.push({
            atom: sig.atom,
            confidence: sig.confidence,
            summary: sig.summary,
            evidence: matched.slice(0, 120),
            line: lineNo(text, idx),
            rule: `regex.${sig.atom}`,
          });
        }
      }
    }

    // Callee extraction only on real code (a known language). Running it on prose
    // (`lang === "*"` — markdown/text) matches words like `function(` and inflates
    // atoms; content regexes still scan all text.
    if (this.callee && lang !== "*") {
      for (const m of text.matchAll(CALL_RE)) {
        const token = m[1]!;
        const hit = this.callee.classifyCallee(token, lang);
        if (hit) {
          obs.push({
            atom: hit.atom,
            confidence: hit.confidence,
            summary: hit.summary,
            evidence: token,
            line: lineNo(text, m.index ?? 0),
            rule: `callee.${hit.atom}`,
          });
        }
      }
    }

    return obs;
  }
}

/** Load a Scanner from a taxonomy data root (contains signatures/packs/*.json). */
export function loadScanner(dataRoot: string): Scanner {
  const load = (rel: string): SignaturePack | null => {
    try {
      return loadSignaturePack(join(dataRoot, rel));
    } catch {
      return null;
    }
  };
  return new Scanner(
    load("signatures/packs/source-callees.json"),
    load("signatures/packs/content-surfaces.json"),
  );
}
