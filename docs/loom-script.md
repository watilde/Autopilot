# Loom script — 5 minutes

Audience: VP of Engineering + senior ICs, curious about Devin. They have seen
demos where an agent writes a patch. What they have not seen is a system that
decides whether to believe it.

**Before recording**, have these open in tabs:

1. `http://localhost:8080` — dashboard, seeded (`npm run simulate`)
2. https://github.com/watilde/superset/issues — the five issues, all
   `autopilot:succeeded`
3. https://github.com/watilde/superset/issues/5 — QUAL-002, the pushback thread
4. https://github.com/watilde/superset/issues/3 — QUAL-001, the merge-refusal thread
5. `src/core/orchestrator.ts` — at `settleOnIndependentVerification`
6. A terminal in the repo

One rule for the recording: **do not narrate what is on screen.** Say the thing
the screen cannot say.

---

## 0:00 – 0:40 · What

> "Every engineering org has a backlog of work that is real, small, and never
> urgent enough. Known vulnerabilities. A dependency pin nobody can justify
> anymore. A pattern duplicated across three files. It is not that these are
> hard — it is that they cost a context switch each, and the context switch is
> the expensive part.
>
> So the obvious move is to point an agent at them. And the moment you do, you
> have a new problem, which is the one this project is actually about: **the
> agent tells you it fixed something. How do you know?**
>
> This is Autopilot. GitHub issues in, Devin sessions out, pull requests and
> metrics observable end to end. Five real issues on a fork of Apache Superset —
> two security, two code quality, one investigation — all five shipped and
> merged."

Show: the fork's issue list, five green `autopilot:succeeded` labels.

---

## 0:40 – 2:00 · How — the demo

Run the whole thing live, mock mode, no credentials:

```bash
docker compose up --build -d
npm run simulate
```

> "That is five signed webhooks. Nothing inside the server is stubbed — the
> signature is verified, the contract is parsed off the issue body, sessions are
> created, the reconciler polls them. Only GitHub and Devin are standing in.
>
> The thing to notice is the label an issue has to carry, and the block inside
> it."

Show the contract block in an issue:

> "Every issue carries a machine-readable contract: what to change, what *not*
> to touch, and the exact commands that constitute done. That block is not
> decoration. Devin runs those commands in its sandbox. And a **CI job on the
> pull request reads the same block off the same issue and runs the same
> commands again** — one definition of done, checked by two parties, one of
> which has no stake in the answer."

Then the dashboard:

> "Merge rate, not PR count. An unmerged PR is work the organisation declined.
> Time-to-PR separately from time-to-merge, because the second one is human
> review latency and summing them lets a slow reviewer make the agent look slow.
> ACUs per merged PR — a defensible unit cost."

---

## 2:00 – 3:10 · How — the architectural decision

Open `orchestrator.ts` at `settleOnIndependentVerification`.

> "One decision runs through the whole codebase: **independent evidence outranks
> what the agent says about its own work** — and it has to cut both ways, or it
> is just a rule about which errors you prefer to keep.
>
> The easy direction is demoting a 'fixed' that does not build. The hard
> direction is this one. QUAL-002 was recorded `failed` because Devin reported
> it was blocked. It was right to. We fixed the contract, it pushed, CI went
> green on the same pull request — and the record still said `failed`, on the
> strength of a snapshot taken before any of that. So CI now promotes a stale
> failure, narrowly: a PR must exist, and CI must have passed on it.
>
> The same principle decides what the numbers mean. A cancelled remediation is
> a decision, not a verdict — so it is out of the success-rate denominator, and
> out of cycle time, because a duplicate stopped ten seconds after it was queued
> is a very fast *nothing*."

Optional, if the pacing allows — this one lands with engineers:

> "And when the record disagreed with the issue labels, the labels were wrong
> in the worst possible way: four of five issues read `failed` or `timed out`
> while their PRs were merged. A dashboard saying 100% next to issues saying
> 'failed' is worse than either being wrong alone. It makes the honest number
> unbelievable too."

---

## 3:10 – 4:20 · Why Devin

This is the section that decides the pitch. Two artefacts, both real, both on
screen.

**Open issue #5 (QUAL-002).**

> "The contract told Devin to verify with `tsc --noEmit`. It got the other
> checks passing, then stopped and reported that the type-check fails with 598
> errors in *any* clean checkout — because the root tsconfig uses project
> references whose outputs must be built first — and that fixing that was
> outside the contract's scope.
>
> That was correct. **A codemod would have failed silently. A worse agent would
> have disabled the check to get green.** The fix was to amend the contract, in
> the issue, which both Devin and CI read."

**Open issue #3 (QUAL-001).**

> "Second one, from this week. We added auto-merge: green CI, low-risk category,
> Devin merges its own PR. We asked it to. It ran `gh pr merge` and came back
> with: *my tooling blocks merging into master, that is my guardrail not
> GitHub's, and auto-merge would hit the same rule so I will not try it as a
> workaround.* Then it told us the two things that would permit a merge.
>
> It refused, explained, distinguished its own policy from the platform's, and
> declined the workaround. That is not a bot. And the system's response was to
> label the issue `needs-human` and quote the refusal verbatim — because a
> refusal that only exists in a session transcript is the same as no refusal.
>
> **That is the case for an autonomous agent.** Not that it writes the patch —
> plenty of things write patches. It is that when the task as specified is
> wrong, it says so, and you can build a system that listens."

---

## 4:20 – 5:00 · When — next steps

> "In a real engagement, three things next.
>
> **Confidence as the merge gate, not category.** Today the tier is chosen by
> label, which is a proxy for risk rather than a measure of it. Diff size, blast
> radius, whether the change stayed inside the modules the contract named.
>
> **Human review into the loop, not just CI.** The rework loop answers to the
> build today. `pull_request_review` comments could go back into the same
> session, so a reviewer's 'why not use X here?' gets answered in-session
> instead of in a meeting.
>
> **Contracts from scanners.** Every issue here was hand-written and verified.
> The intake does not care where an issue came from — Dependabot, CodeQL,
> Sentry. That is where the volume is, and the volume is where this pays for
> itself.
>
> Repos and the full write-up are in the description. Thanks."

---

## Notes

- **Do not skip the two artefacts in the Why section.** Everything else in this
  demo could be built without an agent. Those two could not.
- If you overrun, cut the dashboard tour, not the pushback stories. The metrics
  are legible in a screenshot; the refusals need you to explain them.
- Have `npm run report` ready as a fallback if the dashboard is slow to load —
  same numbers, same source, works when the service is down.
- Do not claim Devin merged anything. It did not, and the reason it did not is
  one of the better moments in the demo.
