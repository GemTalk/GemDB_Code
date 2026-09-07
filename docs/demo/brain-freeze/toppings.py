"""Finding 3: a schema change keeps `isinstance` and loses the attribute.

    gemdb toppings.py

CUJ-4 adds `flavor` and `toppings` to `Claim`.  `seed.py` produces both
shapes of record in one store: sixteen claims with no such fields, and
BFI-C-000017, written through `file_claim(..., extra=...)`, carrying both --
which is exactly the difference between a claim filed before a schema change
and one filed after it.

This script reads one of each back through `model.claim_as_dict`, the same
function for both, and then shows what direct attribute access does to the
older record.  It only reads, so it can be run as often as you like without
changing the dataset `verify.py` prints.
"""

import os
import sys

# `gemdb file.py` does not put the script's own directory on the import path,
# the way `python3 file.py` makes it `sys.path[0]`.  Grail's resolver searches
# grailDir, its bundled stdlib, its own extra roots and then `sys.path` -- and
# under `importlib runPath:` that list is empty, so a sibling module is simply
# not found.  These two lines are the fix, they are what CPython would make
# redundant, and every script here that imports a sibling needs them first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model

OLD_CLAIM = "BFI-C-000005"  # filed before the fields existed
NEW_CLAIM = "BFI-C-000017"  # filed with them

store = model.refresh()

print("read back through claim_as_dict -- the same function for both shapes:")
for claim_id in (OLD_CLAIM, NEW_CLAIM):
    fields = model.claim_as_dict(store["claims"][claim_id])
    print("  %s  flavor=%r  toppings=%r" % (fields["claim_id"], fields["flavor"], fields["toppings"]))
print()

old = store["claims"][OLD_CLAIM]
print("isinstance(old_claim, model.Claim):", isinstance(old, model.Claim))
print("kind_of(old_claim):", model.kind_of(old))
try:
    old.flavor
except AttributeError as exc:
    print("direct attribute access on the older claim:", type(exc).__name__, "-", exc)
