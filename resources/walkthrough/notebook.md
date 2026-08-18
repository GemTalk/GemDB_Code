## Notebooks

Open a notebook and pick **GemDB** as the kernel. Cells run inside the
database and share variables the way you would expect:

```python
import gemstone
routes = gemstone["routes"]      # data already in the database
len(routes)
```

Each notebook gets its own variables. "Clear Notebook Variables" resets them
without restarting the database.
