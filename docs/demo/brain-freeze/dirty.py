"""Finding 2: calling a function for the first time dirties the session.

    gemdb dirty.py

Grail compiles a Python function to a Smalltalk method the *first* time it is
called, and that compilation is a repository write.  So a session can commit
its imports, be clean, call one function that stores nothing and touches no
persistent object, and be dirty again -- with nothing of its own in the
changes.  The next `with gemdb.transaction():` then raises
PendingChangesError, and cannot say why: `gemdb._pending_imports()` answers
`[]`, because no *import* is pending.

`score_answers` is the function used here because it is the purest one in the
demo -- arithmetic over a dict, no database types anywhere near it.  Nothing
in this script writes to the store, and it does not need `model.connect()`.

`model._settle()` is the fix, and every writer in `model.py` calls it
immediately before opening its transaction.
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

import underwriting as uw

# Rule 1: the imports above compiled two modules, which is a write.
gemdb.commit()
print("after imports+commit:", gemdb.needs_commit())

ANSWERS = {
    "age": 13,
    "gender": "female",
    "hair_colour": "red",
    "siblings": 3,
    "birth_order": "youngest",
    "handedness": "left",
    "tongue_roll": "no",
    "cilantro_soap": "yes",
    "favorite_flavor": "mint choc chip",
    "spoon_or_straw": "straw",
    "eating_speed": "competitive",
    "prior_freezes": 9,
    "can_whistle": "no",
    "pineapple_pizza": "undecided",
    "shoe_size": 7,
    "slushies_last_month": 14,
}

score, tier, _breakdown = uw.score_answers(ANSWERS)
print("score", score, tier, "| after first score_answers call:", gemdb.needs_commit())

gemdb.commit()
score, tier, _breakdown = uw.score_answers(ANSWERS)
print("after SECOND score_answers call:", gemdb.needs_commit())

# The reason the PendingChangesError above would have been unreadable: the
# session is dirty, and the list of pending imports is empty.
print("gemdb._pending_imports():", gemdb._pending_imports())
