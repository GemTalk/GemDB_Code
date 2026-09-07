"""Seed the database with the dataset every transcript in the write-up reads.

    gemdb seed.py

Creates three quotes, three policyholders, three policies and seventeen
claims: the exact dataset `verify.py` prints in
[the write-up](../../demo-brain-freeze-insurance.md), with the same ids, the
same premiums, and all nine adjudication rules exercised at least once.  Run
it against a store this demo has never touched -- it refuses one that already
holds records, because the ids come from counters that only ever count up.

Nothing here reaches around the product.  Every record is written by the same
`model.record_quote`, `accept_quote`, `file_claim` and `set_policy_status`
that the Flask routes call, so a seeded database is indistinguishable from
one filled in through the browser.  The three questionnaires are real
answers: `score_answers` derives 100, 14 and 59 from them, and every premium
below is `premium_cents` doing the arithmetic rather than a number typed in.

Rules 1 and 4 from `model.py` both apply here -- the import is a write, and
each writer in `model` settles the session before opening its transaction.
"""

import datetime
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

# Rule 1: the imports above wrote to the repository.
gemdb.commit()

TODAY = datetime.date.today()

#: An event date that is always before the term starts, whenever this runs.
#: The policies below start today, so anything in the past is out of term;
#: 235 days is last winter on the day the write-up was measured.
BEFORE_COVER = TODAY - datetime.timedelta(days=235)


# --------------------------------------------------------------------------
# The three applicants.  Sixteen answers each, scoring 100, 14 and 59.
# --------------------------------------------------------------------------

PRIYA = {
    "age": 13,
    "gender": "female",
    "hair_colour": "red",
    "siblings": 3,
    "birth_order": "youngest",
    "handedness": "left",
    "tongue_roll": "no",
    "cilantro_soap": "yes",
    "favorite_flavor": "mint choc chip",
    "spoon_or_straw": "straw",
    "eating_speed": "competitive",
    "prior_freezes": 9,
    "can_whistle": "no",
    "pineapple_pizza": "undecided",
    "shoe_size": 7,
    "slushies_last_month": 14,
}

#: The same sixteen answers as `calm.json`, which posts them to /api/quote.
TOMAS = {
    "age": 23,
    "gender": "male",
    "hair_colour": "brown",
    "siblings": 0,
    "birth_order": "only",
    "handedness": "right",
    "tongue_roll": "yes",
    "cilantro_soap": "no",
    "favorite_flavor": "vanilla",
    "spoon_or_straw": "spoon",
    "eating_speed": "glacial",
    "prior_freezes": 0,
    "can_whistle": "yes",
    "pineapple_pizza": "no",
    "shoe_size": 11,
    "slushies_last_month": 1,
}

MARISOL = {
    "age": 16,
    "gender": "female",
    "hair_colour": "black",
    "siblings": 2,
    "birth_order": "middle",
    "handedness": "right",
    "tongue_roll": "yes",
    "cilantro_soap": "never tried it",
    "favorite_flavor": "rocky road",
    "spoon_or_straw": "both",
    "eating_speed": "brisk",
    "prior_freezes": 3,
    "can_whistle": "yes",
    "pineapple_pizza": "yes",
    "shoe_size": 8,
    "slushies_last_month": 10,
}

APPLICANTS = (
    ("Priya Raman", "priya@example.test", PRIYA, "Standard"),
    ("Tomas Lindqvist", "tomas@example.test", TOMAS, "Basic"),
    ("Marisol Okonkwo", "marisol@example.test", MARISOL, "Premium"),
)

# --------------------------------------------------------------------------
# The claims, in the order their ids are allocated.
#
# `rule` is not passed to anything -- it records which adjudication rule this
# row is here to exercise, so the table doubles as the checklist for "all
# nine, at least once", and `check_rules()` at the bottom proves the database
# agreed.
# --------------------------------------------------------------------------

#: (policy index, event date, trigger, severity, claimed cents, note, rule)
CLAIMS = (
    (0, BEFORE_COVER, "Slushie", 4, 4200, "Filed against last winter.", "event-outside-term"),
    (0, TODAY, "Ice cream", 4, 4200, "Two scoops, no pause.", "paid-in-full"),
    (0, TODAY, "Iced water", 1, 800, "Barely worth reporting.", "below-deductible"),
    (0, TODAY, "Milkshake", 5, 50000, "Straw, thick shake, one go.", "per-incident-limit"),
    (1, TODAY, "Popsicle", 5, 9000, "First of a bad week.", "per-incident-limit"),
    (1, TODAY, "Popsicle", 5, 9000, "Second of a bad week.", "per-incident-limit"),
    (1, TODAY, "Popsicle", 5, 9000, "Third of a bad week.", "per-incident-limit"),
    (1, TODAY, "Popsicle", 5, 9000, "Fourth: the cap is spent.", "annual-payout-cap-exhausted"),
    (2, TODAY, "Frozen yoghurt", 2, 10000, "Claimed high, recognised low.", "severity-schedule-capped"),
    (2, TODAY, "Snow", 5, 50000, "A handful, on a dare.", "severity-schedule-capped"),
    (2, TODAY, "Snow", 5, 50000, "The same dare, again.", "severity-schedule-capped"),
    (2, TODAY, "Snow", 5, 50000, "Nobody learned anything.", "severity-schedule-capped"),
    (2, TODAY, "Snow", 5, 50000, "Runs into the annual cap.", "annual-payout-cap-partial"),
    (2, TODAY, "Snow", 5, 50000, "Past the annual cap.", "annual-payout-cap-exhausted"),
    (2, TODAY, "Snow", 5, 50000, "Seventh of the year.", "annual-claim-count-cap"),
)

