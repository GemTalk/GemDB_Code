"""Brain Freeze Insurance: the web app -- CUJ-3.

Flask, served from inside the database:

    export PATH="$HOME/GemDB/bin:$PATH"   # not needed in a VS Code terminal
    cd docs/demo/brain-freeze
    gemdb app.py

Then open http://127.0.0.1:8720/.

There is no database driver and no connection string, because the app is not
talking to a database over a socket -- it *is* running in the database, and
`gemdb.root` is the same dictionary the notebook and the shell see.  The
session belongs to the server for as long as it serves, which is why
`make_server` is used directly rather than `app.run()`: one explicit server
object, on one port, that stops when the process stops.

Every request starts with `model.refresh()`, so a claim filed in the shell
or a notebook a second ago is visible on the next page load.  That is
section 5's cross-surface promise, and it is one line.
"""

import datetime
import os
import traceback

import gemdb
import jinja2
from flask import Flask, jsonify, redirect, render_template, request, url_for
from werkzeug.exceptions import HTTPException
from werkzeug.serving import make_server

import model
import underwriting as uw

# Rule 1 from model.py: the imports above just wrote to the repository, so
# commit before anything opens a transaction.
gemdb.commit()

PORT = int(os.environ.get("BFI_PORT", "8720"))

# Loopback by default, deliberately.  This app has no authentication of any
# kind -- the PRD says so -- and it can write to and commit into the
# database, so a port on every interface would put an unauthenticated
# writer in front of the whole network.  Bind wider only on purpose:
#
#     BFI_HOST=0.0.0.0 gemdb app.py
HOST = os.environ.get("BFI_HOST", "127.0.0.1")

app = Flask(__name__)


@app.errorhandler(Exception)
def show_the_traceback(exc):
    """Print the fault ourselves, because Flask's own path cannot here.

    Flask logs an unhandled exception with `app.logger.error(..., exc_info=True)`,
    and Grail's `logging` is a stub whose `Logger.error` takes no `exc_info`.
    So a bug in a view raises a *second* exception inside the error handler,
    werkzeug abandons the connection, and the client sees

        curl: (52) Empty reply from server

    with nothing in the log but a mangled traceback ending in
    `TypeError: Logger.error() got an unexpected keyword argument 'exc_info'`.
    Measured 2026-09-07 against Grail 46c2a68 -- it cost an hour of looking
    for a bug in the wrong file.  Registering a handler for `Exception`
    means Flask never reaches its logging path, so the real traceback
    reaches stdout and the client gets a 500 it can read.

    Remove this and the app still works; remove it and the app stops being
    debuggable.
    """
    if isinstance(exc, HTTPException):
        return exc
    traceback.print_exc()
    return "500 %s: %s" % (type(exc).__name__, exc), 500


# --------------------------------------------------------------------------
# Templates.  Kept inline in a DictLoader rather than in a templates/
# directory: the whole app is meant to be read top to bottom in one sitting,
# and `{% extends %}` still works because the loader is a real loader.
# --------------------------------------------------------------------------

LAYOUT = """
<!doctype html>
<title>{{ title }} - Brain Freeze Insurance</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 52rem;
         padding: 1.5rem; }
  header { border-bottom: 2px solid currentColor; margin-bottom: 1.5rem;
           padding-bottom: .5rem; }
  header a { margin-right: 1rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .tag { font-size: .8rem; opacity: .7; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border-bottom: 1px solid rgba(128,128,128,.4); padding: .4rem .5rem;
           text-align: left; vertical-align: top; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .plans { display: flex; flex-wrap: wrap; gap: 1rem; }
  .plan { border: 1px solid rgba(128,128,128,.5); border-radius: .5rem;
          flex: 1 1 14rem; padding: 1rem; }
  .plan h3 { margin: 0; }
  .price { font-size: 1.6rem; font-variant-numeric: tabular-nums; }
  .field { margin-bottom: .8rem; }
  label { display: block; font-weight: 600; }
  .why { font-size: .85rem; opacity: .75; }
  input, select, textarea { font: inherit; padding: .3rem; max-width: 24rem;
                            width: 100%; }
  button { font: inherit; padding: .4rem 1rem; }
  .approved { font-weight: 700; }
  .denied { font-weight: 700; opacity: .8; }
  .colour td { opacity: .6; }
  footer { border-top: 1px solid rgba(128,128,128,.4); font-size: .85rem;
           margin-top: 2rem; opacity: .7; padding-top: .5rem; }
</style>
<header>
  <h1>Brain Freeze Insurance</h1>
  <div class="tag">Cover for the cold-stimulus headache. Underwritten on
    nonsense, adjudicated on arithmetic.</div>
  <nav>
    <a href="{{ url_for('home') }}">Home</a>
    <a href="{{ url_for('quote_form') }}">Get a quote</a>
    <a href="{{ url_for('policy_list') }}">Policies</a>
    <a href="{{ url_for('api_stats') }}">stats.json</a>
  </nav>
</header>
{% block body %}{% endblock %}
<footer>Running inside the database. Every object on this page lives in
  <code>gemdb.root["brain_freeze"]</code>.</footer>
"""

