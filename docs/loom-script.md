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
| 0:00 – 0:45 · What | 1 · 2 · 3 |
| 0:45 – 2:15 · How — the demo | 4 · 7 · 9 (live dashboard instead, if presenting) |
| 2:15 – 3:15 · How — the decision | 6 · 8 · 12 |
| 3:15 – 4:20 · Why Devin | 10 · 11 |
| 4:20 – 5:00 · When — next | 13 · 14 |

Presenting from the deck: <kbd>N</kbd> shows the stage direction for each slide —
how to land it, what not to claim. Those are deliberately not the words to say;
the words are here.

## Before recording

1. `http://localhost:8080` — **scrolled past the KPI row**, so the verification
   and refusal sections are what lands. Check it is reading the real record
   first: an empty database renders every local figure as a dash while the "as
   reported by Devin" panel fills in from the API, which reads as broken rather
   than as empty.
2. https://github.com/watilde/superset/issues/11 — the issue **Devin filed**,
   and https://github.com/watilde/superset/pull/12 — the PR that closed it
3. https://github.com/watilde/superset/pull/14 — REL-002, where the reviewing
   agent explains why it cannot approve
4. https://github.com/watilde/superset/issues/5 — QUAL-002, the pushback thread
5. https://github.com/watilde/superset/issues/3 — QUAL-001, the merge-refusal thread
6. `src/core/orchestrator.ts` — at `settleOnIndependentVerification`
7. A terminal in the repo

**`npm run report` reads SQLite directly and is the fallback if the dashboard is
slow.** It reads the *host* database, which is a snapshot — if the container has
worked since, the two disagree and the demo contradicts itself on camera. Re-sync
before recording:

```bash
for f in autopilot.db autopilot.db-wal autopilot.db-shm; do
  docker cp "autopilot-autopilot-1:/data/$f" "data/$f"
done
npm run report      # must match the dashboard
```

One rule for the recording: **do not narrate what is on screen.** Say the thing
the screen cannot say.

---

## 0:00 – 0:45 · What
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
> metrics observable end to end. Seven issues on a fork of Apache Superset, seven
> pull requests, all merged — and **two of those issues nobody wrote. Devin found
> them itself.**"

Show: the fork's issue list.

---

## 0:45 – 2:15 · How — the demo
<!-- Slide 4 is the spine: the timeline. Then slide 7 for the contract and slide
     9 for the numbers. Presenting live, scroll the dashboard instead. -->

Open the timeline — or, live, `npm run scenario`, which drives one issue through
every path a step at a time.

> "One of them, start to finish, this morning.
>
> **At 08:56 nobody knew this bug existed.** A session reads the repository and
> files an issue: the Slack notifier claims it truncated a table, then sends the
> whole thing — so the message is rejected and the notification fails.
>
> Intake accepts it at 09:05, and only because the issue carries a **contract**:
> what to change, what not to touch, and the commands that constitute done. No
> contract, no session. That gate has refused four hundred and thirty-four
> issues here — including this one, twice, before it carried one.
>
> Pull request at 09:11. CI green at 09:13 — and that job is the point. It reads
> the same contract off the same issue and runs the same commands again, on the
> pull request. **One definition of done, checked by two parties, one of which
> has no stake in the answer.**
>
> Merged at 09:35. Thirty-nine minutes from nobody-knew to shipped."

Then the dashboard. Scroll past the top row.

> "Merge rate, not PR count — an unmerged PR is work the org declined.
> Issue-to-PR kept apart from PR-to-merged, because summing them lets a slow
> reviewer make the agent look slow. ACUs read *not reported for this account* —
> 'not measured' and 'free' are different claims.
>
> The two sections underneath are where I would actually look. **What Devin
> claimed, next to what CI found.** And **what the system refused to do**. A
> system that reports only what it did is not observable, it is advertising."

---

## 2:15 – 3:15 · How — the architectural decision
<!-- Slide 6 to place the pieces, slide 8 for the principle, slide 12 for what
     the system refuses to claim. Recording: `orchestrator.ts` instead of 6. -->

