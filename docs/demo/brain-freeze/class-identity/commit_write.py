"""Finding 1, the committing arm: store one record, keep the compiled class.

Four scripts, four separate processes, run in this order:

    gemdb class-identity/commit_write.py
    gemdb class-identity/commit_read.py
    gemdb class-identity/abort_write.py
    gemdb class-identity/abort_read.py

The two arms differ in one token -- `gemdb.commit()` here, `gemdb.abort()` in
`abort_write.py` -- and in which of the two identical `sample_*.py` modules
they import.  Everything else, including the class source, is the same.  The
finding is the difference in what the *reading* scripts print.

Importing a `.py`-backed module compiles it, and compiling creates its class
in the repository, so the session is dirty before this script runs a line of
its own.  Committing keeps that class; see `abort_write.py` for the other
choice.
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

import sample_committed

gemdb.commit()  # keep the class the import above just compiled

with gemdb.transaction():
    gemdb.root["finding1_committed"] = sample_committed.Sample(7)

print("stored n =", gemdb.root["finding1_committed"].n)
print("id(Sample) in the writing session:", id(sample_committed.Sample))
