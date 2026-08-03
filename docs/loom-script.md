# Script — 5 minutes

The spoken words for both formats: the recorded Loom, and the live walkthrough
off `slides.html`. There is one script because there is one argument — the deck
is the same case with the prose removed, so a second copy of the narration would
only be a second thing to keep true.

Audience: VP of Engineering + senior ICs, curious about Devin. They have seen
demos where an agent writes a patch. What they have not seen is a system that
decides whether to believe it.

**Figures live in the deck, not here.** Merge rate, medians, test count — read
them off the slide. This file states them only where the sentence collapses
without one, so there is one place to correct when they move.

## Which slide is up

| Section | Slides |
|---|---|
| 0:00 – 0:40 · What | 1 · 2 · 3 |
| 0:40 – 2:00 · How — the demo | 6 · 4, then 8 (live demo instead, if recording) |
| 2:00 – 3:10 · How — the decision | 5 · 7 · 11 |
| 3:10 – 4:20 · Why Devin | 9 · 10 |
| 4:20 – 5:00 · When — next | 12 · 13 |

Presenting from the deck: <kbd>N</kbd> shows the stage direction for each slide —
how to land it, what not to claim. Those are deliberately not the words to say;
the words are here.

**Before recording**, have these open in tabs:

1. `http://localhost:8080` — the dashboard, **scrolled past the KPI row** so the
   verification and refusal sections are what lands. Check it is reading the
   real record before you start: an empty database renders every local figure as
   a dash while the "as reported by Devin" panel fills in, which looks broken
   rather than empty. Seed with `npm run simulate` for the mock walkthrough.
2. https://github.com/watilde/superset/issues — the five issues, all
   `autopilot:succeeded`
3. https://github.com/watilde/superset/pull/8 — DEP-001, the audit Devin wrote
4. https://github.com/watilde/superset/issues/5 — QUAL-002, the pushback thread
5. https://github.com/watilde/superset/issues/3 — QUAL-001, the merge-refusal thread
6. `src/core/orchestrator.ts` — at `settleOnIndependentVerification`
7. A terminal in the repo

One rule for the recording: **do not narrate what is on screen.** Say the thing
the screen cannot say.

---

## 0:00 – 0:40 · What
<!-- Slides 1 → 2 → 3. Move on "So the obvious move…" and on "This is Autopilot." -->


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
<!-- Recording: run it live. Presenting: slide 6 for the contract, slide 4 for
     what came back, slide 8 for the numbers, and offer slide 13 to anyone who
     wants to run it themselves. -->

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

Then what came back — open PR #8, or slide 4, which is the same body:

> "This is the pull request for the dependency issue. The pin says
> `setuptools<81`, and the comment justifying it names a package that is not in
> this repository's dependency tree. Nobody had ever measured it. Devin did:
> `pkg_resources` is removed in 82, not 81. Exactly one runtime dependency still
> imports it. The release of that dependency which fixes it needs SQLAlchemy 2.0,
> which Superset does not support — so the ceiling stays, and now there is a
> reason on file.
>
> The half that matters is underneath. The evidence is *in the pull request* —
> the commands, and what they printed — so a reviewer settles it in a minute
> without redoing the investigation and without taking the agent's word for
> anything. That is not this session being thorough. The playbook makes it
> mandatory: the body carries what was run and what it printed."

Then the dashboard. Scroll it; the top row is the least interesting part.

> "Merge rate, not PR count. An unmerged PR is work the organisation declined.
> Issue-to-PR separately from PR-to-merged, because the second one is human
> review latency and summing them lets a slow reviewer make the agent look slow.
> And ACUs are on there reading *not reported for this account* — the meter is
> wired, this account does not return the figure, and 'not measured' and 'free'
> are different claims.
>
> Then the two sections underneath, which is where I'd actually look. **What
> Devin claimed, next to what CI found** — including one it reported as
> *blocked* that CI then passed, so the record says succeeded on the evidence
> rather than on the report. And **what the system refused to do**: the intake
> refusals, work never dispatched and never paid for, which is the number with
> no row anywhere else.
>
> And at the bottom, the merge it asked for and never got, with the session's
> refusal quoted in full. Nothing there is paraphrased."

---

## 2:00 – 3:10 · How — the architectural decision
<!-- Slide 5 to place the pieces, slide 7 for the principle, slide 11 for what
     the system refuses to claim. Recording: `orchestrator.ts` instead of 5. -->

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
<!-- Slides 9 and 10. Presenting, the quotes are on the slides — let them read.
     Recording, open the issues themselves; the thread beats a quotation. -->

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
<!-- Slide 12 for the three, slide 13 to close on. -->


> "In a real engagement, three things next.
>
> **Confidence as the merge gate, not category.** Today the tier is chosen by
> label, which is a proxy for risk rather than a measure of it. Diff size, blast
> radius, whether the change stayed inside the modules the contract named.
>
> **A reviewer who is not us.** The loop now closes with nobody in it — an
> audit session files the issue, CI checks the fix, a second session reviews the
> pull request. But an agent reviewing an agent is a *second opinion*, not
> independent evidence: it comes from the same provider as the one that wrote
> the code. Only CI is the latter, and closing that gap is the next real
> problem, not another agent.
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
- Presenting rather than recording, the demo section is the one that changes:
  slides 6 and 8 carry the contract and the numbers, but a live `npm run
  simulate` is worth more than either. Run it if the room allows.
- The pull request itself is worth the thirty seconds it costs. Everything up to
  that point is the org's side of the contract; PR #8 is the only place the room
  sees what came back — and it is the artefact, not the dashboard, that a
  sceptical engineer will actually judge this on.
