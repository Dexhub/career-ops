#!/usr/bin/env node

/**
 * reply-watch.mjs — Classify employer replies and generate a review digest (RFC #1585).
 *
 * Reads candidate replies from a JSON file, matches them against the application tracker,
 * classifies the reply types (e.g. Interview, Rejected, Noise), and prints a concise
 * review digest. Prompts the user to approve recommended tracker status updates.
 *
 * Usage:
 *   node reply-watch.mjs [path/to/candidates.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { matchCandidates, classifyReply } from './reply-matcher.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { validateFlags } from './lib/cli-flags.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import * as db from './core/db.mjs';

// Every file here is user layer, so it resolves against the data root
// (CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / .career-ops-data marker), never the
// script's own directory — which is only the default when none is configured.
const DATA_ROOT = getCareerOpsRoot();
export const DEFAULT_CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(DATA_ROOT, 'data', 'reply-candidates.json');
// The tracker now lives in the SQLite database (CAREER_OPS_DB override).
export const APPS_FILE = db.resolveDbPath();
// Retired markdown follow-ups path. Nothing here reads it anymore (follow-ups
// come from the follow_ups table); exported for path-resolution tests only.
export const FOLLOWUPS_FILE = path.join(DATA_ROOT, 'data', 'follow-ups.md');

// Helper to ask a question in the CLI
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (ans) => {
    rl.close();
    resolve(ans);
  }));
}

// Generate custom signal description based on keywords
function getSignalDesc(text, signal) {
  const parts = [];
  if (text.includes('简历通过')) {
    parts.push('resume passed');
  }
  if (text.includes('微信小程序') || text.includes('WeChat mini-program') || text.includes('AI微信小程序')) {
    parts.push('AI WeChat mini-program interview');
  }
  if (parts.length > 0) {
    return parts.join(' + ');
  }
  return signal || 'none';
}

// Create a default set of mock candidates if the file doesn't exist
function ensureCandidatesFile(filePath) {
  if (fs.existsSync(filePath)) return;

  const mockCandidates = [
    {
      message_id: 'msg1',
      from: 'recruiter@wingyun.com',
      subject: '恭喜简历通过，杭州赢云贸易有限公司邀您面试',
      body_snippet: '您的首轮面试是AI微信小程序面试。面试形式：AI微信小程序面试，面试时长：约15~30分钟',
      signal: 'interview_invite'
    },
    {
      message_id: 'msg2',
      from: 'hr@examplelabs.com',
      subject: 'Update on your application for Full-stack Engineer',
      body_snippet: '很遗憾地通知您，您的简历与我们当前岗位的需求暂不匹配，不合适我司的要求，未能进入下一轮。',
      signal: 'rejection'
    },
    {
      message_id: 'msg3',
      from: 'alerts@zhaopin.com',
      subject: 'Zhaopin job alert',
      body_snippet: '我们为您推荐了以下职位：邀请投递测试工程师岗位，现在沟通，抢面试先机！近期热招职位，立即投递！',
      signal: null
    },
    {
      message_id: 'msg4',
      from: 'hr@somecompany.com',
      subject: '补充信息',
      body_snippet: '邀请您在面试/入职之前更新或补充最新的应聘信息。',
      signal: null
    }
  ];

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(mockCandidates, null, 2), 'utf-8');
  console.log(`Created default mock candidates file at ${filePath}`);
}

// Load applications tracker rows
function loadTrackerApps() {
  if (!fs.existsSync(APPS_FILE)) {
    return [];
  }
  return db.listApplications();
}

// Load followups history (same row shape the markdown parser produced)
function loadFollowups() {
  if (!fs.existsSync(APPS_FILE)) {
    return [];
  }
  return db.listFollowUps().map(row => ({
    num: row.num,
    appNum: row.app_num,
    date: row.date,
    company: row.company,
    role: row.role,
    channel: row.channel,
    contact: row.contact,
    notes: row.notes || '',
  }));
}

// Apply an approved batch in one DB transaction. Re-reading each row inside
// the transaction matters because the review prompt can remain open while
// another process merges or updates tracker rows.
function groupStatusRecommendations(recommendations) {
  const byApplication = new Map();
  for (const recommendation of recommendations) {
    if (!byApplication.has(recommendation.num)) byApplication.set(recommendation.num, new Map());
    const transitions = byApplication.get(recommendation.num);
    const key = `${recommendation.oldStatus}\0${recommendation.newStatus}`;
    const existing = transitions.get(key);
    if (existing) {
      existing.count++;
    } else {
      transitions.set(key, { ...recommendation, count: 1 });
    }
  }

  const updates = [];
  const conflicts = [];
  for (const [num, transitions] of byApplication) {
    const choices = [...transitions.values()];
    if (choices.length === 1) updates.push(choices[0]);
    else conflicts.push({ num, choices });
  }
  return { updates, conflicts };
}

async function updateTrackerStatuses(updates, onApplied = null) {
  const grouped = groupStatusRecommendations(updates);
  const updatesByNum = new Map(grouped.updates.map(update => [update.num, update]));
  const applied = new Set();
  const alreadyCurrent = new Set();
  const conflicts = new Map();
  const missing = new Set(updatesByNum.keys());

  db.tx(() => {
    for (const [num, update] of updatesByNum) {
      const row = db.getApplication(num);
      if (!row) continue; // stays in `missing`
      missing.delete(num);
      if (row.status === update.newStatus) {
        alreadyCurrent.add(num);
        continue;
      }
      if (row.status !== update.oldStatus) {
        conflicts.set(num, row.status);
        continue;
      }
      db.updateApplication(num, { status: update.newStatus });
      applied.add(num);
    }
    // Inside the transaction so the status-event rows commit atomically with
    // the status writes they describe — the same guarantee the markdown era
    // got from running the log append before the locked file was closed.
    if (applied.size > 0 && onApplied) onApplied(applied, updatesByNum);
  });

  return { applied, alreadyCurrent, conflicts, missing, recommendationConflicts: grouped.conflicts };
}

const KNOWN_FLAGS = ['--help', '-h'];
const USAGE = 'Usage: node reply-watch.mjs [path/to/candidates.json]';

async function main() {
  const args = process.argv.slice(2);

  const positional = args.filter(a => !a.startsWith('-'));
  validateFlags(args, KNOWN_FLAGS, USAGE);

  const candidatesPath = positional[0] || DEFAULT_CANDIDATES_PATH;
  ensureCandidatesFile(candidatesPath);

  if (!fs.existsSync(candidatesPath)) {
    console.error(`Error: candidates file not found at ${candidatesPath}`);
    process.exit(1);
  }

  let candidates;
  try {
    candidates = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
  } catch (e) {
    console.error(`Error parsing candidates JSON: ${e.message}`);
    process.exit(1);
  }

  const apps = loadTrackerApps();
  const followups = loadFollowups();

  const matched = matchCandidates(candidates, apps, followups);

  console.log(`\nToday: ${candidates.length} application updates need review\n`);

  const recommendations = [];

  matched.forEach((match, index) => {
    const cand = candidates.find(c => c.message_id === match.message_id);
    const classification = classifyReply(cand);

    let headerStr = '';
    if (match.application_num !== null) {
      const app = apps.find(a => a.num === match.application_num);
      headerStr = `${app.company} — ${app.role}`;
    } else {
      headerStr = cand.subject || match.company_hint || cand.from || 'Unknown';
    }

    console.log(`${index + 1}. ${headerStr}`);
    console.log(`   Type: ${classification.type}`);

    // Print Signal for Interview classification when meaningful
    const signalDesc = getSignalDesc(cand.subject + ' ' + cand.body_snippet, cand.signal);
    if (classification.type === 'Interview' && signalDesc && signalDesc !== 'none') {
      console.log(`   Signal: ${signalDesc}`);
    }

    if (classification.evidence && classification.evidence.length > 0) {
      console.log(`   Evidence: ${classification.evidence.join('; ')}`);
    }

    console.log(`   Suggested tracker update: ${classification.suggestedTrackerUpdate}`);
    console.log('');

    if (match.application_num !== null && classification.suggestedTrackerUpdate !== 'none' && classification.suggestedTrackerUpdate !== 'Needs Review') {
      const app = apps.find(a => a.num === match.application_num);
      if (app && app.status !== classification.suggestedTrackerUpdate) {
        recommendations.push({
          num: app.num,
          company: app.company,
          role: app.role,
          oldStatus: app.status,
          newStatus: classification.suggestedTrackerUpdate
        });
      }
    }
  });

  const groupedRecommendations = groupStatusRecommendations(recommendations);
  if (groupedRecommendations.conflicts.length > 0) {
    console.warn('Conflicting status recommendations require manual review:');
    for (const conflict of groupedRecommendations.conflicts) {
      const summary = conflict.choices
        .map(choice => `${choice.newStatus} (${choice.count} ${choice.count === 1 ? 'reply' : 'replies'})`)
        .join(' vs ');
      console.warn(`  #${conflict.num}: ${summary} — no automatic update`);
    }
    console.log('');
  }

  if (groupedRecommendations.updates.length > 0) {
    const updates = groupedRecommendations.updates;
    console.log('Suggested status updates to apply:');
    updates.forEach(r => {
      const count = r.count > 1 ? ` (${r.count} replies)` : '';
      console.log(`  #${r.num} ${r.company} (${r.role}): ${r.oldStatus} → ${r.newStatus}${count}`);
    });
    console.log('');

    const answer = await askQuestion(`Apply recommended status updates to ${APPS_FILE}? (y/N): `);
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      const todayStr = localToday();

      const result = await updateTrackerStatuses(updates, (applied, updatesByNum) => {
        for (const num of applied) {
          const u = updatesByNum.get(num);
          if (u) {
            try {
              db.appendStatusEvent({
                appNum: num,
                eventDate: todayStr,
                fromStatus: u.oldStatus,
                toStatus: u.newStatus,
                source: 'reply-watch',
                note: '',
              });
            } catch (err) {
              console.warn(`Warning: failed to record status event for #${num}: ${err.message}`);
            }
          }
        }
      });
      for (const r of updates) {
        const count = r.count > 1 ? ` (${r.count} replies)` : '';
        if (result.applied.has(r.num)) {
          console.log(`Updated #${r.num} to ${r.newStatus}${count}`);
        } else if (result.alreadyCurrent.has(r.num)) {
          console.log(`No change for #${r.num}: already ${r.newStatus}${count}`);
        } else if (result.conflicts.has(r.num)) {
          console.warn(`Skipped #${r.num}: status changed from ${r.oldStatus} to ${result.conflicts.get(r.num)} during review`);
        } else if (result.missing.has(r.num)) {
          console.warn(`Skipped #${r.num}: row no longer exists in the tracker`);
        }
      }
      console.log('\n✅ Tracker review complete');
    } else {
      console.log('Updates skipped.');
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
