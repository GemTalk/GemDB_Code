"""Finding 1, the aborting arm: store one record, throw the class away.

    gemdb class-identity/abort_write.py

The same script as `commit_write.py` with `gemdb.abort()` in place of
`gemdb.commit()`, against its own copy of the class.  Aborting also clears
the session, so the transaction below still runs and the record is still
stored -- which is what makes this the trap rather than an obvious mistake.
What is discarded is the compiled class, and `abort_read.py` is where that
shows up.
"""

import os
import sys

import gemdb

# `gemdb file.py` does not put the script's own directory on the import path,
# the way `python3 file.py` makes it `sys.path[0]`.  Grail's resolver searches
# grailDir, its bundled stdlib, its own extra roots and then `sys.path` -- and
# under `importlib runPath:` that list is empty, so a sibling module is simply
# not found.  These two lines are the fix, they are what CPython would make
# redundant, and every script here that imports a sibling needs them first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sample_aborted

gemdb.abort()  # discard the class the import above just compiled

with gemdb.transaction():
    gemdb.root["finding1_aborted"] = sample_aborted.Sample(7)

print("stored n =", gemdb.root["finding1_aborted"].n)
print("id(Sample) in the writing session:", id(sample_aborted.Sample))
