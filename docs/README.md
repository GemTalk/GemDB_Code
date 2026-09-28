# Design notes

What was decided, what was measured, and what is still open. None of this
ships: `.vscodeignore` keeps `docs/` out of the `.vsix`. The code says how
things work; these notes say why, so read the one that covers an area before
changing it.

| Note | Covers | Read it before |
| --- | --- | --- |
| [`automation-boundary.md`](automation-boundary.md) | where each automated step sits on the "inert and reversible vs persistent or global" line, and what was measured about asking for shared memory | adding or changing anything GemDB does without asking |
| [`grail.md`](grail.md) | how the Grail payload is built and staged, the Python↔GCI bridge (exit codes, `input()`, `print()`, encoding), and the gotchas found building on it | touching the bridge or building an application on Grail |
| [`mcp-server.md`](mcp-server.md) | the bundled MCP server: payload, session cost and leak, read-only mode, stop order, client registration | changing how the MCP server is built, started, stopped or exposed |
| [`reaching-windows.md`](reaching-windows.md) | the options for a Windows story (WSL, remote server, Docker) and what still needs a Windows machine | starting any Windows work |
| [`demo/`](demo/) | one self-contained directory per demo, with measured findings | building something a demo already explored, or adding a demo |
