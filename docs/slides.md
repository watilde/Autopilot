---
marp: true
theme: default
paginate: true
header: 'Autopilot — remediation control plane'
style: |
  section { font-size: 26px; }
  h1 { font-size: 46px; }
  h2 { font-size: 34px; }
  code { font-size: 0.85em; }
  pre { font-size: 0.62em; line-height: 1.25; }
  table { font-size: 0.8em; }
  .small { font-size: 0.8em; color: #555; }
  .big { font-size: 1.6em; font-weight: 600; line-height: 1.4; }
---

<!--
Render:
  npx @marp-team/marp-cli@latest docs/slides.md -o docs/slides.html
  npx @marp-team/marp-cli@latest docs/slides.md --pdf

Twelve slides, paced for five minutes. Presenter notes are in HTML comments
under each slide. The narrative long-form is docs/loom-script.md; this deck is
the same argument with the prose removed.
-->

# Autopilot

**GitHub issues in, Devin sessions out.**
Pull requests and metrics, observable end to end.

<span class="small">Apache Superset fork · 5 issues · 5 pull requests · all merged</span>

<!--
Do not read the slide. Open on the problem, not the product.
-->

---

## The backlog nobody gets to

Known vulnerabilities. A dependency pin nobody can justify anymore.
The same weak pattern inlined across three modules.

Not hard. Each one costs a **context switch**, and that is the expensive part.

So point an agent at it — and you inherit a different problem:

<div class="big">

The agent says it fixed it.
**How do you know?**

</div>

<!--
This is the whole pitch. Everything after this slide is an answer to that
question. Say it slowly.
-->

---

## What shipped

| Issue | Category | Outcome |
|---|---|---|
| SEC-001 `yaml.load` → `safe_load` (CWE-502) | security | merged |
| SEC-002 `hashlib.md5(usedforsecurity=False)` — crashes on FIPS hosts | security | merged |
| QUAL-001 collision-prone `Math.random()` ids in 3 modules | code-quality | merged |
| DEP-001 audit the `setuptools<81` ceiling | dependency | merged |
| QUAL-002 `@ts-ignore` → `@ts-expect-error` | code-quality | merged |

**5 of 5 merged · 100% merge rate · 2 self-corrections after CI failures, no human**

<span class="small">Deliberate mix: two security fixes, two code changes, and one investigation whose deliverable is a written audit — "produce evidence" is real work an agent is good at.</span>

<!--
DEP-001 is worth a beat: the deliverable was a reasoned recommendation, not a
diff. That is not something a codemod has an answer for.
-->

---

## Architecture

```
  TRIGGERS                  ORCHESTRATOR                  EXTERNAL

  GitHub webhook  ──┐
  issues.labeled    │      ┌────────────┐   contract valid? already running?
                    ├─────►│  intake()  │   already fixed and awaiting review?
  Scheduled scan  ──┤      └─────┬──────┘
  every 60s         │            │ queued
                    │            ▼
  POST /api/trigger ┤      ┌────────────┐   POST …/sessions
                    │      │ dispatch() │ ──────────────────────►  Devin
  Devin files its ──┘      └─────┬──────┘   prompt + playbook      v1 or v3
  own issues                     │ running  + JSON schema             │
                                 ▼                                    │
                          ┌────────────┐    GET …/sessions/{id}       │
                          │reconcile() │ ◄────────────────────────────┘
                          └─────┬──────┘    every 15s, normalised
                                │
                  succeeded / failed / blocked  ──► PR · comment · labels
                                │
                                ▼
              SQLite: remediations + append-only event log
                                │
                dashboard  ·  /metrics  ·  npm run report
```

<!--
One point only: intake and dispatch are separate because webhooks arrive in
bursts and every session costs money. The queue absorbs the burst, the cap
controls spend.
-->

---

## One definition of done, checked by two parties

Every issue carries a machine-readable **contract**:

```yaml
id: SEC-001
category: security
files: [superset/examples/helpers.py]
do_not_touch: [tests/, migrations/]
verify:
  - ruff check superset/examples/helpers.py
  - pytest tests/unit_tests/examples/
```

- **Devin** runs those commands in its sandbox before opening the PR
- **CI on the pull request** reads the same block off the same issue and runs them again

<span class="small">One of the two has no stake in the answer. That is the entire point.</span>

<!--
The contract is also the refusal surface: an issue without a valid block is
rejected at intake and never becomes a paid session.
-->

---

## The principle

<div class="big">

Independent evidence outranks
what the agent says about its own work.

</div>

And it has to cut **both ways**, or it is only a rule about which errors you prefer to keep.

- **Demote** a "fixed" that does not build — easy, everyone does this
- **Promote** a stale failure that CI has since verified — the hard direction

> QUAL-002 was recorded `failed` because Devin reported it was blocked. It was right to.
> We amended the contract, it pushed, CI went green on the same PR — and the record
> still said `failed`, on a snapshot taken before any of that.

<!--
Narrow by design: a pull request must exist, and CI must have passed on it.
Nothing promotes a remediation that produced no code.
-->

---

## If I were an engineering leader, how would I know this is working?

| | | |
|---|---|---|
| **Merge rate** | 100% (5 of 5) | an unmerged PR is work the org declined |
| **Success rate** | 100% of 5 concluded | 12 withdrawn are excluded — a cancellation is a decision, not a verdict |
| **Issue → PR** | median 17.6m | agent latency |
| **PR → merged** | median 67.7m | *human* review latency, reported separately |
| **CI verdicts** | 5 passed, 2 self-corrections | how often the independent check rejected the work, and how often it was fixed with no human |
| **ACUs** | not reported for this account | "not measured" and "free" are different claims |

<span class="small">Dashboard · Prometheus `/metrics` · `npm run report` — reads SQLite directly, so it works when the service is down.</span>

<!--
The denominators are the argument. Summing the two latencies would let a slow
reviewer make the agent look slow.
-->

---

## Why Devin — 1. It argues back, and it is right

**QUAL-002.** The contract said verify with `tsc --noEmit -p tsconfig.json`.

Devin got the other checks green, then **stopped** and reported:

> the type-check fails with 598 `TS6305` errors in *any* clean checkout — the root
> tsconfig uses project references whose outputs must be built first — and fixing
> that is outside this contract's scope.

That was correct.

- A codemod fails silently
- A worse agent disables the check to get green
- The fix was to amend **the contract**, in the issue, which Devin *and* CI read

<!--
It also declined twice to open a duplicate PR when it found its own earlier
work. That is judgement, not retry logic.
-->

---

## Why Devin — 2. It refuses, and explains

**QUAL-001.** We built auto-merge: green CI + low-risk category → Devin merges its own PR.
We asked it to. It came back with:

> `gh pr merge` is exactly what I ran and **my guardrail** rejected it — the block is in
> my tooling and keys off the base branch being `main`/`master`, not anything GitHub
> reports, so auto-merge would hit the same rule and **I won't try it as a workaround**.

Then it named the two things that *would* permit a merge.

It refused · explained · distinguished its own policy from the platform's · declined the workaround

<div class="big">That is the case for an autonomous agent.</div>

<span class="small">Not that it writes the patch — plenty of things write patches. It is that when the task as specified is wrong, it says so, and you can build a system that listens.</span>

<!--
Do not claim Devin merged anything. It did not, and why it did not is the
better story.
-->

---

## What the system refuses to claim

**Autopilot asks for a merge. It never records one.**

- Nothing on that path writes `pr_state` — the merge is read back from GitHub,
  like any other observer
- A merge that never happened shows up as a pull request **still open**, not a shipped fix
- After a grace period it labels the issue `autopilot:needs-human` and **quotes the
  session verbatim** — no keyword-matching the refusal, because that would be the
  system inventing a reason

<span class="small">An escalation nobody is told about is the same as a failure nobody sees.</span>

<!--
This slide is the credibility slide. A system that only reports its wins is not
observable, it is marketing.
-->

---

## Next, in a real engagement

**Confidence as the merge gate, not category.**
Today the tier is a label — a proxy for risk, not a measure of it. Diff size, blast radius, whether the change stayed inside the modules the contract named.

**Human review into the loop, not just CI.**
The rework loop answers to the build. `pull_request_review` comments could go back into the same session, so "why not use X here?" is answered in-session.

**Contracts from scanners.**
Every issue here was hand-written and verified. Intake does not care where an issue came from — Dependabot, CodeQL, Sentry. That is where the volume is.

---

## Run it yourself

```bash
git clone https://github.com/watilde/Autopilot.git && cd Autopilot
docker compose up --build -d
npm install && npm run simulate      # five signed webhooks, end to end
open http://localhost:8080
```

Defaults to `DEVIN_MODE=mock` — the whole pipeline, no API key, no ACUs.

**Solution** github.com/watilde/Autopilot
**Fork** github.com/watilde/superset · issues #1–#5, pull requests #6–#10

<span class="small">155 tests, no network. Most of the auto-merge tests are cases that must *not* merge.</span>

<!--
Close on the mock mode. Anyone in the room can run the whole thing in two
minutes without a credential, and that is what makes the numbers checkable.
-->
