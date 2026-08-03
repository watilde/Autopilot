# Script — 5 minutes

One script for both formats: the recorded Loom and the live walkthrough off
`slides.html`. The deck is the same argument with the prose removed, so a second
copy of the narration would only be a second thing to keep true.

Audience: VP of Engineering + senior ICs, curious about Devin. They have seen
demos where an agent writes a patch. What they have not seen is a system that
decides whether to believe it.

**The demo is the middle two minutes and it is mostly silence.** Everything else
is cut to the bone to pay for it. Resist filling the waits — a system working in
front of people is more persuasive than a person talking over it.

**Figures live in the deck, not here**, so there is one place to correct them.

## Which slide is up

| Section | Slides | Words |
|---|---|---|
| 0:00 – 0:35 · What | 1 · 2 · 3 | ~85 |
| 0:35 – 2:45 · How — **the live run** | 4, then the browser | ~190 |
| 2:45 – 3:25 · How — the decision | 7 · 9 · 13 | ~95 |
| 3:25 – 4:25 · Why Devin | 11 · 12 | ~150 |
| 4:25 – 5:00 · When — next | 14 · 15 | ~75 |

Slide 5 is the run that already finished. It is the **fallback**, not part of the
plan — see the runbook.

---

## The live run does not fit in five minutes

Measured on this deployment: issue → pull request has a median of **17.6 minutes**
and a p90 of **83.8**. CI adds about two, the review about four, the merge
seconds. A run from the button is twenty to forty minutes. No amount of pacing
gets that into a five-minute recording.

So there are two modes, and the script above is written for the first:

**Recorded (the deliverable).** Start the audit **before** you hit record — early
enough that the issue and the pull request already exist. On camera, press the
button anyway (it is real, and a second audit is a legitimate thing to start),
then follow the run that is already at the CI stage. Those last three steps — CI
green, the review, the merge — take about six minutes of wall clock and can be
trimmed in Loom. Say that you started it earlier. Do not imply the whole thing
happened in five minutes; the timeline on slide 5 is the honest version and it is
on screen anyway.

**Live, in a room.** Press the button and let it run. The waits are the demo:
they are when you talk about the contract gate, the numbers, and the two
pushback stories. Nobody minds waiting for something that is visibly working, and
slide 5 is there for the moment it goes quiet.

## The runbook for the live run

**Before you start**

```bash
docker compose up -d && curl -s localhost:8080/healthz     # live mode, GitHub configured
curl -s localhost:8080/api/audit                            # {"inFlight":[]} — nothing running
gh issue list --repo watilde/superset --state open          # empty, so anything new is from this run
```

Settings that have to be on, or the chain stops halfway:

| | |
|---|---|
| `REVIEW_AGENT=true` | otherwise nothing reviews and the merge waits forever |
| `AUTO_MERGE=true` | otherwise the merge is never asked for |
| `AUTO_MERGE_CATEGORIES` | must contain whatever the audit files. `security` is refused whatever it says |
| `PR_BASE_BRANCH=autopilot-integration` | **the one that decides whether the demo ends in a merge.** Devin refuses `main`/`master` unconditionally |

**What you click, and roughly when**

| Step | Where | Typical | Watch for |
|---|---|---|---|
| Find something to fix | dashboard, top | — | button greys out, session link appears |
| An issue appears | the fork's issue list | 2–10 min | must carry an <code>autopilot</code> block |
| Accepted | dashboard, Pipeline | ~1 min | or `autopilot:needs-contract` if it did not |
| Pull request | Remediations table | 6–18 min | base is the integration branch |
| CI green | the PR's checks | ~2 min | "Verify contract" |
| Review | Review card | ~4 min | "Approved by the agent" |
| Merged | Outcomes | seconds | merge rate moves |

**Two things will go wrong, and both are fine to show**

- **The audit files nothing.** A legitimate result — it says so, and the
  dashboard prints "nothing worth filing" rather than hiding it. Say that, then
  move to slide 5.
- **The issue arrives without a contract.** Intake refuses it and labels it
  `autopilot:needs-contract`. That is the gate doing its job in public, and it is
  a better moment than the happy path. Show the label, then move to slide 5.

**If it stalls, do not wait on camera.** Move to slide 5 — a run that finished
this morning — say plainly that the live one is still going, and come back to it
before the close. A demo that admits it is waiting beats a silence.

---

## 0:00 – 0:35 · What
<!-- Slides 1 → 2 → 3. Move on "So the obvious move…" and on "This is Autopilot." -->

