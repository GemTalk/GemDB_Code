## Notebooks

Click **New GemDB Notebook** in the GemDB Code sidebar. Its kernel, **GemDB (Python in the
database)**, is already selected; in another notebook, choose it from the kernel picker at the top
right. Cells run inside the database and share variables the way you would expect. The starter cell
stores a value and commits it:

```python
import gemdb

gemdb.root["greeting"] = "Hello from GemDB!"
gemdb.commit()

gemdb.root["greeting"]
```

Each notebook has its own variables. **GemDB: Clear Notebook Variables** resets them without
restarting the database.
