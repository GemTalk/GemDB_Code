"""The class the aborting arm of finding 1 stores and reads back.

Identical to `sample_committed.py` apart from this docstring, and a separate
file on purpose: each arm has to start from a module the repository has never
compiled, or it finds the class the other arm already persisted and measures
that instead.
"""


class Sample:
    def __init__(self, n):
        self.n = n