#: Filed after `set_policy_status` lapses the first policy -- the only way to
#: reach the `policy-not-active` rule, and Act 5 of the write-up.
CLAIM_AFTER_LAPSE = (0, TODAY, "Ice cream", 3, 3000, "Filed after the policy lapsed.", "policy-not-active")

#: CUJ-4: a claim carrying `flavor` and `toppings`, which `Claim.__init__`
#: does not declare.  `file_claim`'s `extra` sets them, which puts this record
#: in exactly the state a claim written after a schema change is in relative
#: to the sixteen above -- and finding 3 reads both back through one function.
CLAIM_WITH_TOPPINGS = (
    1,
    TODAY,
    "Ice cream",
    3,
    2500,
    "Filed with the CUJ-4 fields.",
    "annual-payout-cap-exhausted",
    {"flavor": "mint choc chip", "toppings": ["sprinkles", "hot fudge"]},
)

#: Every rule in `underwriting.adjudicate`.  Seeding is not finished until
#: each of them has decided at least one claim.
ALL_RULES = (
    "paid-in-full",
    "severity-schedule-capped",
    "per-incident-limit",
    "below-deductible",
    "annual-payout-cap-partial",
    "annual-payout-cap-exhausted",
    "annual-claim-count-cap",
    "event-outside-term",
    "policy-not-active",
)


def main():
    store = model.connect()

    existing = len(store["quotes"]) + len(store["policies"]) + len(store["claims"])
    if existing:
        print("This store already holds %d record(s), and the ids in the" % (existing,))
        print("write-up only come out of a counter that has never counted.")
        print("Start a stone on a fresh copy of extent/gemdb.dbf and run this again.")
        return

    policies = []
    for name, email, answers, plan in APPLICANTS:
        quote = model.record_quote(store, answers, name, email)
        _holder, policy = model.accept_quote(store, quote.quote_id, plan)
        policies.append(policy)
        print(
            "%s  %-15s  score %3d  %-14s  ->  %s  %-8s  %s/mo"
            % (
                quote.quote_id,
                name,
                quote.assessment.score,
                quote.assessment.tier,
                policy.policy_id,
                policy.plan,
                uw.fmt_money(policy.monthly_premium_cents),
            )
        )
    print()

    filed = []
    for index, event_date, trigger, severity, claimed, note, _rule in CLAIMS:
        filed.append(
            model.file_claim(
                store, policies[index].policy_id, event_date, trigger, severity, claimed, note
            )
        )

    # Act 5: another session lapses the policy, which is the only route to
    # the `policy-not-active` rule.  `lapse.py` is the same one line.
    index, event_date, trigger, severity, claimed, note, _rule = CLAIM_AFTER_LAPSE
    model.set_policy_status(store, policies[index].policy_id, "lapsed")
    filed.append(
        model.file_claim(
            store, policies[index].policy_id, event_date, trigger, severity, claimed, note
        )
    )

    index, event_date, trigger, severity, claimed, note, _rule, extra = CLAIM_WITH_TOPPINGS
    filed.append(
        model.file_claim(
            store,
            policies[index].policy_id,
            event_date,
            trigger,
            severity,
            claimed,
            note,
            extra=extra,
        )
    )

    for claim in filed:
        print(
            "  %s  %-15s  sev %d  %9s  ->  %-8s %9s  %s"
            % (
                claim.claim_id,
                claim.trigger,
                claim.severity,
                uw.fmt_money(claim.claimed_cents),
                claim.adjudication.decision,
                uw.fmt_money(claim.adjudication.approved_cents),
                claim.adjudication.rule,
            )
        )
    print()

    stats = model.stats(store)
    print(
        "seeded: %d policyholder(s), %d policy(ies), %d quote(s), %d claim(s)"
        % (stats["policyholders"], stats["policies"], stats["quotes"], stats["claims"])
    )
    check_rules(filed)


def check_rules(claims):
    """Fail loudly if any adjudication rule went unexercised.

    The point of the dataset is coverage, so this is the assertion that
    matters: nine rules, and a seed that silently stopped reaching one of
    them would be worse than a seed that crashed.
    """
    seen = set()
    for claim in claims:
        seen.add(claim.adjudication.rule)
    missing = [rule for rule in ALL_RULES if rule not in seen]
    unexpected = sorted(rule for rule in seen if rule not in ALL_RULES)
    print("adjudication rules exercised: %d of %d" % (len(ALL_RULES) - len(missing), len(ALL_RULES)))
    if missing:
        print("MISSING, so the dataset no longer covers the rules: %s" % (", ".join(missing),))
    if unexpected:
        print("UNEXPECTED, so ALL_RULES is out of date: %s" % (", ".join(unexpected),))


main()
