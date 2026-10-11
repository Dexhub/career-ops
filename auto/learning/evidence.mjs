// auto/learning/evidence.mjs — audit-answer normalization (T04, CONTRACTS E).
// Pure functions only; nothing executes at import time; no filesystem access.
//
// normalizeAuditAnswers(input) -> { entries, rejected }
//   entry    = { fieldId, label, value, source, section }
//   rejected = { pointer, reason }   (JSON-pointer-ish source pointer; the
//                                     reason NEVER contains an answer value)
//
// Supported historical representations (inventoried 2026-10-11 from
// output/*/audit/attempt-*/answers.json, keys only — no personal values):
//   (a) arrays of labeled rows        [{label, value, source, section|step?}]
//   (b) section objects of rows       {Section: [{label, value, source}]}
//   (c) keyed section/value objects   {Section: {Label: {value, source}}}
//       including the observed flat variant {Section: {Label: scalar}} and
//       top-level scalar fields {label: scalar}.
//
// Rules (plan T04): unknown/missing source -> 'unverified', never
// 'user_confirmed'; ambiguous nested objects are rejected with a reason and
// pointer, never recursively guessed; secret-bearing keys/labels are rejected
// using the same pattern as contracts.mjs and their values never leak through
// rejection messages. Shape normalization here is NOT answer-reuse
// authorization — that stays a separate learning-layer decision (CONTRACTS D3).

import { isSecretKey } from './contracts.mjs';

const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isScalarArray(value) {
  return Array.isArray(value) && value.every(isScalar);
}

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'field';
}

/** Unknown/absent source labels become 'unverified' — never 'user_confirmed'. */
function normalizeSource(raw) {
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return 'unverified';
}

function makeEntry({ section, label, value, source, fieldId }) {
  const sec = typeof section === 'string' && section.length > 0 ? section : null;
  return {
    fieldId: typeof fieldId === 'string' && fieldId.length > 0
      ? fieldId
      : (sec ? `${slugify(sec)}.${slugify(label)}` : slugify(label)),
    label,
    value: value === undefined ? null : value,
    source: normalizeSource(source),
    section: sec,
  };
}

/** Returns a rejection reason for a forbidden key name, or null. Key NAME only. */
function forbiddenKeyReason(key) {
  if (PROTO_KEYS.has(key)) return `prototype-related key "${key}" rejected`;
  if (isSecretKey(key)) return `secret-bearing key "${key}" rejected (value withheld)`;
  return null;
}

/** One labeled answer row from an array representation. */
function normalizeRow(row, pointer, sectionDefault, entries, rejected) {
  if (!isPlainObject(row)) {
    rejected.push({ pointer, reason: 'answer row is not a plain object' });
    return;
  }
  for (const key of Object.keys(row)) {
    const reason = forbiddenKeyReason(key);
    if (reason) { rejected.push({ pointer, reason }); return; }
  }
  const label = row.label;
  if (typeof label !== 'string' || label.length === 0) {
    rejected.push({ pointer, reason: 'answer row has no string label' });
    return;
  }
  const labelReason = forbiddenKeyReason(label);
  if (labelReason) { rejected.push({ pointer, reason: labelReason }); return; }
  const value = 'value' in row ? row.value : null;
  if (!isScalar(value) && !isScalarArray(value)) {
    rejected.push({ pointer, reason: `non-scalar value for label "${label}" (value withheld)` });
    return;
  }
  const section = typeof row.section === 'string' && row.section
    ? row.section
    : (typeof row.step === 'string' && row.step ? row.step : sectionDefault);
  entries.push(makeEntry({ section, label, value, source: row.source, fieldId: row.fieldId }));
}

/** Keyed section object: {Label: scalar} or {Label: {value, source}}. */
function normalizeKeyedSection(obj, pointer, section, entries, rejected) {
  for (const label of Object.keys(obj)) {
    const childPointer = `${pointer}.${label}`;
    const keyReason = forbiddenKeyReason(label);
    if (keyReason) { rejected.push({ pointer: childPointer, reason: keyReason }); continue; }
    const v = obj[label];
    if (isScalar(v) || isScalarArray(v)) {
      entries.push(makeEntry({ section, label, value: v }));
      continue;
    }
    if (isPlainObject(v)) {
      if (!Object.prototype.hasOwnProperty.call(v, 'value')) {
        rejected.push({
          pointer: childPointer,
          reason: 'ambiguous nested object (no "value" key); not recursively guessed',
        });
        continue;
      }
      let bad = null;
      for (const key of Object.keys(v)) {
        bad = forbiddenKeyReason(key);
        if (bad) break;
      }
      if (bad) { rejected.push({ pointer: childPointer, reason: bad }); continue; }
      if (!isScalar(v.value) && !isScalarArray(v.value)) {
        rejected.push({ pointer: childPointer, reason: 'non-scalar "value" (value withheld)' });
        continue;
      }
      entries.push(makeEntry({ section, label, value: v.value, source: v.source }));
      continue;
    }
    rejected.push({ pointer: childPointer, reason: 'unsupported value shape; not guessed' });
  }
}

/**
 * normalizeAuditAnswers(input) -> {entries, rejected} (CONTRACTS E / T04).
 * Pure; never throws on untrusted shapes. Unknown shapes are rejected with a
 * source pointer, not recursively guessed; a generic string object is never
 * parsed as a credential or an approved personal fact.
 */
export function normalizeAuditAnswers(input) {
  const entries = [];
  const rejected = [];

  if (Array.isArray(input)) {
    input.forEach((row, i) => normalizeRow(row, `$[${i}]`, null, entries, rejected));
    return { entries, rejected };
  }

  if (isPlainObject(input)) {
    for (const key of Object.keys(input)) {
      const pointer = `$.${key}`;
      const keyReason = forbiddenKeyReason(key);
      if (keyReason) { rejected.push({ pointer, reason: keyReason }); continue; }
      const v = input[key];
      if (isScalar(v)) {
        // Observed flat variant: a top-level labeled scalar field.
        entries.push(makeEntry({ section: null, label: key, value: v }));
        continue;
      }
      if (Array.isArray(v)) {
        // Section object containing labeled rows (an empty section is no data).
        v.forEach((row, i) => normalizeRow(row, `${pointer}[${i}]`, key, entries, rejected));
        continue;
      }
      if (isPlainObject(v)) {
        normalizeKeyedSection(v, pointer, key, entries, rejected);
        continue;
      }
      rejected.push({ pointer, reason: `unsupported value shape under "${key}"; not guessed` });
    }
    return { entries, rejected };
  }

  rejected.push({
    pointer: '$',
    reason: `unsupported answers shape (${input === null ? 'null' : typeof input}); expected an array or object`,
  });
  return { entries, rejected };
}
