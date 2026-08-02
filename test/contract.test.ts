import { describe, expect, it } from 'vitest';
import { branchFor, extractContractBlock, parseContract } from '../src/core/contract.js';
import { buildPrompt } from '../src/core/prompt.js';
import { SEED_ISSUES } from '../scripts/issues.js';

const VALID = `Some prose describing the bug.

\`\`\`autopilot
id: SEC-001
category: security
severity: high
targets:
  - superset/examples/utils.py:261
acceptance:
  - "use yaml.safe_load"
verify:
  - "ruff check superset/examples/utils.py"
\`\`\`

More prose.`;

describe('contract parsing', () => {
  it('extracts and parses a well-formed contract', () => {
    const result = parseContract(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.contract.id).toBe('SEC-001');
    expect(result.contract.category).toBe('security');
    expect(result.contract.targets).toEqual(['superset/examples/utils.py:261']);
  });

  it('ignores surrounding prose', () => {
    expect(extractContractBlock(VALID)?.trim().startsWith('id:')).toBe(true);
  });

  // The refusal cases matter more than the happy path: this parser is the gate
  // that stops an autonomous agent being pointed at an under-specified task.
  it('rejects a body with no contract block', () => {
    const r = parseContract('just a normal issue, please fix it');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no ```autopilot contract block/);
  });

  it('rejects a null body', () => {
    expect(parseContract(null).ok).toBe(false);
  });

  it('rejects a contract with no verification commands', () => {
    const r = parseContract('```autopilot\nid: SEC-001\ncategory: security\nseverity: high\ntargets:\n  - a.py\nacceptance:\n  - "x"\nverify: []\n```');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/verification command/);
  });

  it('rejects an unknown category', () => {
    const r = parseContract(VALID.replace('category: security', 'category: vibes'));
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed id', () => {
    const r = parseContract(VALID.replace('id: SEC-001', 'id: whatever'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SEC-001/);
  });

  it('rejects invalid YAML', () => {
    const r = parseContract('```autopilot\nid: [unclosed\n```');
    expect(r.ok).toBe(false);
  });
});

describe('seeded backlog', () => {
  // Guards the seeder against drift: an issue Autopilot cannot parse is an
  // issue that would sit labelled and untouched forever.
  it('every seeded issue carries a contract the orchestrator accepts', () => {
    for (const issue of SEED_ISSUES) {
      const r = parseContract(issue.body);
      expect(r.ok, `${issue.key}: ${r.ok ? '' : r.reason}`).toBe(true);
      if (r.ok) expect(r.contract.id).toBe(issue.key);
    }
  });

  it('covers more than one remediation category', () => {
    const cats = new Set(
      SEED_ISSUES.map((i) => {
        const r = parseContract(i.body);
        return r.ok ? r.contract.category : 'invalid';
      }),
    );
    expect(cats.size).toBeGreaterThan(1);
  });
});

describe('prompt construction', () => {
  const contract = (parseContract(VALID) as { ok: true; contract: never }).contract;

  const prompt = buildPrompt({
    owner: 'watilde',
    repo: 'superset',
    issueNumber: 42,
    issueTitle: 'Unsafe YAML load',
    issueUrl: 'https://github.com/watilde/superset/issues/42',
    contract,
  });

  it('names the repository, issue and branch', () => {
    expect(prompt).toContain('watilde/superset');
    expect(prompt).toContain('#42');
    expect(prompt).toContain(branchFor(contract, 42));
  });

  it('carries the verification commands through verbatim', () => {
    expect(prompt).toContain('ruff check superset/examples/utils.py');
  });

  it('tells Devin that finding no defect is an acceptable outcome', () => {
    expect(prompt).toContain('no_change_needed');
    expect(prompt.toLowerCase()).toContain('false positive');
  });

  it('bounds the scope of the change', () => {
    expect(prompt).toContain('Scope limits');
    expect(prompt).toContain('Closes #42');
  });
});