> "Every org has a backlog that is real, small, and never urgent enough. Known
> vulnerabilities. A dependency pin nobody can justify. The same weak pattern in
> three files. Not hard — each one costs a context switch, and that is the
> expensive part.
>
> So you point an agent at it, and you inherit a different problem: **the agent
> says it fixed it. How do you know?**
>
> This is Autopilot. Seven issues on a fork of Apache Superset, seven pull
> requests, all merged — and **two of those issues nobody wrote.**"

---

## 0:35 – 2:45 · How — the live run
<!-- Slide 4, then the browser. Mostly watching. -->

Slide 4 up. Read nothing off it.

> "I am going to press one button and we are going to watch the whole thing
> happen. Nothing here is stubbed."

**Click *Find something to fix*.** Then the fork's issue list, and wait.

> "That started a session with no idea what is wrong with this repository. It is
> going to read it and file what it finds."

**When the issue appears**, open it and scroll to the fenced block.

> "There it is. And the part that matters is at the bottom: a **contract** —
> what to change, what not to touch, and the exact commands that constitute
> done. No contract, no session. That gate has refused four hundred and
> thirty-four issues here."

**Dashboard.** Point at the row appearing, then wait for the pull request. This
is the long one; use it.

> "While that runs — the numbers on this page are outcome-shaped on purpose.
> Merge rate, not pull request count. Issue-to-PR kept apart from PR-to-merged.
> ACUs read *not reported for this account*, because 'not measured' and 'free'
> are different claims."

**When CI goes green**, open the check.

> "That job read the same contract off the same issue and ran the same commands
> again, on the pull request. **One definition of done, checked by two parties,
> one of which has no stake in the answer.**"

**When the review appears**, open it.

> "A second session — it never saw the change being made, only the diff and the
> contract."

**When it merges**, back to the dashboard.

> "Autopilot asked for that merge. It did not record it. The merge is read back
> from GitHub like any other observer."

---

## 2:45 – 3:25 · How — the decision
<!-- Slide 7 for the contract, 9 for the numbers, 13 for what it will not claim.
     Recording: `orchestrator.ts` at settleOnIndependentVerification instead. -->

> "One decision runs through the codebase: **independent evidence outranks what
> the agent says about its own work** — and it has to cut both ways, or it is
> just a rule about which errors you prefer to keep.
>
> Demoting a 'fixed' that does not build is easy. The other direction is the
> hard one: a remediation recorded `failed`, on the agent's own report, that CI
> later passed on the same pull request. That gets promoted.
>
> And the same principle decides what this will *not* claim. It asks for merges.
> It never records one."

---

## 3:25 – 4:25 · Why Devin
<!-- Slides 11 and 12. Let the room read the quotes. -->

Three artefacts. Everything else here could be built without an agent; these
could not.

**Issue #5.**

> "The contract said verify with `tsc --noEmit`. It got everything else green,
> then stopped: that check fails in *any* clean checkout, and fixing it is
> outside this contract. It was right. A codemod fails silently; a worse agent
> disables the check."

**Issue #3.**

> "We asked it to merge its own pull request. It said: *my tooling blocks
> merging into master — that is my guardrail, not GitHub's, so I will not try
> auto-merge as a workaround.* Then it named what would permit one."

**PR #14.**

> "And the reviewing session opened with: *submitting as a comment, because
> GitHub will not let this account approve a pull request it opened.* It hit a
> limit on its own authority and reported it accurately.
>
> **That is the case for an autonomous agent.** Not that it writes the patch —
> plenty of things write patches. It is that when it is not entitled to do what
> you asked, it says so, and you can build a system that listens."

---

## 4:25 – 5:00 · When
<!-- Slide 14 for the three, 15 to close on. -->

> "Three things next.
>
> **Confidence as the merge gate, not category** — diff size, blast radius,
> whether the change stayed inside the modules the contract named.
>
> **A reviewer who is not us.** An agent reviewing an agent is a second opinion
> — GitHub says so itself by refusing the approval. That needs a different
> identity, not another agent.
>
> **Contracts from scanners.** Intake does not care where an issue came from.
> That is where the volume is.
>
> Repos and the write-up are in the description. Thanks."

---

## Notes

- **Do not narrate what is on screen.** Say the thing the screen cannot say.
- **Do not claim Devin merged into `master`.** It refused, twice. Both merges
  went to an integration branch — the workaround Devin itself named.
- **Do not claim the reviewing agent approved on GitHub.** It cannot. The record
  says `agent` and so should you.
- If you overrun, cut the numbers paragraph in the demo, not the artefacts.
- `npm run report` is the fallback if the dashboard is slow. It reads the *host*
  database; the dashboard reads the container's. Re-sync first or they disagree
  on camera:
  ```bash
  for f in autopilot.db autopilot.db-wal autopilot.db-shm; do
    docker cp "autopilot-autopilot-1:/data/$f" "data/$f"
  done
  npm run report      # must match the dashboard
  ```
