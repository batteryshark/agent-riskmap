/**
 * Target discovery (sweep) + per-target capability scan.
 *
 * A "target" is a tool/skill/MCP-server root — the shallowest directory in a
 * branch that carries a recognizable marker. Each target's files are scanned for
 * capability atoms via scan-core (content signatures + regex-callee classification
 * against the vendored taxonomy packs).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { loadScanner } from "@stonefish-labs/scan-core";
import { rulesDataRoot } from "@stonefish-labs/rules";

const MARKERS = new Set([
  "package.json", "pyproject.toml", "setup.py", "requirements.txt",
  "mcp.json", "server.json", "SKILL.md",
]);
const DESCEND_THROUGH = new Set(["server.json"]); // bundled skills can live below these
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build",
  ".idea", ".mypy_cache", ".pytest_cache", ".tox", "site-packages",
]);
const LANG_BY_EXT: Record<string, string> = {
  ".py": "python", ".pyi": "python", ".js": "javascript", ".mjs": "javascript",
  ".cjs": "javascript", ".jsx": "javascript", ".ts": "typescript", ".tsx": "tsx",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".rb": "ruby", ".go": "go",
  ".rs": "rust", ".php": "php", ".java": "java", ".ps1": "powershell",
};
const TEXT_EXTS = new Set([
  ...Object.keys(LANG_BY_EXT), ".md", ".json", ".txt", ".yaml", ".yml",
  ".toml", ".cfg", ".ini", ".env", ".html",
]);
const MAX_FILE_BYTES = 2_000_000;
const MAX_TARGETS = 500;

export interface TargetScan {
  target: string;
  atoms: Record<string, number>;
  fileCount: number;
  evidence: Array<{ atom: string; path: string; line: number; evidence: string }>;
}

function hasMarker(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    if (MARKERS.has(name)) return name;
  }
  return null;
}

function hasSourceFile(dir: string): boolean {
  let found = false;
  const walk = (d: string): void => {
    if (found) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (LANG_BY_EXT[extname(name).toLowerCase()]) {
        found = true;
        return;
      }
    }
  };
  walk(dir);
  return found;
}

/**
 * Discover target directories (relative to root), shallowest-marker-per-branch.
 * When a collection has no markers anywhere (e.g. a folder of bare tool dirs),
 * fall back to treating each immediate child directory that holds source as a
 * target — a directory of agent tools is still a set of targets.
 */
export function sweep(root: string): string[] {
  const targets: string[] = [];
  const walk = (dir: string): void => {
    if (targets.length >= MAX_TARGETS) return;
    let marker: string | null = null;
    try {
      marker = hasMarker(dir);
    } catch {
      return;
    }
    if (marker && !DESCEND_THROUGH.has(marker)) {
      targets.push(relative(root, dir) || ".");
      return; // don't recurse past a target
    }
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      let st;
      try {
        st = statSync(join(dir, name));
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(join(dir, name));
    }
  };
  walk(root);

  if (targets.length === 0) {
    for (const name of readdirSync(root)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const p = join(root, name);
      try {
        if (statSync(p).isDirectory() && hasSourceFile(p)) targets.push(name);
      } catch {
        /* skip */
      }
    }
    if (targets.length === 0 && hasSourceFile(root)) targets.push(".");
  }
  return targets;
}

const scanner = loadScanner(rulesDataRoot());

/** Scan one target directory → aggregated atoms + evidence. */
export function scanTarget(root: string, target: string): TargetScan {
  const base = join(root, target === "." ? "" : target);
  const atoms: Record<string, number> = {};
  const evidence: TargetScan["evidence"] = [];
  let fileCount = 0;

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      const ext = extname(name).toLowerCase();
      if (!TEXT_EXTS.has(ext) || st.size > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      fileCount++;
      const lang = LANG_BY_EXT[ext] ?? "*";
      for (const o of scanner.scanText(text, lang)) {
        atoms[o.atom] = (atoms[o.atom] ?? 0) + 1;
        if (evidence.length < 200) {
          evidence.push({ atom: o.atom, path: relative(root, p), line: o.line, evidence: o.evidence });
        }
      }
    }
  };
  walk(base);
  return { target, atoms, fileCount, evidence };
}
