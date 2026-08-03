# Autopilot

**Event-driven issue remediation for [Apache Superset](https://github.com/apache/superset), powered by the [Devin API](https://docs.devin.ai/api-reference/overview).**

Label a GitHub issue `autopilot`. A verified pull request shows up. Every step is
measured.

- **Solution repo:** this one
- **Target fork:** [`watilde/superset`](https://github.com/watilde/superset) — [the five seeded issues](https://github.com/watilde/superset/issues)

---

## The problem

Every engineering org has a backlog of defects nobody argues about: an unsafe
YAML loader, an MD5 call that crashes on FIPS hosts, the same broken ID
generator copy-pasted into three files. They are small, real, and individually
worth maybe forty minutes. They are also *never worth interrupting a roadmap
for*, so they sit in the backlog for years — until one of them becomes an
incident.

The blocker isn't capability. It's **activation energy**: context-switch, clone,
reproduce, fix, verify, open a PR, wait for review. Nobody spends their Tuesday
on `@ts-ignore`.

Autopilot removes the activation energy. Triage stays human — someone decides
the issue is real and worth fixing. Everything after that is automated, and the
result lands as a normal pull request in a normal review queue.

## What it is not

It is **not** "point an agent at a repo and hope". Three constraints make it
something you could actually run against a real codebase:

1. **No contract, no dispatch.** An issue must carry a machine-readable
   `autopilot` block naming the defect, the acceptance criteria, and the shell
   commands that prove the fix. A stray label on a vague issue is refused, with
   a comment explaining why.
2. **Devin's own verification gates the result.** Every session runs the
   contract's `verify` commands and reports their real output. A finished
   session that opened no PR, or whose verification failed, is recorded as a
   **failure** — not a success.
3. **A human still merges.** Autopilot's output is a pull request, not a push to
   `master`. The system never has write access to a protected branch.

---

## Architecture

```
  TRIGGERS                    ORCHESTRATOR                   EXTERNAL
  ─────────                   ────────────                   ────────

  GitHub webhook  ──┐
  issues.labeled    │        ┌──────────────┐
                    ├──────► │   intake()   │  contract valid? already running?
  Scheduled scan  ──┤        └──────┬───────┘  already fixed and awaiting review?
  every 60s         │               │ queued
                    │               ▼
  POST /api/trigger ┤        ┌──────────────┐   POST …/sessions
                    │        │  dispatch()  │ ──────────────────────►  Devin
  Scheduled Devin ──┘        └──────┬───────┘   prompt + playbook      v1 or v3
  files new issues                  │ running   + JSON schema             │
                                    ▼                                     │
                             ┌──────────────┐   GET …/sessions/{id}       │
                             │ reconcile()  │ ◄───────────────────────────┘
                             └──────┬───────┘   every 15s, normalised
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
                 succeeded       failed         blocked        ──► PR on the fork
                     │              │              │           ──► status comment
                     └──────────────┴──────────────┘           ──► labels
                                    │
                                    ▼
                        SQLite: remediations + append-only event log
                                    │
                     ┌──────────────┼──────────────┐
                     ▼              ▼              ▼
                 dashboard      /metrics       npm run report
                    /          Prometheus         terminal

  REVIEW-FIX LOOP
  ───────────────
                             ┌──────────────┐
   PR opened  ──► CI runs ──►│ contract     │  re-runs the issue's own
   on the fork   the same    │ verification │  verify commands on the PR
                 contract    └──────┬───────┘
                                    │ failure
                                    ▼
   workflow_run webhook  ──► ┌──────────────┐   POST …/sessions/{id}/messages
   (or the CI poll, when ──► │handleCiResult│ ──────────────────────────► Devin
    no webhook is wired)     └──────┬───────┘   failing log, same session
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
              Devin pushes a fix        rework cap reached
              to the same branch        ──► label autopilot:needs-human
```

### Why it's shaped this way

**Intake and dispatch are separate.** Webhooks arrive in bursts — a scan
finishes and labels nine issues at once — and every Devin session costs real
money. Accepting work and starting work have to be decoupled so the queue
absorbs the burst and `MAX_CONCURRENT_SESSIONS` controls spend.

**Reconciliation is a poll loop, not a callback.** A webhook you never receive
is indistinguishable from one that says nothing happened. The loop is what
guarantees a session can't sit in `running` forever because a notification was
dropped, and it's what enforces `SESSION_TIMEOUT_MS`.

**Two triggers, one intake path.** The webhook is the fast path; the periodic
scan is the safety net for deliveries dropped during a restart. Both call
`intake()`, and `intake()` deduplicates, so a webhook and a scan racing on the
same issue is harmless by construction.

**Structured output, not prose.** Sessions are created with a
`structured_output_schema`, so completion arrives as data — `status`,
`files_changed`, `verification_passed`, `pull_request_url`, `confidence`. The
orchestrator decides success programmatically instead of regex-matching an
agent's summary.

**The event log is the source of truth.** Every state transition appends a row.
Metrics are derived from it, which means the numbers survive a restart and are
auditable after an incident.

**CI checks the agent's homework.** Devin reports `verification_passed`, but
that is a claim by the thing that wrote the code. The
[`autopilot-verify`](https://github.com/watilde/superset/blob/master/.github/workflows/autopilot-verify.yml)
workflow on the fork reads the contract *off the linked issue* and re-runs the
same `verify` commands against the pull request. One definition of done, checked
by two parties, one of which has no stake in the answer.

**And it can overrule the agent in either direction.** Success is judged from
what the session reported about its own work, because when a session ends that is
the only evidence there is. CI arrives later and is better evidence: it re-runs
the contract's own commands and has no stake in the answer. That rule has to cut
both ways, or it is just a rule about which errors we prefer to keep — so a
record that says `failed` is corrected to `succeeded` when CI later passes on its
pull request, and the correction is posted to the issue. QUAL-002 is the case in
point: Devin reported `blocked` because the contract's type-check could not pass,
the contract was then amended and CI went green on the same PR, while the record
still said `failed` on the strength of a snapshot taken before any of that. The
promotion is deliberately narrow — a pull request must exist and CI must have
passed on it, so nothing that produced no code is ever promoted.

**A CI failure goes back to the agent, not to a person.** This is the part a
version-bump bot cannot do. The failing log is sent into the same session, which
still holds the context of the change it made, and it fixes forward on the same
branch. Capped by `MAX_CI_REWORKS`: an agent that cannot fix its own build twice
is stuck on something the contract did not anticipate, so the issue gets labelled
`autopilot:needs-human` rather than looping on ACUs.

**A green pull request can merge itself, and the gate is narrow.** Off by
default (`AUTO_MERGE`), because every other action here is reversible by a
reviewer who has not looked yet and this one is not. When it is on, a pull
request whose contract verification job passed, on a category in
`AUTO_MERGE_CATEGORIES`, is merged — by **Devin**, not by Autopilot. The session
holds the branch and opened the PR, so asking it to finish its own work keeps
one actor responsible end to end and sends the merge through whatever branch
protection applies to Devin rather than around it via a service token. `security`
is refused whatever the allowlist says: a passing test suite is not a substitute
for somebody who understands the threat agreeing that the fix addresses it.

The consequence is that Autopilot can report that it *asked*, never that the PR
merged. Nothing in that path writes `pr_state` — the merge is read back from
GitHub by the same poll that watches every other PR, so a merge Devin never
performed shows up as a pull request still sitting open rather than as a shipped
fix. That gap is on the dashboard, and it is the honest failure mode.

**And the gap gets a name, not silence.** A merge that has not happened
`AUTO_MERGE_GRACE_MS` after it was asked for is labelled
`autopilot:needs-human`, with the session's own explanation quoted verbatim on
the issue. No attempt is made to classify the refusal: the trigger is the
observable fact — asked, grace elapsed, still open — and the reason is whatever
the agent said, because it is the authority on why it did not do something and a
keyword match on its prose would be this system inventing a reason. Once per
remediation; Autopilot does not nag.

This is not hypothetical, and it is why the escalation exists. On the first live
run against PR #10, Devin was asked to merge, ran `gh pr merge`, and was refused
by **its own tooling**: merging into `main`/`master` is blocked unconditionally,
keyed on the pull request's base branch, with no setting to relax it and no
GitHub-side involvement at all. It said so precisely, declined to reach for
auto-merge as a workaround, and named the two things that would permit a merge —
retargeting at a non-`master` base, or an automation using its requester's own
credentials. None of that is a rule any configuration here could have
anticipated, and without the escalation it would have lived only in a session
transcript while the issue sat quiet and the pull request sat green.

**Evidence outranks the clock.** A session does not exit the moment it opens a
pull request — it often stops and asks whether anything else is wanted. So the
reconciler records a PR as soon as it exists, in any session state, and the
timeout judges what was produced before deciding a session failed. Getting this
backwards cost this deployment two merge-ready PRs recorded as timeouts and two
duplicate paid sessions behind them; the story is in
[Things that went wrong](#things-that-went-wrong).

---

## Quickstart

### Docker (no credentials needed)

```bash
git clone https://github.com/watilde/Autopilot.git && cd Autopilot
docker compose up --build -d

# fire five signed webhooks and watch them through to completion
npm install && npm run simulate

open http://localhost:8080
```

Defaults to `DEVIN_MODE=mock` — a deterministic in-process simulator that
exercises the entire pipeline (signature check, contract parse, dispatch,
reconcile, metrics) without an API key and without spending ACUs. It reproduces
the awkward states too: blocked, expired, and a session that finishes without
opening a PR.

### Local

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:8080
npm run simulate     # in another terminal
npm run report       # terminal summary
```

### Live mode

```bash
# .env
DEVIN_MODE=live
DEVIN_API_KEY=cog_...             # or a legacy apk_ key
DEVIN_ORG_ID=org-...              # required for cog_ keys; see below
GITHUB_TOKEN=ghp_...              # `repo` scope: read issues, post comments
GITHUB_WEBHOOK_SECRET=...         # shared secret from the GitHub webhook
ALLOW_UNSIGNED_WEBHOOKS=false
```

**Both Devin API generations are supported, and the right one is inferred from
your credential:**

| Key prefix | API | Notes |
|---|---|---|
| `cog_…` | **v3** (current) | Service-user credential. Every path is org-scoped, so `DEVIN_ORG_ID` is required — find it under *Settings → Service Users*. |
| `apk_…` / `apk_user_…` | v1 (deprecated) | No org id needed. |

Getting this wrong fails with a bare `403 Unauthorized` and no explanation, so
Autopilot infers the generation from the key prefix, logs which one it chose,
and refuses to boot with an actionable message if a `cog_` key is missing its
org id. Override with `DEVIN_API_VERSION` if you ever need to.

The two generations disagree about nearly everything the orchestrator cares
about — v1 has `status_enum`, one `pull_request` and no cost field; v3 splits
lifecycle across `status` + `status_detail`, returns a `pull_requests` array and
reports `acus_consumed`. Each client normalises into one internal shape, so the
state machine never learns either dialect.

### Wiring the webhook

Events: **Issues**, **Issue comments**, **Pull requests**, **Workflow runs** —
the last two drive merge tracking and the review-fix loop. Content type
`application/json`, and a secret, because the endpoint is the only
unauthenticated way into a system that spends money.

```bash
# 1. a secret, and a public URL for a service running on a laptop
openssl rand -hex 32                       # -> GITHUB_WEBHOOK_SECRET in .env
cloudflared tunnel --url http://localhost:8080

# 2. register it (reads the secret from .env, never echoes it)
set -a; . .env; set +a
gh api -X POST repos/$GITHUB_OWNER/$GITHUB_REPO/hooks -f name=web -F active=true \
  -f 'events[]=issues' -f 'events[]=issue_comment' \
  -f 'events[]=pull_request' -f 'events[]=workflow_run' \
  -f config[url]=https://<your-tunnel>.trycloudflare.com/webhooks/github \
  -f config[content_type]=json -f config[secret]="$GITHUB_WEBHOOK_SECRET"

# 3. prove both halves: a signed delivery is accepted, an unsigned one is not
gh api -X POST repos/$GITHUB_OWNER/$GITHUB_REPO/hooks/<id>/pings     # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://<your-tunnel>.trycloudflare.com/webhooks/github \
  -H 'content-type: application/json' -H 'x-github-event: ping' -d '{}'   # 401
```

Then label an issue `autopilot`.

Without a public host, use the scheduled scanner or trigger directly:

```bash
curl -X POST localhost:8080/api/trigger \
     -H 'content-type: application/json' -d '{"issueNumber": 1}'
```

---

## The remediation backlog

Five issues seeded into [`watilde/superset`](https://github.com/watilde/superset/issues)
via `npm run seed`. **All five were found by reading the actual Superset source** —
every path, line number and excerpt was manually verified before being written
down. (Two candidates were discarded during the scan: a `requests.post` that
looked timeout-less until the continuation line showed `timeout=60`, and the
migration-script bare `except:` clauses, which are frozen historical files.)

| ID | Issue | Category | Why it's real |
|----|-------|----------|---------------|
| [SEC-001](https://github.com/watilde/superset/issues/1) | `yaml.load` with full `yaml.Loader` in the examples importer | security | CWE-502. `# noqa: S506` suppresses Bandit rather than fixing it. |
| [SEC-002](https://github.com/watilde/superset/issues/2) | `hashlib.md5()` without `usedforsecurity=False` | security | **A crash, not a nit** — raises `ValueError` on FIPS-enabled hosts. Both sites are explicitly non-cryptographic. |
| [QUAL-001](https://github.com/watilde/superset/issues/3) | `Math.random()` ID generation duplicated across 3 files | code-quality | `.substring(2,15)` doesn't reliably yield 13 chars; these IDs are React reconciliation keys. |
| [DEP-001](https://github.com/watilde/superset/issues/4) | Audit the `setuptools<81` ceiling | dependency | The pin names a condition for lifting it, but nobody recorded which deps still import `pkg_resources`. |
| [QUAL-002](https://github.com/watilde/superset/issues/5) | `@ts-ignore` → `@ts-expect-error` | code-quality | The entire remaining population in `src` — closing it lets a lint rule hold the line. |

The mix is deliberate: two security fixes, two code-quality changes, and one
investigation whose deliverable is a written audit rather than a code change —
because "produce evidence" is a real category of work an agent is good at.

### The contract

Each issue body carries a fenced block that Autopilot parses:

````markdown
```autopilot
id: SEC-001
category: security
severity: high
targets:
  - superset/examples/utils.py:261
acceptance:
  - "yaml.load(..., Loader=yaml.Loader) is replaced with yaml.safe_load(...)"
  - "No other call sites or files are modified"
verify:
  - "python -m compileall -q superset/examples/utils.py"
  - "! grep -q 'Loader=yaml.Loader' superset/examples/utils.py"
  - "ruff check superset/examples/utils.py"
notes: |
  Keep the change to the single statement.
```
````

This is the whole safety model. `verify` commands are fast and hermetic — lint,
byte-compile, targeted unit tests, greps — never the full Superset suite, which
needs a database and many minutes.

---

## Observability

> *"If I were an engineering leader, how would I know this is working?"*

Counting sessions doesn't answer that — a system can start a hundred sessions and
ship nothing. So the metrics are outcome-shaped.

| Surface | What it's for |
|---|---|
| `GET /` | Live dashboard, 5s refresh |
| `GET /metrics` | Prometheus — for alerting |
| `GET /api/analytics` | Full JSON snapshot |
| `npm run report` | Terminal report, reads SQLite directly — works when the service is down |
| Issue comments | Status back to whoever filed the bug |

**The numbers that matter:**

- **Merged pull requests, and merge rate.** Opening a PR is output; merging it
  is outcome. An unmerged PR is work the organisation declined, and a dashboard
  that reports the first as though it were the second is flattering itself.
- **Success rate over work that reached a verdict.** In-flight items are
  excluded, or labelling a new issue would make the system look worse. So are
  operator-cancelled ones: a withdrawn remediation measures our decision, not
  the agent's performance. Cancellations stay visible in the state breakdown.
- **Time to PR, separately from time to merge.** The first is agent latency, the
  second is human review latency. Summing them lets a slow review masquerade as
  a slow agent.
- **CI verdicts and self-corrections** — how often the independent check
  rejected the work, and how often the agent fixed it without a human.
- **ACUs per merged pull request** — a defensible unit cost. Reported as `—`,
  not `0`, when the provider returns no ACU data: "not measured" and "free" are
  different claims.
- **False positives, tracked separately.** A well-argued "this report was wrong"
  is a success that produces no PR, and conflating it with a shipped fix would
  corrupt both numbers.
- **Grouped failure reasons** — so the next improvement is obvious.

`GET /api/devin/insights` adds the provider's own view of the same sessions —
tags, ACUs, pull requests, as Devin recorded them. It is not new information;
it is *independent* information, and it is where a disagreement between what
this service claims to have sent and what Devin received would show up.

```
  OUTCOMES
    pull requests merged .... 2  (of 3 opened)
    merge rate .............. 67%
    success rate ............ 80%  (of 5 concluded)
    false positives ......... 1  (reports correctly rejected)
    failed .................. 1
    timed out ............... 0
    withdrawn ............... 0  (cancelled; excluded from success rate)
    in flight ............... 0

  LATENCY
    issue → PR (median) ..... 14.2m   p90 22.0m
    PR → merged (median) .... 188.4m   human review
    full cycle (median) ..... 16.8m   p90 24.5m

  INDEPENDENT VERIFICATION
    CI passed ............... 3
    CI failed ............... 0
    self-corrections ........ 1  (CI failures fixed by Devin, no human)

  COST
    ACUs consumed ........... 6.0
    ACUs per merged PR ...... 3.0

  BY CATEGORY
    security       ████████████████████████   2 total, 0 PR, 50% success
    code-quality   ████████████████████████   2 total, 2 PR, 100% success
    dependency     ████████████                1 total, 1 PR, 100% success
```

---

## Why Devin specifically

Two properties of this workload rule out the cheaper options.

**The unit of work is a session, not a completion.** SEC-002 requires editing two
files in different modules, running `pytest`, reading the failure, and iterating.
DEP-001 requires walking a dependency tree, checking upstream release notes, and
writing a reasoned recommendation. Neither is a diff you can generate in one
shot — they need a machine that can run commands and respond to what comes back.

**Verification has to happen where the code runs.** The contract's value is that
`ruff check` and `pytest` actually execute before the PR opens. A model without
an environment can only *claim* the tests pass. Devin's sandbox is what turns
"the agent thinks it fixed it" into "the commands exited 0, here is the output".

**It argues back, and it is sometimes right.** This is the property that
separates an agent from a bot, and it is not hypothetical here. QUAL-002's
contract told Devin to verify with `npx tsc --noEmit -p tsconfig.json`. It got
the other checks passing, then stopped and reported that the type-check fails
with 598 `TS6305` errors in any clean checkout, because the root `tsconfig.json`
uses composite project references whose plugin outputs must be built first — and
that this was outside the contract's scope to fix. That was correct. A bot would
have failed silently, or worse, disabled the check to get green. The fix was to
amend the *contract*, in the issue, which both Devin and CI read. Twice more it
declined to open a duplicate pull request when it found its own earlier work
already on the branch.

A scripted codemod could handle SEC-001 and QUAL-002. It could not handle
QUAL-001 (design a shared helper, write its tests, update three call sites),
DEP-001 (investigate a dependency tree and reach a defensible "not yet"), or any
of the judgement calls above. The point of the contract format is that *the same
pipeline* handles all of them.

**Versus the alternatives, specifically:**

| | Why it isn't enough here |
|---|---|
| Dependabot | Answers one question — "is there a newer version?" — and cannot answer DEP-001, which is *why* the ceiling exists and whether the condition for lifting it has been met. |
| A deterministic codemod | Fine for SEC-001's one-line substitution. Has nothing to say when CI fails for a reason the author did not anticipate, which is most of the times CI fails. |
| A chat assistant | Produces a diff in someone's editor. The bottleneck is not writing the fix, it is the hour of investigation, verification and PR authorship around it, which needs an environment and no human in the loop. |

---

## Design notes

**Idempotency at five layers**, because duplicate work is the most expensive
mistake this system can make, and it turned out to have more ways in than the
first three guards covered:

1. Delivery UUIDs are recorded, so a webhook retry short-circuits.
2. Intake refuses an issue that already has a non-terminal remediation.
3. Intake refuses an issue whose fix is *already open as a pull request* — a
   finished remediation is terminal, but the issue stays open until the PR
   merges, so without this the periodic scanner sees fresh work every sweep.
4. Dispatch re-checks (3) immediately before spending, because a queued
   remediation can outlive the state it was accepted in.
5. Sessions are created with `idempotent: true` where the API supports it.

**HMAC over raw bytes.** The webhook endpoint is the only unauthenticated entry
point, and a forgery would let anyone spend the Devin budget. The server keeps
`rawBody` and verifies against it — re-serialising the parsed JSON changes the
bytes and breaks the digest. Comparison is constant-time; malformed input is
rejected cleanly rather than throwing.

**Autopilot never writes code.** It reads issues and posts comments. Devin pushes
branches and opens PRs through its own GitHub integration. That keeps the token
small and the trust boundary easy to describe in review.

**Failure is a first-class state.** `blocked` surfaces Devin's question on the
issue and waits. `timed_out` is enforced by the reconciler. Transport errors
requeue; 4xx errors terminate. A finished-but-no-PR session fails loudly.

**Blocked is the one state with no way out.** Every other non-terminal state
advances on its own; `blocked` is waiting on a human by definition, so without
an answer it just sits there until the timeout fires and charges the delay to
cycle time. `POST …/reply` is that path back — it sends the answer to the
session, records it as an event so the audit log shows who unblocked what, and
optimistically returns the remediation to `running` for the next reconcile to
confirm.

**Zero native dependencies.** Persistence uses Node 24's built-in `node:sqlite`,
so there's no `node-gyp` in the build and no compiler in the runtime image.

---

## Things that went wrong

Kept here deliberately. Every item below is visible in the issue threads, the
event log and the cancelled rows on the dashboard — none of it has been tidied
away, because a clean trail that isn't true is worth less than a messy one that
is.

**The reconciler killed two successful sessions.** The timeout was checked
before the session was read, so a session that had already opened a pull request
and then idled was recorded as `timed_out`. Two merge-ready PRs (#6, #7) were
reported as failures. Fixed by reading the session first and judging the
evidence: a timeout may no longer discard work that exists. `adoptOrphanedPullRequests()`
then repaired the historical rows from the provider's own record, and posted a
correction comment on each issue.

**Then the scanner paid for the same work three more times.** With those
remediations terminal and their issues still open and labelled, every sweep
looked like fresh work. Four duplicate sessions were dispatched across issues
\#1 and #2 before the two new dedup gates landed. Devin caught every one of them
— it found its own branch already pushed and declined to open a second PR — so
the cost was ACUs rather than a mess of pull requests, but the orchestrator
should never have asked.

**A blocked session with a pull request was invisible.** Devin's common shape is
to open the PR and *then* stop to ask whether anything else is wanted. Until the
reconciler started recording a PR the moment it exists, that work was missing
from the dashboard, from merge rate, and — worst — from the dedup gate.

**Two contracts specified verification that could not pass.** QUAL-001 and
QUAL-002 both called `npx tsc --noEmit -p tsconfig.json`, which fails in any
clean checkout of this repository. Devin diagnosed it precisely and escalated
instead of working around it; the contracts were amended in the issues, which is
the one place both the agent and CI read.

**CI on the fork had never run.** GitHub does not register workflows on a fork
until something is pushed, and the 45 inherited Apache Superset workflows would
have buried every PR in unrelated red. They are disabled at the API level, with
only `autopilot-verify` active. The frontend install also needed a fallback: the
fork's `package-lock.json` has drifted from `package.json` upstream, and `npm ci`
refusing to install is not a verdict on the change under review.

**Cost data is missing, and is shown as missing.** Every session in this
organisation reports `acus_consumed: 0.0`, and `/v3/enterprise/consumption/daily`
returns 403 for an org-scoped service user. The unit-cost tiles therefore read
`—`. Publishing a unit cost of zero would have been the easy option and a false
claim.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DEVIN_MODE` | `mock` | `live` calls the real API |
| `DEVIN_API_KEY` | — | required when live |
| `DEVIN_MAX_ACU` | `10` | per-session ceiling; a runaway task can't silently burn budget |
| `DEVIN_PLAYBOOK_ID` | — | standing procedure every session runs under; `npm run devin:setup` creates it |
| `GITHUB_TOKEN` | — | `repo` scope |
| `GITHUB_WEBHOOK_SECRET` | — | required unless `ALLOW_UNSIGNED_WEBHOOKS=true` |
| `AUTOPILOT_LABEL` | `autopilot` | the label that arms an issue |
| `MAX_CONCURRENT_SESSIONS` | `3` | backpressure on spend |
| `MAX_CI_REWORKS` | `2` | CI failures handed back to a session before escalating to a human |
| `AUTO_MERGE` | `false` | let Devin merge its own pull request once CI passes |
| `AUTO_MERGE_CATEGORIES` | `code-quality` | categories eligible for it; `security` is refused regardless |
| `AUTO_MERGE_GRACE_MS` | `600000` | after this, an unperformed merge is labelled `autopilot:needs-human` |
| `RECONCILE_INTERVAL_MS` | `15000` | poll cadence |
| `SESSION_TIMEOUT_MS` | `3600000` | after this, fail and terminate |

Full list in [`.env.example`](.env.example).

## API

| Method | Path | |
|---|---|---|
| `POST` | `/webhooks/github` | HMAC-verified ingress |
| `POST` | `/api/trigger` | manual trigger — `{"issueNumber": 1}` |
| `POST` | `/api/scan` | force a scheduled sweep |
| `POST` | `/api/tick` | force a reconcile pass |
| `POST` | `/api/remediations/:id/reply` | answer a blocked session — `{"message": "…"}` |
| `POST` | `/api/remediations/:id/cancel` | stop one remediation — `{"reason": "…"}` |
| `GET` | `/api/analytics` \| `/api/remediations` \| `/api/events` | reporting |
| `GET` | `/api/devin/insights` | the provider's own view of the same sessions |
| `GET` | `/healthz` \| `/metrics` | ops |

Webhook events handled: `issues` (label-driven intake), `issue_comment`
(`/autopilot retry`), `pull_request` (merge outcomes), `workflow_run` (the
review-fix loop). The last two also have polling fallbacks, so no capability
depends on having a public tunnel.

Operators can also comment `/autopilot retry` on an issue.

```bash
# Devin blocked on remediation 1 (the id from /api/remediations, not the issue
# number); answer it without leaving the terminal.
curl -X POST localhost:8080/api/remediations/1/reply \
  -H 'content-type: application/json' \
  -d '{"message": "yes, keep it backwards compatible"}'
```

## Tests

Two layers, because they fail differently.

**This orchestrator** — `npm test`, 150 tests, no network:

```bash
npm test
npm run typecheck
```

Covering contract parsing and its **refusal** paths, HMAC verification including
malformed input, delivery idempotency, the concurrency cap, the full
intake → dispatch → reconcile lifecycle across every terminal state, the
finished-without-PR judgement, the operator controls, the review-fix loop
(a failure reaches the session, a passing build is left alone, the rework cap
escalates, a second failing run is a new verdict), CI correcting a stale `failed`
in the other direction without ever promoting a remediation that produced no pull
request, the auto-merge gate — including the cases that must *not* merge: off by
default, `security` refused even when the allowlist names it, asked exactly once
however often the same green run is re-read — the escalation when a requested
merge never happens, and its restraint (it waits out the grace period, says
nothing when the merge did land, and escalates once), pull-request lifecycle and
merge-rate arithmetic, the exclusion of withdrawn work from every rate and chart
it would distort, and the two regressions above — evidence outranking the clock, and the dedup gate finding a
PR held by an older attempt. The webhook
ingress is exercised through a real Fastify instance, signature and all.

**The remediations themselves** — on the pull request, by
[`autopilot-verify`](https://github.com/watilde/superset/blob/master/.github/workflows/autopilot-verify.yml),
which re-runs the contract's own `verify` commands. `ruff`, `pytest`, `tsc` and
`jest` results on the PR come from GitHub Actions, not from a local terminal and
not from the agent's own report.

## Extending this

- **More triggers.** Dependabot alerts, CodeQL results, Sentry issues — anything
  that can produce a contract. Intake doesn't care where an issue came from.
- **A playbook per category.** One standing procedure exists today; security
  fixes and dependency audits deserve different ones.
- **Human review feedback, not just CI.** The review-fix loop currently answers
  to the build. `pull_request_review` comments could go back into the session
  the same way, so a reviewer's "why not use X here?" is answered in-session.
- **Confidence, not just category, as the auto-merge gate.** The tier is chosen
  by category today (`AUTO_MERGE_CATEGORIES`), which is a proxy for risk rather
  than a measure of it. Diff size, files touched, and whether the change is
  inside a module the contract named would all be better signals.
- **Cost governance.** ACU budgets per team, with the dashboard showing spend
  against them — blocked today by the provider not reporting ACUs on this plan.

## Devin features in use

| Feature | Where |
|---|---|
| v3 sessions, org-scoped | `src/devin/client-v3.ts` — inferred from the `cog_` key prefix |
| Structured output schema | Every session; success is decided from data, not prose |
| Tags and titles | `contract:`, `issue:`, `category:`, `severity:` — visible in the Devin dashboard, and cross-checked at `/api/devin/insights` |
| ACU ceiling | `max_acu_limit` on every session |
| Playbooks | The standing remediation procedure; `npm run devin:setup` |
| Scheduled sessions | A weekly audit that files new contract-carrying issues, so the backlog refills without anyone remembering to look |
| Session messages | The review-fix loop and `POST …/reply` both resume a session in place |
| Session analytics | `/api/devin/insights`, and the "As reported by Devin" panel on the dashboard |
| Session termination | Operator cancel, and the timeout path |

## Layout

```
src/
  config.ts          env validation — fails at boot, not at 3am
  core/
    contract.ts      the ```autopilot parser (the safety gate)
    prompt.ts        deterministic prompt + structured output schema
    orchestrator.ts  intake / dispatch / reconcile
    scanner.ts       periodic sweep
  devin/
    client-v1.ts     deprecated v1 API (apk_ keys)
    client-v3.ts     current v3 API (cog_ keys, org-scoped)
    http.ts          shared transport: retry, jittered backoff
    mock.ts          deterministic simulator
  github/
    webhook.ts       HMAC verification
  obs/
    metrics.ts       Prometheus
    analytics.ts     outcome-shaped reporting
scripts/
  issues.ts          the five contracts
  seed-issues.ts     create labels + issues
  devin-setup.ts     provision the playbook and the scheduled audit
  simulate.ts        end-to-end demo driver
  report.ts          terminal report
```

The CI half lives in the target repository, not here:
[`.github/workflows/autopilot-verify.yml`](https://github.com/watilde/superset/blob/master/.github/workflows/autopilot-verify.yml).

## Licence

MIT — see [LICENSE](LICENSE).
