#!/usr/bin/env node
// auto/answers-lint.mjs — lint standing-answers.yml for common defects
// Exit 1 on findings, print file:key for each issue

import { readFileSync, existsSync } from 'fs';
import { load } from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Questions that indicate free-text answers (lowercased, trimmed)
const FREE_TEXT_TRIGGER_WORDS = ['what', 'describe', 'why', 'how', 'pace', 'tell us'];

// ISO date pattern: YYYY-MM-DD (not at the start to avoid matching user-confirmed markers)
const ISO_DATE_PATTERN = /\b(20|21)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/;

function isFreeTextQuestion(text) {
  const lower = text.toLowerCase().trim();
  
  // Check if it starts with a yes/no pattern
  const yesNoStart = /^(are you|do you|have you|will you|are you at|is it|does it|did you|were you|would you|can you|could you|should you|if required, would you be|if required, are you|if required, do you|if you are|if you have|if you were|if you would)/;
  if (yesNoStart.test(lower)) {
    return false; // This is a yes/no question
  }
  
  // Check for free-text triggers
  for (const word of FREE_TEXT_TRIGGER_WORDS) {
    if (lower.includes(word)) {
      return true;
    }
  }
  
  return false;
}

function hasHardcodedDate(value) {
  // Check for ISO date patterns (YYYY-MM-DD)
  // Skip if it looks like a user-confirmed date marker (e.g., "2026-10-09")
  if (ISO_DATE_PATTERN.test(value)) {
    // Check if the date appears in a "user-confirmed" context
    // These are factual markers, not answers that need to update
    if (value.includes('user-confirmed')) {
      return false;
    }
    return true;
  }
  
  return false;
}

function isBooleanAnswer(value) {
  const lower = value.toLowerCase().trim();
  return lower === 'yes' || lower === 'no' || lower === 'true' || lower === 'false';
}

function lintFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  let doc;
  try {
    doc = load(content);
  } catch (err) {
    console.error(`Error: Failed to parse YAML: ${err.message}`);
    process.exit(1);
  }

  const issues = [];
  const custom = doc?.custom;

  if (!custom || typeof custom !== 'object') {
    console.error('Error: No "custom" map found in YAML');
    process.exit(1);
  }

  for (const [key, value] of Object.entries(custom)) {
    const trimmedKey = key.trim();
    const trimmedValue = String(value ?? '').trim();

    // Check 3: Empty answers
    if (trimmedValue === '') {
      issues.push({ file: filePath, key: trimmedKey, type: 'empty' });
      continue;
    }

    // Check 1: Boolean answers on free-text questions
    if (isBooleanAnswer(trimmedValue) && isFreeTextQuestion(trimmedKey)) {
      issues.push({ file: filePath, key: trimmedKey, type: 'boolean-on-freetext', value: trimmedValue });
      continue;
    }

    // Check 2: Hardcoded dates in answers
    if (hasHardcodedDate(trimmedValue)) {
      issues.push({ file: filePath, key: trimmedKey, type: 'hardcoded-date', value: trimmedValue });
    }
  }

  return issues;
}

// Main
const dataRoot = process.cwd();
const standingAnswersPath = join(dataRoot, 'config', 'standing-answers.yml');

const issues = lintFile(standingAnswersPath);

if (issues.length > 0) {
  for (const issue of issues) {
    console.log(`${issue.file}:${issue.key}`);
    if (issue.type === 'boolean-on-freetext') {
      console.error(`  [ERROR] Boolean answer "${issue.value}" on free-text question`);
    } else if (issue.type === 'hardcoded-date') {
      console.error(`  [WARN] Hardcoded date found (may need dynamic generation)`);
    } else if (issue.type === 'empty') {
      console.error(`  [ERROR] Empty answer value`);
    }
  }
  process.exit(1);
}

console.log('No issues found. standing-answers.yml is clean.');
process.exit(0);