HOME = """
{% extends "layout.html" %}
{% block body %}
<p>{{ s.policyholders }} policyholder(s), {{ s.policies }} policy(ies),
   {{ s.quotes }} quote(s), {{ s.claims }} claim(s) --
   {{ s.claims_approved }} approved, {{ s.claims_denied }} denied.</p>
<p><a href="{{ url_for('quote_form') }}">Answer sixteen questions and get a quote</a>.</p>
{% if s.by_tier %}
<table>
  <tr><th>Risk tier</th><th class="num">Policies</th>
      <th class="num">Premium billed</th><th class="num">Claims paid</th>
      <th class="num">Loss ratio</th></tr>
  {% for row in s.by_tier %}
  <tr><td>{{ row.tier }}</td><td class="num">{{ row.policies }}</td>
      <td class="num">{{ money(row.premium_billed_cents) }}</td>
      <td class="num">{{ money(row.claims_paid_cents) }}</td>
      <td class="num">{{ pct(row.loss_ratio_bp) }}</td></tr>
  {% endfor %}
</table>
<p class="why">Loss ratio is claims approved to date over premium billed to
  date. The PRD does not define it, so the demo does -- once, in
  <code>model.stats()</code>, so every surface reports the same number.</p>
{% endif %}
{% endblock %}
"""

QUOTE_FORM = """
{% extends "layout.html" %}
{% block body %}
<p>Sixteen questions. Thirteen of them move the price; three are there
   because the form looked short.</p>
<form method="post">
  <div class="field">
    <label for="applicant_name">Your name</label>
    <input id="applicant_name" name="applicant_name" required value="{{ name }}">
  </div>
  <div class="field">
    <label for="applicant_email">Email</label>
    <input id="applicant_email" name="applicant_email" type="email" value="{{ email }}">
  </div>
  {% for q in questions %}
  <div class="field">
    <label for="{{ q.field }}">{{ q.prompt }}
      {% if not q.scored %}<span class="why">(not priced)</span>{% endif %}</label>
    {% if q.kind == 'int' %}
      <input id="{{ q.field }}" name="{{ q.field }}" type="number"
             min="{{ q.min }}" max="{{ q.max }}" required
             value="{{ answers.get(q.field, '') }}">
    {% else %}
      <select id="{{ q.field }}" name="{{ q.field }}" required>
        <option value="">--</option>
        {% for v in q['values'] %}
        <option value="{{ v }}" {% if answers.get(q.field) == v %}selected{% endif %}>{{ v }}</option>
        {% endfor %}
      </select>
    {% endif %}
    <div class="why">{{ q.rationale }}</div>
  </div>
  {% endfor %}
  <button type="submit">Price it</button>
</form>
{% if error %}<p class="denied">{{ error }}</p>{% endif %}
{% endblock %}
"""

