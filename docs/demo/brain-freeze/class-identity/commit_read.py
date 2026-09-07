"""Finding 1, the committing arm: read the record back in a new session.

    gemdb class-identity/commit_read.py

Run after `commit_write.py`.  Same module, unchanged source, different
process.  `isinstance` answers True and `id(Sample)` is the same number the
writing session printed, because the class it compiled was committed rather
than thrown away.
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

gemdb.commit()

record = gemdb.root["finding1_committed"]
print("read n =", record.n)
print("isinstance(record, Sample):", isinstance(record, sample_committed.Sample))
print("type(record) is Sample:", type(record) is sample_committed.Sample)
print("id(Sample) in this session:", id(sample_committed.Sample))
