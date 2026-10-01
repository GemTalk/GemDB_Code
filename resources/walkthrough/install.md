## The automated GemDB setup

GemDB Code sets up GemDB on your computer running VS Code. The setup includes managing the download,
storing the database under `~/GemDB`, and making any required shared-memory changes.

The first time GemDB Code activates, it:

1. Starts downloading the database engine (about 145 MB on macOS, about 450 MB on Linux).
2. Checks the operating system's shared-memory limit while the engine downloads, and prompts you
   only if it needs raising.
3. Unpacks the engine and creates one database under `~/GemDB`.
4. Starts the database and installs Python into it: Grail, GemTalk Systems' implementation of Python
   for GemDB. This takes a few minutes and shows its progress in a notification.

When the setup finishes, GemDB Code uses about **700 MB on disk** on macOS and about **1.4 GB** on
Linux.

### Raise the shared-memory limit if needed

The database keeps the objects it is working with in a cache in **shared memory**, so that every
session (each GemDB Shell, notebook, and AI agent) can read them quickly without going to disk. The
operating system limits how much shared memory a program can use, and GemDB needs that limit to be
at least 1 GB. Most Linux systems already allow enough; macOS usually does not.

If the limit is too low, GemDB Code prompts you for permission to raise it. When you choose
**Configure**, GemDB Code opens a terminal and runs a small script with `sudo`.

GemDB Code never sees your password: you type it into a terminal on your computer. The change is
needed only once, and it stays in place after you restart, so GemDB Code can start the database
without prompting you again. On Linux, the same prompt also recommends keeping the database running
after you log out.

The prompt appears while the engine downloads so you can approve it while you are waiting.

If you choose **Cancel**, nothing is broken: the GemDB Code sidebar shows what is needed, and GemDB
Code prompts you again the next time the database starts.

### Canceling

You can cancel the download. Canceling keeps what has already been downloaded, and **Set Up GemDB**
in the GemDB Code sidebar picks up from there.
