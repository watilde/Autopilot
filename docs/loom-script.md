# Script — 5 minutes

One script for both formats: the recorded Loom and the live walkthrough off
`slides.html`. The deck is the same argument with the prose removed, so a second
copy of the narration would only be a second thing to keep true.

Audience: VP of Engineering + senior ICs, curious about Devin. They have seen
demos where an agent writes a patch. What they have not seen is a system that
decides whether to believe it.

**The demo is the middle two minutes and it is mostly silence.** Everything else
is cut to the bone to pay for it: **644 spoken words, about four
minutes**, so the rest of the five is the system working. Resist filling the
waits — a thing working in front of people is more persuasive than a person
talking over it.

**Figures live in the deck, not here**, so there is one place to correct them.

## Which slide is up

Twelve slides, and **every one of them has words to say**. A slide nobody speaks
to is a slide that should not be in the deck, so three came out: the anatomy of a
single pull request, the contract slide, and the metrics table. All three were
saying on paper what the demo says on screen.

The order is the order you present in: **the script never sends you backwards.**
The cue is printed before each thing you say, so you never have to work out where
you are from the section heading.

| Section | Slides | Words |
|---|---|---|
| 0:00 – 0:35 · What | **1 · 2 · 3** | 78 |
| 0:35 – 2:45 · How — **the live run** | **4** → the browser → **5** | 244 |
| 2:45 – 3:25 · How — the decision | **6 · 7 · 8** | 83 |
| 3:25 – 4:25 · Why Devin | **9 · 10** | 153 |
| 4:25 – 5:00 · When — next | **11 · 12** | 86 |

**Slide 5 is also the fallback.** It is a run that already finished, so it is
where you go the moment the live one stalls — say why you moved, and come back
before the close.

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
happened in five minutes; slide 5 is the honest version and you say it out loud there.

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

## 0:00 – 0:35 · What · slides 1 · 2 · 3

**▸ Slide 1 — Autopilot** (title)

> "Every org has a backlog that is real, small, and never urgent enough. Not
> hard — each one costs a context switch, and that is the expensive part."

**▸ Slide 2 — The backlog nobody gets to**

> "So you point an agent at it — and inherit a different problem: **the agent
> says it fixed it. How do you know?**"

**▸ Slide 3 — What shipped**

> "This is Autopilot. Seven issues on a Superset fork, seven merged pull
> requests — and **two of those issues nobody wrote.**"

---

## 0:35 – 2:45 · How — the live run · slide 4, then the browser, then 5

Six beats, in the order they happen. Between them you are watching, not talking.

**▸ Slide 4 — One button, and then we watch.** Read nothing off it.

> "One button, and we watch. Nothing here is stubbed."

### 1 · Find something to fix

**Click the button.**

> "That session has no idea what is wrong with this repo. It goes and reads it."

### 2 · What Devin is doing, from Devin's side

**Open the session link** — every dashboard row carries one — then the *As
reported by Devin* panel at the foot of the page.

> "The same work, counted by Devin instead of by us. If the prompts and tags we
> claim to have sent are not the ones it received, **this is where that shows
> up** — checkable against Devin's own dashboard, without taking my word for it."

### 3 · It files the issue

**Open the new issue** and scroll to the fenced block.

> "A real defect, and at the bottom a **contract**: what to change, what not to
> touch, and the commands that constitute done. No contract, no session — that
> gate has refused four hundred and thirty-four issues here."

### 4 · A pull request against that issue

**Open the PR.** Point at the body.

> "It carries the commands it ran and what they printed. Not a summary of them."

### 5 · Wait for CI to go green

**Open the check.** The long wait — say one number, then stop talking.

> "That job read the same contract off the same issue and ran the same commands
> again. **One definition of done, checked by two parties — one with no stake in
> the answer.**"

### 6 · It merges its own pull request

*(With `REVIEW_AGENT` on, a second session reviews first and its verdict releases
the merge. If that is on camera: "a second session, which never saw the change
being made — only the diff and the contract.")*

> "Then it merges its own pull request. Autopilot **asked** — it never records a
> merge. That comes back from GitHub like any other observer, which is why a
> merge that never happened shows up as a pull request still open."

**▸ Slide 5 — Nobody had noticed this bug at 08:56.** Close on it — and put it up
early, without apology, if the live run is still going.

> "At 08:56 nobody knew that bug existed; merged at 09:35. The only human action
> was the approval — and it was **not required**. The next one merged on the
> reviewing agent's verdict alone."

---

## 2:45 – 3:25 · How — the decision · slides 6 · 7 · 8

**▸ Slide 6 — Architecture.** Recording: open `orchestrator.ts` at
`settleOnIndependentVerification` instead, and let the code be the slide.

**▸ Slide 7 — The principle**

> "One decision runs through the codebase: **independent evidence outranks what
> the agent says about its own work** — and it has to cut both ways, or it is
> just a rule about which errors you prefer to keep.
>
> Demoting a 'fixed' that does not build is easy. The hard direction: a
> remediation recorded `failed` on the agent's own report, that CI later passed.
> That gets promoted."

**▸ Slide 8 — What the system refuses to claim.** Let the room read it.

> "And the same principle decides what it will not claim."

---

## 3:25 – 4:25 · Why Devin · slides 9 · 10

Three artefacts. Everything else here could be built without an agent; these
could not. **Let the room read the quotes** — they are on the slides.

**▸ Slide 9 — It argues back, and it is right.** Recording: open issue #5.

> "The contract said verify with `tsc --noEmit`. It got everything else green,
> then stopped: that check fails in *any* clean checkout, and fixing it is
> outside this contract. It was right. A worse agent disables the check."

**▸ Slide 10 — It refuses, and explains.** Recording: open issue #3.

> "We asked it to merge its own pull request: *my tooling blocks merging into
> master — my guardrail, not GitHub's — so I will not try auto-merge as a
> workaround.*"

**Still slide 10.** Recording: open PR #14.

> "And the reviewing session opened with: *submitting as a comment, because
> GitHub will not let this account approve a pull request it opened.* It hit a
> limit on its own authority and reported it accurately.
>
> **That is the case for an autonomous agent.** Not that it writes the patch. It
> is that when it is not entitled to do what you asked, it says so — and you can
> build a system that listens."

---

## 4:25 – 5:00 · When · slides 11 · 12

**▸ Slide 11 — Next, in a real engagement**

> "Three things next.
>
> **Confidence as the merge gate, not category** — diff size, blast radius,
> whether the change stayed inside the modules the contract named.
>
> **A reviewer who is not us** — an agent reviewing an agent is a second opinion,
> and GitHub says so itself by refusing the approval.
>
> **Contracts from scanners.** Intake does not care where an issue came from, and
> that is where the volume is.
>
> Repos and the write-up are in the description. Thanks."

**▸ Slide 12 — Run it yourself.** Leave it up while you say the last line, so the
clone command is on screen when the recording ends.

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
