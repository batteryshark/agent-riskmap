import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { resolveSourceCalleePack, taxonomyRoot } from "../src/index.js";

test("real pack validates against the taxonomy JSON schema", () => {
  const root = taxonomyRoot();
  assert.ok(root, "parallax-taxonomy sibling not found; set PRLX_TAXONOMY_ROOT");
  const schema = JSON.parse(readFileSync(join(root, "signatures", "schema.json"), "utf8"));
  const packPath = resolveSourceCalleePack();
  assert.ok(packPath, "source-callees.json not found under the taxonomy checkout");
  const pack = JSON.parse(readFileSync(packPath, "utf8"));

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema);
  const ok = validate(pack);
  assert.ok(ok, `pack failed schema validation:\n${JSON.stringify(validate.errors, null, 2)}`);
});
