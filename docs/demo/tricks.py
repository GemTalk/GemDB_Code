"""Count the tricks performed. Run it more than once.

    gemdb tricks.py
    gemdb tricks.py
    gemdb tricks.py

The counter goes up across processes, and across restarts of the database,
because the only place it ever lived was the database.

`gemdb.root.get(key, default)` reads the committed value, and `commit()` is
the point at which the increment becomes everyone's. Between those two lines
the new count exists only in this session — another `gemdb tricks.py` running
at the same instant would not see it, and one of the two commits would be
rejected as a conflict rather than silently losing a count.
"""

import gemdb

gemdb.root["tricks"] = gemdb.root.get("tricks", 0) + 1
gemdb.commit()

print("Tricks performed:", gemdb.root["tricks"])
