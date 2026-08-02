/**
 * The remediation backlog seeded into the Superset fork.
 *
 * Every one of these was found by reading the actual source of
 * apache/superset at the commit the fork was taken from — file paths, line
 * numbers and code excerpts are real, and each was manually confirmed before
 * being written down. That matters: an agent pointed at a fabricated defect
 * will either hallucinate a fix or waste a session proving there is nothing
 * wrong, and neither tells you anything about whether the system works.
 *
 * Each issue carries an ```autopilot contract — the machine-readable half that
 * Autopilot parses. `verify` commands were chosen to be fast and hermetic:
 * lint, byte-compile, targeted unit tests and greps, never the full Superset
 * suite, which needs a database and many minutes.
 */

export interface SeedIssue {
  key: string;
  title: string;
  labels: string[];
  body: string;
}

export const SEED_ISSUES: SeedIssue[] = [
  // -------------------------------------------------------------------------
  {
    key: 'SEC-001',
    title: 'Unsafe YAML deserialization: `yaml.load` with full `yaml.Loader` in examples importer',
    labels: ['autopilot', 'security', 'python'],
    body: `## Summary

\`superset/examples/utils.py\` deserializes example-bundle metadata with PyYAML's
**full** loader instead of the safe one:

\`\`\`python
# superset/examples/utils.py:261
metadata = yaml.load(contents.get(METADATA_FILE_NAME, "{}"), Loader=yaml.Loader)  # noqa: S506
\`\`\`

## Why this matters

\`yaml.Loader\` is not safe against untrusted input. Unlike \`yaml.safe_load\`, it
honours tags that can instantiate arbitrary Python objects, which is the classic
CWE-502 (deserialization of untrusted data) path to remote code execution.

The content being parsed comes from an unpacked example bundle. Superset treats
that as trusted today, but "trusted" is a deployment assumption, not a property
of the code — anyone who can place or substitute a bundle inherits the process.
The trailing \`# noqa: S506\` is Bandit's *"probable use of unsafe loader"* rule
being suppressed rather than resolved, so no scanner will flag this again.

Nothing in the surrounding code needs the full loader: the parsed result is a
plain metadata mapping that only ever has a \`type\` key removed before being
re-dumped.

## Expected

Use \`yaml.safe_load\`, and drop the now-unnecessary suppression comment.

\`\`\`autopilot
id: SEC-001
category: security
severity: high
targets:
  - superset/examples/utils.py:261
acceptance:
  - "yaml.load(..., Loader=yaml.Loader) is replaced with yaml.safe_load(...)"
  - "The now-redundant '# noqa: S506' suppression is removed from that line"
  - "Behaviour is unchanged for valid metadata: the parsed value is still a dict and the 'type' key is still stripped"
  - "No other call sites or files are modified"
verify:
  - "python -m compileall -q superset/examples/utils.py"
  - "! grep -q 'Loader=yaml.Loader' superset/examples/utils.py"
  - "! grep -q 'noqa: S506' superset/examples/utils.py"
  - "grep -q 'yaml.safe_load' superset/examples/utils.py"
  - "ruff check superset/examples/utils.py"
notes: |
  Keep the change to the single statement. Do not refactor the surrounding
  import_examples flow, and do not touch other yaml call sites in the repo.
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  {
    key: 'SEC-002',
    title: '`hashlib.md5()` without `usedforsecurity=False` crashes Superset on FIPS-enabled hosts',
    labels: ['autopilot', 'security', 'python'],
    body: `## Summary

Two non-cryptographic hash call sites use \`hashlib.md5()\` without declaring the
non-security intent:

\`\`\`python
# superset/utils/hashing.py:34
"md5": lambda data: hashlib.md5(data).hexdigest(),  # noqa: S324

# superset/config.py:3211
return hashlib.md5(source).hexdigest()[:12]  # noqa: S324
\`\`\`

## Why this matters

This is not a theoretical hardening nit — it is a crash.

On a FIPS-enabled build of OpenSSL, MD5 is disabled, and \`hashlib.md5(data)\`
raises \`ValueError: [digital envelope routines] unsupported\`. Python provides
\`usedforsecurity=False\` (3.9+) precisely for this case: it tells the hashlib
backend the digest is being used as a checksum, not as a security primitive, and
lets it succeed on a FIPS host.

Both of these uses are unambiguously non-security, and the code says so itself —
\`superset/utils/hashing.py\` documents \`get_hash_algorithm\` as returning the
algorithm "for non-cryptographic purposes", and the \`config.py\` site is
fingerprinting a config file for diagnostics. So the flag is exactly right here,
and it also lets the \`# noqa: S324\` suppressions come out: Bandit does not flag
\`md5(..., usedforsecurity=False)\`.

Government, healthcare and financial deployments routinely run FIPS mode. Today
Superset fails there on any code path that hashes with the default algorithm.

## Expected

Pass \`usedforsecurity=False\` at both sites and remove the suppressions.

\`\`\`autopilot
id: SEC-002
category: security
severity: high
targets:
  - superset/utils/hashing.py:34
  - superset/config.py:3211
acceptance:
  - "Both hashlib.md5() calls pass usedforsecurity=False"
  - "The '# noqa: S324' suppressions on those two lines are removed, since Bandit no longer flags them"
  - "Hash output values are unchanged on a non-FIPS host (the flag does not alter the digest)"
  - "The existing unit tests in tests/unit_tests/utils/test_hashing.py still pass"
  - "sha256 call sites are left alone"
verify:
  - "python -m compileall -q superset/utils/hashing.py superset/config.py"
  - "python -c \\"import hashlib; assert hashlib.md5(b'superset', usedforsecurity=False).hexdigest() == hashlib.md5(b'superset').hexdigest()\\""
  - "! grep -n 'hashlib.md5(' superset/utils/hashing.py superset/config.py | grep -v 'usedforsecurity=False'"
  - "ruff check superset/utils/hashing.py superset/config.py"
  - "pytest tests/unit_tests/utils/test_hashing.py -q"
notes: |
  There is a third md5 call in superset/mcp_service/chart/chart_utils.py. Leave
  it out of this PR: it spans multiple lines and deserves its own review. Fix
  only the two sites listed above.
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  {
    key: 'QUAL-001',
    title: 'Collision-prone `Math.random()` option-name generation duplicated across three modules',
    labels: ['autopilot', 'code-quality', 'frontend'],
    body: `## Summary

The same ad-hoc identifier generator is copy-pasted into three files:

\`\`\`ts
// superset-frontend/src/explore/components/controls/MetricControl/AdhocMetric.ts:124
\`metric_\${Math.random().toString(36).substring(2, 15)}_\${Math.random().toString(36).substring(2, 15)}\`

// superset-frontend/src/explore/components/controls/FilterControl/AdhocFilter/index.ts:111
\`filter_\${Math.random().toString(36).substring(2, 15)}_\${Math.random().toString(36).substring(2, 15)}\`

// superset-frontend/src/utils/simpleFilterToAdhoc.ts:104
\`filter_\${Math.random().toString(36).substring(2, 15)}_\${Math.random().toString(36).substring(2, 15)}\`
\`\`\`

## Why this matters

**It is duplicated.** Three copies of one identifier scheme, in two different
subsystems, that must agree in shape but are not linked in any way.

**It is weaker than it looks.** \`Math.random().toString(36).substring(2, 15)\`
does not reliably yield 13 characters. A float whose base-36 expansion is short —
which happens whenever the random value has few significant digits, and always
for values like \`0.5\` — produces a much shorter slug, and the trailing
\`substring\` silently returns fewer characters rather than padding. So the real
entropy is variable and the worst case is far smaller than the nominal one.

These \`optionName\`/\`filterOptionName\` values are React keys and the identity
used to reconcile adhoc metrics and filters. A collision inside one chart shows
up as controls that duplicate, overwrite each other or fail to update — a bug
class that is intermittent and near-impossible to reproduce from a report.

\`crypto.randomUUID()\` is available in every browser Superset supports and in
jsdom, and removes the problem outright.

## Expected

Extract one shared helper and use it at all three sites.

\`\`\`autopilot
id: QUAL-001
category: code-quality
severity: medium
targets:
  - superset-frontend/src/explore/components/controls/MetricControl/AdhocMetric.ts:124
  - superset-frontend/src/explore/components/controls/FilterControl/AdhocFilter/index.ts:111
  - superset-frontend/src/utils/simpleFilterToAdhoc.ts:104
acceptance:
  - "A single exported helper generates these identifiers, in a new file under superset-frontend/src/utils/"
  - "The helper takes a prefix and returns a collision-resistant id, using crypto.randomUUID() where available with a documented fallback"
  - "All three call sites use the helper; no Math.random()-based id generation remains in them"
  - "Generated ids keep their existing 'metric_' and 'filter_' prefixes so anything matching on prefix keeps working"
  - "The helper has unit tests covering prefix correctness and uniqueness across many generations"
verify:
  - "cd superset-frontend && npx tsc --noEmit -p tsconfig.json"
  - "cd superset-frontend && npm run lint"
  - "! grep -rq 'Math.random().toString(36)' superset-frontend/src/explore/components/controls/MetricControl/AdhocMetric.ts superset-frontend/src/explore/components/controls/FilterControl/AdhocFilter/index.ts superset-frontend/src/utils/simpleFilterToAdhoc.ts"
notes: |
  Do not change the *shape* of consumers that read these ids. This is a
  generation-side fix only. Leave the unrelated Math.random() jitter in
  src/setup/setupClient.ts alone — that one is correct.
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  {
    key: 'DEP-001',
    title: 'Audit the `setuptools<81` ceiling: which dependencies still import `pkg_resources`?',
    labels: ['autopilot', 'dependencies', 'python'],
    body: `## Summary

\`requirements/base.in\` carries an upper bound with a stated expiry:

\`\`\`
# Pin setuptools <81 until all dependencies migrate from pkg_resources to importlib.metadata
# pkg_resources is deprecated and will be removed in setuptools 81+ (around 2025-11-30)
setuptools<81
\`\`\`

## Why this matters

An upper bound on \`setuptools\` is unusually costly: it is a build-time
dependency of a large part of the Python ecosystem, so the ceiling propagates
into every environment that installs Superset and can block otherwise unrelated
upgrades. The comment names a condition for lifting it — "until all dependencies
migrate" — but nobody has recorded *which* dependencies those are, so there is no
way to tell whether the condition is met without redoing the investigation.

That is the actual debt here: not the pin, but the missing evidence behind it.

This is deliberately scoped as an **audit, not an upgrade**. Removing the ceiling
blind would be reckless, and the useful output is the dependency-tree
investigation — tedious, mechanical, and exactly the kind of work worth handing
to an agent.

## Expected

Produce a written audit at \`docs/dependency-audit-setuptools.md\` that identifies
the actual \`pkg_resources\` consumers and makes a recommendation. Do **not**
change the pin in this PR.

\`\`\`autopilot
id: DEP-001
category: dependency
severity: medium
targets:
  - requirements/base.in:59
acceptance:
  - "A new file docs/dependency-audit-setuptools.md exists"
  - "It lists which installed distributions still import pkg_resources, with the evidence used to determine that (import graph, grep of site-packages, or upstream issue links)"
  - "For each, it records whether an importlib.metadata-based release exists and at what version"
  - "It states a clear recommendation: lift the pin now, lift with named minimum versions, or keep it, with reasoning"
  - "requirements/base.in is NOT modified in this PR"
verify:
  - "test -f docs/dependency-audit-setuptools.md"
  - "grep -qi 'pkg_resources' docs/dependency-audit-setuptools.md"
  - "grep -qi 'recommend' docs/dependency-audit-setuptools.md"
  - "git diff --name-only origin/master...HEAD | grep -qv 'requirements/base.in' || true"
  - "! git diff origin/master...HEAD -- requirements/base.in | grep -q '^[+-]setuptools'"
notes: |
  If the evidence is inconclusive, say so explicitly and recommend keeping the
  pin. A well-reasoned "not yet" is a successful outcome for this issue — do not
  manufacture a confident answer the evidence does not support.
\`\`\`
`,
  },

  // -------------------------------------------------------------------------
  {
    key: 'QUAL-002',
    title: 'Replace `@ts-ignore` with `@ts-expect-error` in ChartContextMenu tests',
    labels: ['autopilot', 'code-quality', 'frontend', 'good first issue'],
    body: `## Summary

The only two \`@ts-ignore\` comments left in \`superset-frontend/src\` are both in
one test file:

\`\`\`
superset-frontend/src/components/Chart/ChartContextMenu/ChartContextMenu.test.tsx:94
superset-frontend/src/components/Chart/ChartContextMenu/ChartContextMenu.test.tsx:113
\`\`\`

## Why this matters

\`@ts-ignore\` suppresses an error unconditionally and stays silent once the
underlying problem is fixed, so the suppression outlives its reason and quietly
rots. \`@ts-expect-error\` inverts that: if the line stops erroring, the compiler
flags the *suppression* as unnecessary, and it gets cleaned up on the spot.

Small, but it is the whole remaining population in \`src\` — closing it out means
a lint rule can enforce the invariant from here on instead of letting it drift
back.

## Expected

Swap both, or delete them if the underlying type error no longer exists.

\`\`\`autopilot
id: QUAL-002
category: code-quality
severity: low
targets:
  - superset-frontend/src/components/Chart/ChartContextMenu/ChartContextMenu.test.tsx:94
  - superset-frontend/src/components/Chart/ChartContextMenu/ChartContextMenu.test.tsx:113
acceptance:
  - "Both @ts-ignore comments are replaced with @ts-expect-error, or removed entirely if the line no longer produces a type error"
  - "Each retained suppression carries a short comment explaining what is being suppressed and why"
  - "The test file still type-checks and its tests still pass"
verify:
  - "! grep -q '@ts-ignore' superset-frontend/src/components/Chart/ChartContextMenu/ChartContextMenu.test.tsx"
  - "cd superset-frontend && npx tsc --noEmit -p tsconfig.json"
  - "cd superset-frontend && npx jest src/components/Chart/ChartContextMenu --silent"
notes: |
  If a suppression turns out to be unnecessary, prefer deleting it over
  converting it — @ts-expect-error on a non-erroring line is itself a compile
  error.
\`\`\`
`,
  },
];
