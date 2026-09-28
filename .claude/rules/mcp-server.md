---
description: When to read which section of docs/mcp-server.md before changing the bundled MCP server.
paths:
  - 'src/**/mcp*.ts'
  - 'scripts/bundle-mcp.sh'
---

# The MCP server

[`docs/mcp-server.md`](../../docs/mcp-server.md) records why each MCP decision
is the way it is and what was measured. Routine edits don't need it. Read the
matching section when the task is one of these:

- **Changing `install.sh` flags, `bundle-mcp.sh`, or bumping the mcp_server
  pin**, or a build failing on the `./*.sh` scan → "What the payload is".
- **An agent gets "Unknown tool" for `eval_python`**, or changing
  `toolsetNames`/`toolsetOptions` → "The Python toolset takes two separate
  acts".
- **Changing how the router starts, or making `deactivate` stop it** → "Why
  it is a process".
- **Changing the `gemdb.mcp.enabled` default, debugging `SessionLimitError` /
  error 4039, or reaping idle workers** → "The session cost" and "The session
  leak".
- **Anything assuming an agent's variables or transaction carry over between
  calls** → "Each tool call is a clean slate".
- **Changing `runStop` order, `stopMcpServer` or `mcp-router.json`**, or "Stop
  GemDB" hitting the "Stop Anyway" modal → "Stopping it".
- **Adding a client or changing `gemdb.registerMcpClient`** → "Registering it
  with clients".
- **Changing the default port** → "Why the port is not 8000".
- **Changing the bind address, `Origin` checks, `gemdb.mcp.readOnly` or
  `ensureReadOnlyUser`** → "Is it safe to open a port on every developer's
  machine?".
- **Before bumping the pin or turning the default back on**, check whether
  upstream fixed the worker cap → "Open, and worth doing".
