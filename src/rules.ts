/**
 * Vendored parallax-taxonomy detection data. Mirrors the taxonomy layout
 * (`signatures/schema.json`, `signatures/packs/*.json`, `reference/*.json`) so a
 * taxonomy-aware resolver can treat `rulesDataRoot()` as a taxonomy checkout.
 *
 * Ships as JSON under `data/` (see package `files`); `../data` is one level up
 * from both `src/` (dev) and `dist/` (built).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the bundled taxonomy data root (contains signatures/ + reference/). */
export function rulesDataRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "data");
}

export const SOURCE_CALLEE_PACK = "signatures/packs/source-callees.json";
export const CONTENT_PACK = "signatures/packs/content-surfaces.json";
export const BINARY_IMPORT_PACK = "signatures/packs/binary-imports.json";
