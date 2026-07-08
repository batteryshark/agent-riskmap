/**
 * Locate a `parallax-taxonomy` checkout and its signature packs — the TS mirror
 * of `parallax/prlx/prlx/paths.py::taxonomy_root` +
 * `signatures.py::resolve_source_callee_pack`. Same env vars, same conventions,
 * so a scanner drops into the same layout the Python engine expects.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSignaturePack, SignaturePack, SignaturePackError } from "./signature-pack.js";

const TAXONOMY_MARKER = join("signatures", "schema.json");

function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Resolve a taxonomy checkout: `PRLX_TAXONOMY_ROOT`, else a sibling directory. */
export function taxonomyRoot(start?: string): string | null {
  const env = process.env.PRLX_TAXONOMY_ROOT;
  if (env) {
    const root = resolve(env);
    return existsSync(join(root, TAXONOMY_MARKER)) ? root : null;
  }
  const here = start ? resolve(start) : dirname(fileURLToPath(import.meta.url));
  for (const base of [here, process.cwd()]) {
    for (const dir of ancestors(base)) {
      const candidate = join(dir, "parallax-taxonomy");
      if (existsSync(join(candidate, TAXONOMY_MARKER))) return candidate;
    }
  }
  return null;
}

/** Path to the source-callee pack, honoring the same override env vars as Python. */
export function resolveSourceCalleePack(): string | null {
  const explicit =
    process.env.PRLX_SOURCE_CALLEE_PACK || process.env.PRLX_TAXONOMY_SIGNATURE_PACK;
  if (explicit) return resolve(explicit);
  const root = taxonomyRoot();
  if (root === null) return null;
  const pack = join(root, "signatures", "packs", "source-callees.json");
  return existsSync(pack) ? pack : null;
}

/**
 * Load the source-callee pack. Returns `null` when no taxonomy checkout is
 * found (graceful degradation, matching the Python engine); throws when an
 * explicit path is given but missing.
 */
export function loadSourceCalleePack(path?: string): SignaturePack | null {
  const packPath = path ? resolve(path) : resolveSourceCalleePack();
  if (packPath === null) return null;
  if (!existsSync(packPath)) {
    if (path) throw new SignaturePackError(`source callee signature pack not found: ${packPath}`);
    return null;
  }
  return loadSignaturePack(packPath);
}