QUOTE_RESULT = """
{% extends "layout.html" %}
{% block body %}
<p>Quote <code>{{ q.quote_id }}</code> for {{ q.applicant_name }},
   {{ q.created_on }}.</p>
<p>Risk score <strong>{{ q.assessment.score }}</strong> of 100 --
   tier <strong>{{ q.assessment.tier }}</strong>.</p>
<div class="plans">
  {% for o in q.options %}
  <div class="plan">
    <h3>{{ o.plan }}</h3>
    <div class="price">{{ money(o.monthly_premium_cents) }}<span class="tag">/month</span></div>
    <p class="why">{{ o.blurb }}</p>
    <table>
      <tr><td>Deductible</td><td class="num">{{ money(o.deductible_cents) }}</td></tr>
      <tr><td>Per incident</td><td class="num">{{ money(o.per_incident_limit_cents) }}</td></tr>
      <tr><td>Annual cap</td><td class="num">{{ money(o.annual_payout_cap_cents) }}</td></tr>
    </table>
    {% if q.policy_id %}
      <p><a href="{{ url_for('policy_detail', policy_id=q.policy_id) }}">Already bought
         ({{ q.accepted_plan }})</a></p>
    {% else %}
    <form method="post" action="{{ url_for('accept', quote_id=q.quote_id) }}">
      <input type="hidden" name="plan" value="{{ o.plan }}">
      <button type="submit">Buy {{ o.plan }}</button>
    </form>
    {% endif %}
  </div>
  {% endfor %}
</div>
<h2>How that score was reached</h2>
<table>
  <tr><th>Question</th><th>Answer</th><th class="num">Points</th><th>Why</th></tr>
  {% for row in q.assessment.breakdown %}
  <tr {% if not row.scored %}class="colour"{% endif %}>
    <td>{{ row.prompt }}</td><td>{{ row.answer }}</td>
    <td class="num">{{ row.points }}</td><td class="why">{{ row.rationale }}</td></tr>
  {% endfor %}
</table>
{% endblock %}
"""

POLICY_LIST = """
{% extends "layout.html" %}
{% block body %}
{% if policies %}
<table>
  <tr><th>Policy</th><th>Holder</th><th>Plan</th><th>Tier</th>
      <th class="num">Score</th><th class="num">Premium</th><th>Status</th></tr>
  {% for p in policies %}
  <tr><td><a href="{{ url_for('policy_detail', policy_id=p.policy_id) }}">{{ p.policy_id }}</a></td>
      <td>{{ p.holder_name }}</td><td>{{ p.plan }}</td><td>{{ p.risk_tier }}</td>
      <td class="num">{{ p.risk_score }}</td>
      <td class="num">{{ money(p.monthly_premium_cents) }}</td>
      <td>{{ p.status }}</td></tr>
  {% endfor %}
</table>
{% else %}
<p>No policies yet. <a href="{{ url_for('quote_form') }}">Get a quote</a>.</p>
{% endif %}
{% endblock %}
"""