Open `orchestrator.ts` at `settleOnIndependentVerification`.

> "One decision runs through the codebase: **independent evidence outranks what
> the agent says about its own work** — and it has to cut both ways, or it is
> just a rule about which errors you prefer to keep.
>
> Demoting a 'fixed' that does not build is easy. This is the other direction:
> QUAL-002 was recorded `failed` because Devin reported it blocked — correctly.
> We fixed the contract, it pushed, CI went green on the same PR, and the record
> still said `failed` on a snapshot taken before any of that. CI now promotes a
> stale failure, narrowly.
>
> The same principle decides what this will not claim. **Autopilot asks for a
> merge. It never records one.** The merge is read back from GitHub like any
> other observer — so one that never happened shows up as a pull request still
> open, and the issue goes to a human with the session quoted verbatim."

---

## 3:15 – 4:20 · Why Devin
<!-- Slides 10 and 11. Presenting, the quotes are on the slides — let them read.
     Recording, open the issues themselves; the thread beats a quotation. -->

This is the section that decides the pitch. Three artefacts, all real, all on
screen. Do not skip them: everything else in this demo could be built without an
agent. These could not.

**Open issue #5 (QUAL-002).**

> "The contract said verify with `tsc --noEmit`. It got everything else green,
> then stopped: the type-check fails with 598 errors in *any* clean checkout,
> because the root tsconfig uses project references — and fixing that is outside
> this contract's scope.
>
> That was correct. **A codemod fails silently. A worse agent disables the check
> to get green.** The fix was to amend the contract, which both Devin and CI read."

**Open issue #3 (QUAL-001).**

> "We added auto-merge and asked it to merge its own PR. It came back with: *my
> tooling blocks merging into master — that is my guardrail, not GitHub's, so
> auto-merge hits the same rule and I will not try it as a workaround.* Then it
> named the two things that would permit one.
>
> It refused, explained, **told its own policy apart from the platform's**, and
> declined the workaround."

**Open PR #14 — the newest one, and the one I did not expect.**

> "A *second* session reviews the pull request — one that never saw the change
> being made, with only the diff and the contract. It reviewed it properly, and
> opened with this: *submitting as a comment, because GitHub will not let this
> account approve a pull request it opened.*
>
> It hit a limit on its own authority, reported it accurately, and downgraded its
> own verdict rather than dressing it up. **That is the case for an autonomous
> agent.** Not that it writes the patch — plenty of things write patches. It is
> that when it is not entitled to do what you asked, it says so, and you can
> build a system that listens."

---

## 4:20 – 5:00 · When — next steps
<!-- Slide 13 for the three, slide 14 to close on. -->

> "Three things next.
>
> **Confidence as the merge gate, not category** — diff size, blast radius,
> whether the change stayed inside the modules the contract named.
>
> **A reviewer who is not us.** The loop closes with nobody in it today, but an
> agent reviewing an agent is a second opinion — GitHub says so itself by
> refusing the approval. That gap needs a different identity, not another agent.
>
> **Contracts from scanners.** Intake does not care where an issue came from —
> Dependabot, CodeQL, Sentry. That is where the volume is.
>
> Repos and the write-up are in the description. Thanks."

---

## Notes

- **Do not skip the three artefacts in the Why section.** They are the only part
  of this that a deterministic tool could not have produced.
- If you overrun, cut the dashboard tour, not the pushback stories. The metrics
  are legible in a screenshot; the refusals need you to explain them.
- **Do not claim Devin merged into `master`.** It refused to, twice, and both
  merges went to an integration branch after the base was retargeted — which is
  the workaround Devin itself named when it declined.
- Do not claim the reviewing agent approved anything on GitHub. It cannot. The
  record says `agent`, and so should you.
- The two agent-found issues are the strongest thing here and the easiest to
  undersell. Say the timestamp out loud: at 08:56 nobody knew that bug existed.
