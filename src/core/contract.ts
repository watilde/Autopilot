import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { RemediationContract } from '../types.js';

/**
 * Issues are the input to this system, and free-form prose is a bad input.
 *
 * Every issue Autopilot will act on carries a fenced ```autopilot block: a
 * small YAML document naming the defect, where it lives, what "fixed" means,
 * and the commands that prove it. Refusing to dispatch without one is the
 * single most important safety property here — it means a stray label on an
 * arbitrary issue cannot send an autonomous agent off to edit the codebase
 * against vague instructions.
 */

const contractSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[A-Z]+-\d+$/, 'id must look like SEC-001'),
  category: z.enum(['security', 'dependency', 'code-quality', 'reliability', 'other']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  targets: z.array(z.string().min(1)).min(1, 'at least one target file is required'),
  acceptance: z.array(z.string().min(1)).min(1, 'at least one acceptance criterion is required'),
  verify: z.array(z.string().min(1)).min(1, 'at least one verification command is required'),
  branch: z.string().min(1).optional(),
  notes: z.string().optional(),
});

export type ContractParseResult =
  | { ok: true; contract: RemediationContract }
  | { ok: false; reason: string };

const FENCE = /```autopilot\s*\n([\s\S]*?)```/;

export function extractContractBlock(issueBody: string | null | undefined): string | null {
  if (!issueBody) return null;
  const m = FENCE.exec(issueBody);
  return m && m[1] !== undefined ? m[1] : null;
}

export function parseContract(issueBody: string | null | undefined): ContractParseResult {
  const raw = extractContractBlock(issueBody);
  if (raw === null) {
    return { ok: false, reason: 'issue body has no ```autopilot contract block' };
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    return { ok: false, reason: `contract block is not valid YAML: ${(err as Error).message}` };
  }

  const parsed = contractSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, reason: `contract failed validation: ${detail}` };
  }

  return { ok: true, contract: parsed.data };
}

/** Branch name used when the contract does not specify one. */
export function branchFor(contract: RemediationContract, issueNumber: number): string {
  return contract.branch ?? `autopilot/${contract.id.toLowerCase()}-issue-${issueNumber}`;
}
