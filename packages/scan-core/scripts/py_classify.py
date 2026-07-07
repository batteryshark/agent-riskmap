"""Parity helper: classify a list of (callee, lang) cases with the *Python*
signature-pack matcher, so the TS port can be diffed against ground truth.

Reads the same pack file the TS side loads. Uses `SignaturePack.classify_callee`
directly (the matcher), isolating pack-matching parity from engine-side wrapping.
"""

import json
import os
import sys

from prlx.signatures import load_source_callee_pack

pack = load_source_callee_pack(os.environ["PARITY_PACK_PATH"])
if pack is None:
    print("could not load pack", file=sys.stderr)
    sys.exit(2)

cases = json.load(open(os.environ["PARITY_CASES_PATH"], encoding="utf-8"))
out = []
for c in cases:
    hit = pack.classify_callee(c["callee"], c["lang"])
    out.append(None if hit is None else {"atom": hit[0], "confidence": hit[1], "summary": hit[2]})

json.dump(out, sys.stdout)
