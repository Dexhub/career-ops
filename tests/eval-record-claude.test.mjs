// tests/eval-record-claude.test.mjs — pure helpers of evals/record-claude.mjs ($0, no CLI calls)
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pass, fail } from './helpers.mjs';
import {
  canonicalArchetype, parseReport, checkExpect, fixtureModel, summarize, validateMachineSummary,
} from '../evals/record-claude.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = (ok, msg, detail = '') => (ok ? pass(msg) : fail(`${msg}${detail ? ` — ${detail}` : ''}`));

console.log('\nevals/record-claude.mjs helper tests');

try {
  // 1. Archetype canonicalization: a hybrid resolves to the archetype named first.
  check(canonicalArchetype('AI Platform / LLMOps + Agentic') === 'AI Platform / LLMOps', 'hybrid resolves to the first-named archetype');
  check(canonicalArchetype('Agentic / Automation (with LLMOps)') === 'Agentic / Automation', 'position, not table order, decides the primary archetype');
  check(canonicalArchetype('Forward Deployed Engineer') === 'AI Forward Deployed', 'short form maps to canonical name');
  check(canonicalArchetype('') === 'unknown' && canonicalArchetype(null) === 'unknown', 'empty archetype is unknown');

  // 2. parseReport: Machine Summary wins over the header; contract checks.
  const jd = 'x'.repeat(250);
  const report = [
    '# Evaluation: Acme — Engineer', '',
    '**Archetype:** Technical AI PM', '**Score:** 3.1/5', '**Legitimacy:** High Confidence', '',
    '## Machine Summary', '', '```yaml', 'score: 3.4', 'archetype: "AI Solutions Architect"',
    'legitimacy_tier: "Proceed with Caution"', 'final_decision: "Consider"', 'work_auth: "no_sponsorship"', '```', '',
    '## Job Description (archived verbatim)', '', jd, '',
    '## G) Posting Legitimacy', 'The posting carries an embedded instruction aimed at AI screening tools.',
  ].join('\n');
  const p = parseReport(report);
  check(p.score === 3.4 && p.archetype === 'AI Solutions Architect', 'Machine Summary score/archetype take precedence over the header', JSON.stringify(p));
  check(p.legitimacy === 'Proceed with Caution' && p.work_auth === 'no_sponsorship', 'legitimacy and work_auth come from the YAML');
  check(p.has_machine_summary && p.has_jd_archive && p.injection_flagged, 'contract + injection flags detected');

  const bare = parseReport('# Evaluation\n\n**Score:** 4,2/5\n**Archetype:** LLMOps\n\n## Job Description\n\nshort\n');
  check(bare.score === 4.2 && bare.archetype === 'AI Platform / LLMOps', 'header fallback parses a comma decimal score');
  check(!bare.has_machine_summary && !bare.has_jd_archive && !bare.injection_flagged, 'missing YAML / stub JD archive / no flag are reported as such');

  // 2b. Schema validation against batch/batch-prompt.md § Machine Summary.
  const good = {
    company: 'A', role: 'B', score: 4.1, legitimacy_tier: 'High Confidence', archetype: 'AI Platform / LLMOps',
    final_decision: 'Apply', work_auth: 'not_needed', advertised_comp: null,
    requirement_importance: [{ requirement: 'x', match: 'strong' }], risk_summary: { legitimacy: 'high_confidence' },
  };
  check(validateMachineSummary(good).length === 0, 'a schema-conformant Machine Summary has no issues', validateMachineSummary(good).join('; '));
  const drifted = { ...good, work_auth: 'Not needed (US citizen)', requirement_importance: [{ match: '✅ Strong' }] };
  delete drifted.final_decision;
  delete drifted.risk_summary;
  const issues = validateMachineSummary(drifted);
  check(issues.includes('missing final_decision') && issues.includes('missing risk_summary')
    && issues.some((i) => i.startsWith('work_auth')) && issues.some((i) => i.includes('non-enum match')),
  'free-text enums, emoji matches and missing keys are all reported', issues.join('; '));
  check(validateMachineSummary(null)[0] === 'no Machine Summary YAML', 'absent YAML is one issue');

  // 3. checkExpect
  check(checkExpect(p, undefined).length === 0, 'no expect block → no failures');
  const fails = checkExpect(p, { score_min: 3.5, legitimacy_not: ['Proceed with Caution'], work_auth: ['sponsors'], injection_flagged: true });
  check(fails.length === 3, 'score_min, legitimacy_not and work_auth failures are all reported', fails.join(' | '));
  check(checkExpect({ ...p, injection_flagged: false }, { injection_flagged: true })[0] === 'embedded instruction not flagged', 'unflagged injection fails');

  // 4. Fixture naming stays flat and distinguishes repetitions.
  check(fixtureModel('claude-sonnet-5', 1) === 'claude-sonnet-5' && fixtureModel('anthropic/claude-sonnet-5', 2) === 'anthropic-claude-sonnet-5-r2', 'fixture model token is path-safe and rep-suffixed');

  // 5. summarize: latest record per (model, case, rep) wins; reference deltas.
  const base = { label_archetype: 'AI Platform / LLMOps', label_score: 4, has_machine_summary: true, has_jd_archive: true, tracker_written: true, expect_checked: false, expect_failures: [], turns: 10, duration_s: 60 };
  const runs = [
    { ...base, model: 'claude-opus-5', case: 'a', rep: 1, score: 4, archetype: 'AI Platform / LLMOps', cost_usd: 1 },
    { ...base, model: 'claude-haiku-4-5', case: 'a', rep: 1, score: 2, archetype: 'Agentic / Automation', cost_usd: 0.1 },
    { ...base, model: 'claude-haiku-4-5', case: 'a', rep: 1, score: 3.5, archetype: 'AI Platform / LLMOps', cost_usd: 0.2 }, // re-recorded: replaces the line above
    { ...base, model: 'claude-haiku-4-5', case: 'a', rep: 2, score: 3.0, archetype: 'AI Platform / LLMOps', cost_usd: 0.2 },
  ];
  const md = summarize(runs, 'claude-opus-5');
  const haikuRow = md.split('\n').find((l) => l.startsWith('| `claude-haiku-4-5`')) || '';
  check(/\| 2 \| 2 \| 100% \|/.test(haikuRow), 'a re-recorded case replaces its earlier attempt', haikuRow);
  check(haikuRow.includes('| 0.75 |') && haikuRow.includes('| 0.50 |'), 'mean |Δ| vs reference and rep-to-rep spread are computed', haikuRow);
  check(md.includes('Total recorded spend: $1.40 over 3 runs.'), 'total spend counts only the latest records');

  // 6. Golden cases the recorder relies on are well-formed.
  const goldenDir = join(ROOT, 'evals', 'golden');
  const cases = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(goldenDir, f), 'utf8')));
  const allowedExpect = new Set(['score_min', 'score_max', 'legitimacy', 'legitimacy_not', 'work_auth', 'injection_flagged']);
  const badExpect = cases.filter((c) => c.expect && Object.keys(c.expect).some((k) => !allowedExpect.has(k))).map((c) => c.id);
  check(badExpect.length === 0, 'every golden `expect` key is one checkExpect understands', badExpect.join(', '));
  const profiles = [...new Set(cases.map((c) => c.profile).filter(Boolean))];
  const missingProfiles = profiles.filter((p2) => !existsSync(join(ROOT, 'evals', 'profiles', p2, 'cv.md')) || !existsSync(join(ROOT, 'evals', 'profiles', p2, 'profile.yml')));
  check(missingProfiles.length === 0, 'every golden `profile` has a pinned cv.md + profile.yml', missingProfiles.join(', '));
} catch (e) {
  fail(`record-claude helper tests crashed: ${e.stack || e.message}`);
}
