"""Act 5: put BFI-P-000001 back in force, so the lapse can be watched live.

    gemdb reinstate.py

Nothing here talks to the web app, and the web app is not restarted, told to
reload, or polled.  The next request it serves calls `model.refresh()` like
every other request, and sees this write -- which is the whole of the
cross-surface promise, in one line of application code.

`lapse.py` is the same line with the other status.  Run this one first if the
store came from `seed.py`, which leaves this policy lapsed: with it active,
`lapse.py` and one curl show the running app changing its answer with no
restart, which is what Act 5 is for.
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

POLICY_ID = "BFI-P-000001"
STATUS = "active"

store = model.refresh()
was = store["policies"][POLICY_ID].status
policy = model.set_policy_status(store, POLICY_ID, STATUS)
print("%s was: %s" % (POLICY_ID, was))
print("%s is now: %s" % (POLICY_ID, policy.status))
