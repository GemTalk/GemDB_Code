"""Pull the rabbit out of the hat.

    gemdb reveal.py

A different process from the one that put it there, so a different database
session — and, if you stopped the database in between, a different run of the
database itself. There is no load step because there was no save step.
"""

import gemdb

if "hat" not in gemdb.root:
    raise SystemExit("The hat is empty. Run hide.py first.")

print(gemdb.root["hat"])