POLICY_DETAIL = """
{% extends "layout.html" %}
{% block body %}
<h2>{{ p.policy_id }} &mdash; {{ p.plan }}</h2>
<table>
  <tr><td>Holder</td><td>{{ p.holder_name }} ({{ p.holder_id }})</td></tr>
  <tr><td>Status</td><td>{{ p.status }}</td></tr>
  <tr><td>Term</td><td>{{ p.term_start }} to {{ p.term_end }}</td></tr>
  <tr><td>Risk</td><td>{{ p.risk_score }} / 100 &mdash; {{ p.risk_tier }}</td></tr>
  <tr><td>Premium</td><td class="num">{{ money(p.monthly_premium_cents) }}/month</td></tr>
  <tr><td>Billed to date</td><td class="num">{{ money(p.premium_billed_cents) }}</td></tr>
  <tr><td>Claims paid</td><td class="num">{{ money(p.claims_paid_cents) }}</td></tr>
</table>

<h2>Claim history</h2>
{% if p.claims %}
<table>
  <tr><th>Claim</th><th>Event</th><th>Trigger</th><th class="num">Severity</th>
      <th class="num">Claimed</th><th>Decision</th><th class="num">Paid</th></tr>
  {% for c in p.claims %}
  <tr><td><a href="{{ url_for('claim_detail', claim_id=c.claim_id) }}">{{ c.claim_id }}</a></td>
      <td>{{ c.event_date }}</td>
      <td>{{ c.trigger }}{% if c.flavor %} &mdash; {{ c.flavor }}{% endif %}</td>
      <td class="num">{{ c.severity }}</td>
      <td class="num">{{ money(c.claimed_cents) }}</td>
      <td class="{{ 'approved' if c.decision == 'approved' else 'denied' }}">{{ c.decision }}</td>
      <td class="num">{{ money(c.approved_cents or 0) }}</td></tr>
  {% endfor %}
</table>
{% else %}
<p>No claims on this policy.</p>
{% endif %}

<h2>File a claim</h2>
<form method="post" action="{{ url_for('file_claim', policy_id=p.policy_id) }}">
  <div class="field">
    <label for="event_date">When did it happen?</label>
    <input id="event_date" name="event_date" type="date" required value="{{ today }}">
  </div>
  <div class="field">
    <label for="trigger">What set it off?</label>
    <select id="trigger" name="trigger" required>
      {% for t in triggers %}<option value="{{ t }}">{{ t }}</option>{% endfor %}
    </select>
  </div>
  <div class="field">
    <label for="severity">How bad was it?</label>
    <select id="severity" name="severity" required>
      {% for level, label in severities %}
      <option value="{{ level }}">{{ label }}</option>{% endfor %}
    </select>
    <div class="why">Severity sets the ceiling on what a claim can be worth,
      whatever is claimed.</div>
  </div>
  <div class="field">
    <label for="claimed">How much are you claiming? (dollars)</label>
    <input id="claimed" name="claimed" required placeholder="12.50">
  </div>
  <div class="field">
    <label for="notes">Anything else</label>
    <textarea id="notes" name="notes" rows="2"></textarea>
  </div>
  <button type="submit">File it</button>
</form>
{% if error %}<p class="denied">{{ error }}</p>{% endif %}
{% endblock %}
"""

CLAIM_DETAIL = """
{% extends "layout.html" %}
{% block body %}
<h2>{{ c.claim_id }}</h2>
<table>
  <tr><td>Policy</td>
      <td><a href="{{ url_for('policy_detail', policy_id=c.policy_id) }}">{{ c.policy_id }}</a></td></tr>
  <tr><td>Event date</td><td>{{ c.event_date }}</td></tr>
  <tr><td>Filed</td><td>{{ c.filed_on }}</td></tr>
  <tr><td>Trigger</td><td>{{ c.trigger }}</td></tr>
  <tr><td>Flavor</td><td>{{ c.flavor if c.flavor else '(not recorded)' }}</td></tr>
  <tr><td>Toppings</td>
      <td>{{ c.toppings | join(', ') if c.toppings else '(not recorded)' }}</td></tr>
  <tr><td>Severity</td><td>{{ c.severity }}</td></tr>
  <tr><td>Claimed</td><td class="num">{{ money(c.claimed_cents) }}</td></tr>
  <tr><td>Notes</td><td>{{ c.notes }}</td></tr>
</table>
<h2>Adjudication</h2>
<p class="{{ 'approved' if c.decision == 'approved' else 'denied' }}">
  {{ c.decision | upper }} &mdash; {{ money(c.approved_cents or 0) }}</p>
<p>{{ c.reason }}</p>
<p class="why">Decided by rule <code>{{ c.rule }}</code>.</p>
{% endblock %}
"""

app.jinja_loader = jinja2.DictLoader(
    {
        "layout.html": LAYOUT,
        "home.html": HOME,
        "quote_form.html": QUOTE_FORM,
        "quote_result.html": QUOTE_RESULT,
        "policy_list.html": POLICY_LIST,
        "policy_detail.html": POLICY_DETAIL,
        "claim_detail.html": CLAIM_DETAIL,
    }
)


@app.context_processor
def _helpers():
    """`money` and `pct` in every template, so no template formats a number."""

    def pct(basis_points):
        return "%d.%02d%%" % divmod(int(basis_points), 100)

    return {"money": uw.fmt_money, "pct": pct}


