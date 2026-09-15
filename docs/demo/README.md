# Demos

One directory per demo, each self-contained: the write-up, the scripts it
runs, and anything else it needs. Read the `README.md` in one of them.

| Demo | What it shows | How long |
| --- | --- | --- |
| [`rabbit-in-the-hat/`](rabbit-in-the-hat/) | the two things GemDB is for — objects that outlive the program without being saved, and sessions as units of work | five minutes, three scripts |
| [`brain-freeze/`](brain-freeze/) | **moved** to [GemTalk/brain-freeze](https://github.com/GemTalk/brain-freeze) — a Flask application that lives in the database, now with a notebook and an MCP surface beside it | an afternoon, elsewhere |

Both were measured rather than written from memory, and where something
surprised us it is written down instead of tidied away — which is most of
their value. Start with the findings if you are about to build something.

**Nothing here is run by CI**, and nothing here ships in the `.vsix`
(`.vscodeignore` excludes `docs/`). Treat a demo script as documentation that
happens to be executable: it was true when it was measured, and the date is
at the top of each write-up.
