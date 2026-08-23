"""Put the rabbit in the hat.

Run it once, from anywhere:

    gemdb hide.py

Nothing here opens a file, chooses a format, or serialises anything. The
assignment puts a Python object in the database, and commit() is the moment
it becomes visible to everyone else.
"""

import gemdb

RABBIT = r"""
  (\_/)
  (•.•)
 _(")_(") 
(   X   )
  ( ) ( )
"""

gemdb.root["hat"] = RABBIT
gemdb.commit()

print("Rabbit stowed.")
