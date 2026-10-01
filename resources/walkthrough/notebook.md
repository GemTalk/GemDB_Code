## Notebooks

To create a notebook, click the **New GemDB Notebook** icon at the top of the GemDB Code sidebar.
Each cell runs inside the database. A new notebook has a starter cell that stores a value, commits
it, and reads it back:

```python
# Python here runs inside your GemDB database.
# Everything reachable from gemdb.root is still there tomorrow.
import gemdb

gemdb.root["greeting"] = "Hello from GemDB!"
gemdb.commit()

gemdb.root["greeting"]
```

When you run it, the cell shows `'Hello from GemDB!'`. Because the value is committed, it is still
in the database after you close the notebook or restart VS Code.

Variables you define in a cell are available in the cells you run after it, as in any notebook. Each
notebook has its own variables. To clear them without restarting the database, run **GemDB: Clear
Notebook Variables** from the Command Palette.
