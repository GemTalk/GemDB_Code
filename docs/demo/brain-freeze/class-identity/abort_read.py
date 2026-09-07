"""Finding 1, the aborting arm: read the record back in a new session.

    gemdb class-identity/abort_read.py

Run after `abort_write.py`.  The record is there and its data is intact, so
nothing looks broken -- but the class this session compiled is not the one the
record was written with, and `isinstance` says so.  Five seconds and
identical source are not enough; the commit is.
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

gemdb.abort()

record = gemdb.root["finding1_aborted"]
print("read n =", record.n)
print("isinstance(record, Sample):", isinstance(record, sample_aborted.Sample))
print("type(record) is Sample:", type(record) is sample_aborted.Sample)
print("id(Sample) in this session:", id(sample_aborted.Sample))