# --------------------------------------------------------------------------
# Parsing.  No floats anywhere: dollars come in as text and become cents.
# --------------------------------------------------------------------------


def dollars_to_cents(text):
    """`"12.50"` -> `1250`, without going through a float."""
    text = (text or "").strip().replace(",", "").replace("$", "")
    if not text:
        raise ValueError("enter an amount")
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    whole, _, frac = text.partition(".")
    whole = whole or "0"
    frac = (frac + "00")[:2]
    if not whole.isdigit() or not frac.isdigit():
        raise ValueError("%r is not an amount" % (text,))
    cents = int(whole) * 100 + int(frac)
    return -cents if negative else cents


def parse_answers(form):
    """The questionnaire, out of a form and into the shape `uw` scores.

    Driven by `uw.QUESTIONS`, so adding a question means editing that tuple
    and nothing here.

    Takes an HTML form or a plain dict, which is why every value goes
    through `str()` first: a browser posts `"13"`, `/api/quote` posts `13`,
    and the second one has no `.strip()`.
    """
    answers = {}
    for q in uw.QUESTIONS:
        value = form.get(q["field"])
        raw = "" if value is None else str(value).strip()
        if not raw:
            raise ValueError("%s: please answer" % (q["prompt"],))
        if q["kind"] == "int":
            if not raw.lstrip("-").isdigit():
                raise ValueError("%s: whole numbers only" % (q["prompt"],))
            value = int(raw)
            if not (q["min"] <= value <= q["max"]):
                raise ValueError(
                    "%s: %d is outside %d-%d" % (q["prompt"], value, q["min"], q["max"])
                )
            answers[q["field"]] = value
        else:
            if raw not in q["values"]:
                raise ValueError("%s: %r is not one of the choices" % (q["prompt"], raw))
            answers[q["field"]] = raw
    return answers


def parse_date(text):
    """ISO date without `strptime`, which is one more C-extension than needed."""
    parts = (text or "").split("-")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        raise ValueError("date must be YYYY-MM-DD")
    return datetime.date(int(parts[0]), int(parts[1]), int(parts[2]))


# --------------------------------------------------------------------------
# HTML routes
# --------------------------------------------------------------------------


@app.route("/")
def home():
    store = model.refresh()
    return render_template("home.html", title="Home", s=model.stats(store))


@app.route("/quote", methods=["GET"])
def quote_form():
    model.refresh()
    return render_template(
        "quote_form.html",
        title="Get a quote",
        questions=uw.QUESTIONS,
        answers={},
        name="",
        email="",
        error=None,
    )


@app.route("/quote", methods=["POST"])
def quote_submit():
    store = model.refresh()
    try:
        answers = parse_answers(request.form)
    except ValueError as exc:
        return (
            render_template(
                "quote_form.html",
                title="Get a quote",
                questions=uw.QUESTIONS,
                answers=request.form,
                name=request.form.get("applicant_name", ""),
                email=request.form.get("applicant_email", ""),
                error=str(exc),
            ),
            400,
        )
    quote = model.record_quote(
        store,
        answers,
        request.form.get("applicant_name", "").strip(),
        request.form.get("applicant_email", "").strip(),
    )
    return redirect(url_for("quote_detail", quote_id=quote.quote_id))


@app.route("/quote/<quote_id>")
def quote_detail(quote_id):
    store = model.refresh()
    quote = store["quotes"].get(quote_id)
    if quote is None:
        return "no such quote", 404
    return render_template("quote_result.html", title="Your quote", q=quote)


@app.route("/quote/<quote_id>/accept", methods=["POST"])
def accept(quote_id):
    store = model.refresh()
    if quote_id not in store["quotes"]:
        return "no such quote", 404
    try:
        _holder, policy = model.accept_quote(store, quote_id, request.form.get("plan", ""))
    except KeyError as exc:
        return "cannot accept: %s" % (exc,), 400
    return redirect(url_for("policy_detail", policy_id=policy.policy_id))


@app.route("/policies")
def policy_list():
    store = model.refresh()
    return render_template(
        "policy_list.html",
        title="Policies",
        policies=[model.policy_as_dict(store, p) for p in model.all_policies(store)],
    )


