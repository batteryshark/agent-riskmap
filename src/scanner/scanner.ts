/**
 * Text scanner: apply a content pack's regex signatures and extract+classify
 * call tokens against a callee pack, producing atom observations.
 *
 * Callee extraction uses a regex fallback (`token(`) rather than a full parser. A
 * tree-sitter frontend could replace `extractCalls` later for higher fidelity; the
 * classification step is independent of how the tokens are extracted.
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

// A shell command starts at the beginning of input or right after a command
// separator / substitution opener. `curl https://x` has no `(`, so CALL_RE never
// sees it; instead we walk each command position and take its head word.
const SHELL_POS_RE = /(^|[\n;|&(){}`]|\$\()/g;
// Head word may be a bare command (`curl`), an env-assign (`FOO=bar`, skipped),
// or a path command (`/usr/bin/python3`, `./x.sh`) — basename-normalized below.
const SHELL_TOKEN_RE = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)*[A-Za-z_][\w.-]*(=\S*)?/;
// Wrapper words that precede the real command; skip them and keep reading.
const SHELL_WRAPPERS = new Set([
  "sudo", "env", "command", "exec", "xargs", "nohup", "time", "then", "do",
  "builtin", "nice", "setsid", "stdbuf", "doas",
]);

/** Extract head command words at shell command positions (basename-normalized). */
function extractShellCommands(text: string): Array<{ word: string; index: number }> {
  const out: Array<{ word: string; index: number }> = [];
  SHELL_POS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SHELL_POS_RE.exec(text)) !== null) {
    let i = m.index + m[0].length;
    for (;;) {
      while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
      const tm = SHELL_TOKEN_RE.exec(text.slice(i, i + 128));
      if (!tm) break;
      const tok = tm[0];
      if (tok.includes("=")) { i += tok.length; continue; } // FOO=bar env-assign
      const bare = tok.replace(/^.*\//, ""); // /usr/bin/python3 -> python3
      if (SHELL_WRAPPERS.has(bare)) { i += tok.length; continue; }
      out.push({ word: bare, index: i });
      break; // one command word per position
    }
    if (m[0] === "") SHELL_POS_RE.lastIndex++; // guard zero-width match
  }
  return out;
}

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
    if (this.callee && lang === "shell") {
      // Shell commands are bare words (`curl x`), not `token(` — walk command
      // positions. This is what makes hooks and .sh tools classify at all.
      for (const { word, index } of extractShellCommands(text)) {
        const hit = this.callee.classifyCallee(word, lang);
        if (hit) {
          obs.push({
            atom: hit.atom,
            confidence: hit.confidence,
            summary: hit.summary,
            evidence: word,
            line: lineNo(text, index),
            rule: `callee.${hit.atom}`,
          });
        }
      }
    } else if (this.callee && lang !== "*") {
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
