import { Octokit } from '@octokit/rest';
import { parseContract } from '../src/core/contract.js';
import { SEED_ISSUES } from './issues.js';

/**
 * Seeds the remediation backlog into the target repository.
 *
 * Before touching GitHub it parses every contract with the *same* parser the
 * orchestrator uses. A seeded issue Autopilot would later reject is a silent
 * dead end, so this fails fast and loudly instead.
 *
 *   npm run seed -- --dry-run     validate only, no writes
 *   npm run seed                  create labels and issues
 */

const owner = process.env.GITHUB_OWNER ?? 'watilde';
const repo = process.env.GITHUB_REPO ?? 'superset';
const token = process.env.GITHUB_TOKEN;
const dryRun = process.argv.includes('--dry-run');

const LABELS: Array<{ name: string; color: string; description: string }> = [
  { name: 'autopilot', color: '1d76db', description: 'Eligible for automated remediation by Autopilot' },
  { name: 'security', color: 'd93f0b', description: 'Security-relevant defect' },
  { name: 'dependencies', color: '0366d6', description: 'Dependency maintenance' },
  { name: 'code-quality', color: 'fbca04', description: 'Maintainability and correctness cleanup' },
  { name: 'python', color: '306998', description: 'Python backend' },
  { name: 'frontend', color: '61dafb', description: 'TypeScript / React frontend' },
];

function validateAll(): void {
  let bad = 0;
  for (const issue of SEED_ISSUES) {
    const parsed = parseContract(issue.body);
    if (!parsed.ok) {
      console.error(`  ✗ ${issue.key}: ${parsed.reason}`);
      bad++;
      continue;
    }
    if (parsed.contract.id !== issue.key) {
      console.error(`  ✗ ${issue.key}: contract id is "${parsed.contract.id}"`);
      bad++;
      continue;
    }
    const c = parsed.contract;
    console.log(
      `  ✓ ${c.id.padEnd(9)} ${c.category.padEnd(13)} ${c.severity.padEnd(8)} ` +
        `${c.targets.length} target(s), ${c.acceptance.length} criteria, ${c.verify.length} checks`,
    );
  }
  if (bad > 0) {
    console.error(`\n${bad} contract(s) invalid — fix before seeding.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  console.log(`\nAutopilot issue seeder → ${owner}/${repo}\n`);
  console.log('Validating remediation contracts:');
  validateAll();

  if (dryRun) {
    console.log('\n--dry-run: no GitHub writes performed.\n');
    return;
  }
  if (!token) {
    console.error('\nGITHUB_TOKEN is required to seed (or pass --dry-run).\n');
    process.exit(1);
  }

  const gh = new Octokit({ auth: token });

  console.log('\nEnsuring labels:');
  for (const label of LABELS) {
    try {
      await gh.issues.createLabel({ owner, repo, ...label });
      console.log(`  + ${label.name}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 422) console.log(`  = ${label.name} (exists)`);
      else console.warn(`  ! ${label.name}: ${(err as Error).message}`);
    }
  }

  // Re-running the seeder is normal (a fresh fork, a reset demo), so match on
  // title and skip rather than piling up duplicates.
  const { data: existing } = await gh.issues.listForRepo({
    owner,
    repo,
    state: 'all',
    per_page: 100,
  });
  const seen = new Map(existing.map((i) => [i.title, i.number]));

  console.log('\nCreating issues:');
  const created: Array<{ key: string; number: number; url: string }> = [];

  for (const issue of SEED_ISSUES) {
    const already = seen.get(issue.title);
    if (already) {
      console.log(`  = ${issue.key} → #${already} (exists)`);
      created.push({
        key: issue.key,
        number: already,
        url: `https://github.com/${owner}/${repo}/issues/${already}`,
      });
      continue;
    }
    const { data } = await gh.issues.create({
      owner,
      repo,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    });
    console.log(`  + ${issue.key} → #${data.number}`);
    created.push({ key: issue.key, number: data.number, url: data.html_url });
  }

  console.log('\nSeeded backlog:');
  for (const c of created) console.log(`  ${c.key.padEnd(9)} ${c.url}`);
  console.log(
    `\nAutopilot will pick these up on the next scan, on webhook delivery, or via\n` +
      `  curl -X POST localhost:8080/api/trigger -H 'content-type: application/json' \\\n` +
      `       -d '{"issueNumber": ${created[0]?.number ?? 1}}'\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