@app.route("/policy/<policy_id>")
def policy_detail(policy_id):
    store = model.refresh()
    policy = store["policies"].get(policy_id)
    if policy is None:
        return "no such policy", 404
    return render_template(
        "policy_detail.html",
        title=policy_id,
        p=model.policy_as_dict(store, policy, with_claims=True),
        triggers=uw.TRIGGERS,
        severities=sorted(uw.SEVERITY_LABELS.items()),
        today=datetime.date.today().isoformat(),
        error=request.args.get("error"),
    )


@app.route("/policy/<policy_id>/claim", methods=["POST"])
def file_claim(policy_id):
    store = model.refresh()
    policy = store["policies"].get(policy_id)
    if policy is None:
        return "no such policy", 404
    try:
        event_date = parse_date(request.form.get("event_date"))
        claimed = dollars_to_cents(request.form.get("claimed"))
        severity = int(request.form.get("severity", "1"))
    except ValueError as exc:
        return redirect(url_for("policy_detail", policy_id=policy_id, error=str(exc)))
    claim = model.file_claim(
        store,
        policy_id,
        event_date,
        request.form.get("trigger", "Other"),
        severity,
        claimed,
        request.form.get("notes", "").strip(),
    )
    return redirect(url_for("claim_detail", claim_id=claim.claim_id))


@app.route("/claim/<claim_id>")
def claim_detail(claim_id):
    store = model.refresh()
    claim = store["claims"].get(claim_id)
    if claim is None:
        return "no such claim", 404
    return render_template("claim_detail.html", title=claim_id, c=model.claim_as_dict(claim))


# --------------------------------------------------------------------------
# JSON routes.  Enough to drive the whole flow from curl, which is how the
# demo is proved rather than described.
# --------------------------------------------------------------------------


@app.route("/api/questions")
def api_questions():
    """The questionnaire definition: field, prompt, allowed values, priced or not."""
    return jsonify(
        [
            {
                "field": q["field"],
                "prompt": q["prompt"],
                "kind": q["kind"],
                "values": list(q["values"]) if q["kind"] == "choice" else None,
                "min": q.get("min"),
                "max": q.get("max"),
                "scored": q["scored"],
                "rationale": q["rationale"],
            }
            for q in uw.QUESTIONS
        ]
    )


@app.route("/api/quote", methods=["POST"])
def api_quote():
    """Price a questionnaire posted as JSON, and keep the quote."""
    store = model.refresh()
    payload = request.get_json(silent=True) or {}
    try:
        answers = parse_answers(payload.get("answers", {}))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    quote = model.record_quote(
        store, answers, payload.get("name", ""), payload.get("email", "")
    )
    return jsonify(
        {
            "quote_id": quote.quote_id,
            "risk_score": quote.assessment.score,
            "risk_tier": quote.assessment.tier,
            "options": quote.options,
            "breakdown": quote.assessment.breakdown,
        }
    )


@app.route("/api/policies")
def api_policies():
    store = model.refresh()
    return jsonify([model.policy_as_dict(store, p) for p in model.all_policies(store)])


@app.route("/api/policy/<policy_id>")
def api_policy(policy_id):
    store = model.refresh()
    policy = store["policies"].get(policy_id)
    if policy is None:
        return jsonify({"error": "no such policy"}), 404
    return jsonify(model.policy_as_dict(store, policy, with_claims=True))


@app.route("/api/claim/<claim_id>")
def api_claim(claim_id):
    store = model.refresh()
    claim = store["claims"].get(claim_id)
    if claim is None:
        return jsonify({"error": "no such claim"}), 404
    return jsonify(model.claim_as_dict(claim))


@app.route("/api/stats")
def api_stats():
    store = model.refresh()
    return jsonify(model.stats(store))


# --------------------------------------------------------------------------


def serve():
    model.connect()
    server = make_server(HOST, PORT, app)
    print("Brain Freeze Insurance on http://127.0.0.1:%d/  (ctrl-c to stop)" % (PORT,))
    server.serve_forever()


if __name__ == "__main__":
    serve()
