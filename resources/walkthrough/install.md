## Setup runs by itself

The first time GemDB activates, it:

1. Starts downloading the database engine (about 210 MB).
2. Asks permission for one operating-system change — while that downloads.
3. Unpacks the engine and creates one database under `~/GemDB`.
4. Starts the database, so it's ready before you are.

That's about **820 MB on disk** when it settles. Python support is already in
the database GemDB creates — there's no separate install step to wait through.

### The one thing it asks for

The database keeps its working set in **shared memory**, and both macOS and
Linux ship with a limit well below the 1 GB it needs. GemDB opens a terminal
and runs a small script with `sudo`, so you'll be asked for your password.

GemDB never sees that password — the prompt is your own terminal's. It's asked
once per machine, and it's the only change GemDB makes outside `~/GemDB`.

It's asked *while the download runs* rather than after, for two reasons: you're
waiting anyway, and you're still here. Asked two minutes later, it tends to
arrive after you've moved on to something else.

If you'd rather not, nothing is broken: the panel keeps showing what's needed,
and GemDB asks again the first time you actually run Python.

### Cancelling

Cancelling the download is remembered — GemDB won't ask again. The
partly-downloaded file is kept, so picking it up later only fetches what's
left.
