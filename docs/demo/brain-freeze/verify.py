"""Read the whole Brain Freeze database back, from a session of its own.

    gemdb verify.py

Run it while the web app is running, or after it has stopped, or after the
database itself has been stopped and started: the answer is the same, because
the objects were never anywhere but the database.  There is no load step here
because there was no save step in `app.py` -- only `commit()`.

This is also the demo's smoke test.  It prints counts, every policy with its
claims, and the aggregates, so "did the import/flow work" has an answer that
fits on a screen.
"""

import os
import sys

import gemdb

# `gemdb file.py` does not put the script's own directory on the import path,
# the way `python3 file.py` makes it `sys.path[0]`.  Grail's resolver searches
# grailDir, its bundled stdlib, its own extra roots and then `sys.path` -- and
# under `importlib runPath:` that list is empty, so a sibling module is simply
# not found.  These two lines are the fix, they are what CPython would make
# redundant, and every script here that imports a sibling needs them first.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import model
import underwriting as uw

# Rule 1: the imports above wrote to the repository.  Rule 4 is why this is
# `model.refresh()` rather than a bare read -- see model.py.
store = model.refresh()

print("Brain Freeze Insurance -- as committed to the database")
print("store version %s" % (store.get("version"),))
print()

stats = model.stats(store)
print(
    "%d policyholder(s), %d policy(ies), %d quote(s), %d claim(s): %d approved, %d denied (%s approved)"
    % (
        stats["policyholders"],
        stats["policies"],
        stats["quotes"],
        stats["claims"],
        stats["claims_approved"],
        stats["claims_denied"],
        "%d.%02d%%" % divmod(stats["approval_rate_bp"], 100),
    )
)
print()

for policy in model.all_policies(store):
    holder = store["policyholders"].get(policy.holder_id)
    assessment = getattr(policy, "assessment", None)
    print(
        "%s  %-8s  %-16s  score %3s  %-14s  %8s/mo  %s"
        % (
            policy.policy_id,
            policy.plan,
            getattr(holder, "name", "?"),
            getattr(assessment, "score", "?"),
            getattr(assessment, "tier", "?"),
            uw.fmt_money(policy.monthly_premium_cents),
            policy.status,
        )
    )
    for claim in model.claims_for_policy(store, policy.policy_id):
        adjudication = claim.adjudication
        # CUJ-4's fields, through getattr: absent on every claim filed
        # before they existed, and that must not be an error.
        flavor = model.claim_field(claim, "flavor")
        toppings = model.claim_field(claim, "toppings")
        garnish = ""
        if flavor or toppings:
            garnish = "  [%s%s]" % (
                flavor or "?",
                (" + " + ", ".join(toppings)) if toppings else "",
            )
        print(
            "    %s  %-15s  sev %d  claimed %9s  ->  %-8s %9s  %s%s"
            % (
                claim.claim_id,
                claim.trigger,
                claim.severity,
                uw.fmt_money(claim.claimed_cents),
                getattr(adjudication, "decision", "?"),
                uw.fmt_money(getattr(adjudication, "approved_cents", 0)),
                getattr(adjudication, "rule", "?"),
                garnish,
            )
        )
print()

print("Loss ratio by risk tier -- claims approved to date over premium billed to date")
for row in stats["by_tier"]:
    print(
        "  %-14s  %2d policy(ies)  billed %10s  paid %10s  %s"
        % (
            row["tier"],
            row["policies"],
            uw.fmt_money(row["premium_billed_cents"]),
            uw.fmt_money(row["claims_paid_cents"]),
            "%d.%02d%%" % divmod(row["loss_ratio_bp"], 100),
        )
    )
print()

print("Claim severity distribution")
for row in stats["severity_distribution"]:
    print("  severity %d  %s" % (row["severity"], "#" * row["claims"]))
print()

# True, and nothing of this script's is in it: calling a Python function
# for the first time compiles it, and compiling is a write.  Rule 4 in
# model.py, and the reason a read-only script still ends up dirty.
print("needs_commit at exit: %s (compiled methods, no data)" % (gemdb.needs_commit(),))
