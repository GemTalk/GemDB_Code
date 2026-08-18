## The database outlives the editor

Once started, the database keeps running after you close VS Code. That's
deliberate — it's a server, and stopping it on editor close would mean
recovering the extent every time you reopened.

So you always have two ways to see and stop it:

- The **status bar** shows `$(database) GemDB` whenever it's running. Click to
  stop.
- The **GemDB panel** shows the same state with more detail.

Stopping is clean: the database commits what it has and shuts down. Starting
again is fast.

Stopping it yourself is also remembered. GemDB starts the database on its own,
but not after you've stopped it — it waits until you start it again or run some
Python. If something is still logged in, GemDB says so and asks before
disconnecting it.
