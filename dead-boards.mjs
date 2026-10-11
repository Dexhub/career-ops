// Persistent board-existence memory for reverse ATS sweeps (#2840).
// Only a real HTTP 404 may advance a miss counter. Throttles, transport
// failures and DNS errors mean "unknown", never "dead".
//
// Storage moved from data/dead-boards.tsv to the dead_boards table in
// data/career-ops.db (core/db.mjs). loadDeadBoards/saveDeadBoards keep their
// file-path parameter for signature compatibility with scan-ats-full.mjs, but
// the path is ignored — the db is the single source of truth.

import * as db from './core/db.mjs';

export const DEAD_BOARD_MISSES = 3;
export const DEAD_BOARD_RECHECK_DAYS = 30;

function key(ats, board) { return `${ats}\t${board}`; }

export function loadDeadBoards(_file, now = Date.now()) {
  const rows = new Map();
  for (const r of db.listDeadBoards()) {
    const misses = Number(r.misses);
    const lastChecked = Date.parse(r.last_checked || '');
    if (!r.ats || !r.board || !Number.isInteger(misses) || misses < 1 || !Number.isFinite(lastChecked)) continue;
    rows.set(key(r.ats, r.board), { ats: r.ats, board: r.board, misses, lastChecked, now });
  }
  return rows;
}

export function boardKey(entry) {
  return String(entry?.careers_url || entry?.name || '').trim();
}

export function shouldSkipDeadBoard(rows, ats, board, now = Date.now()) {
  const row = rows.get(key(ats, board));
  return Boolean(row && row.misses >= DEAD_BOARD_MISSES && now - row.lastChecked < DEAD_BOARD_RECHECK_DAYS * 86_400_000);
}

export function recordBoardResult(rows, ats, board, status, now = Date.now()) {
  const rowKey = key(ats, board);
  if (status === 200) {
    rows.delete(rowKey);
    return;
  }
  const previous = rows.get(rowKey);
  if (status !== 404) {
    if (!previous || previous.misses < DEAD_BOARD_MISSES) {
      rows.delete(rowKey);
    } else {
      rows.set(rowKey, { ...previous, lastChecked: now });
    }
    return;
  }
  const misses = Math.min(DEAD_BOARD_MISSES, (previous?.misses || 0) + 1);
  rows.set(rowKey, { ats, board, misses, lastChecked: now });
}

// Reconcile the in-memory Map back into the dead_boards table: rows deleted
// from the Map (a board came back with 200, or a non-404 cleared a low miss
// count) are deleted from the table, everything else is upserted.
export function saveDeadBoards(_file, rows) {
  db.tx(() => {
    for (const existing of db.listDeadBoards()) {
      if (!rows.has(key(existing.ats, existing.board))) db.deleteDeadBoard(existing.ats, existing.board);
    }
    for (const row of rows.values()) {
      db.upsertDeadBoard({
        ats: row.ats,
        board: row.board,
        misses: row.misses,
        last_checked: new Date(row.lastChecked).toISOString(),
      });
    }
  });
}
