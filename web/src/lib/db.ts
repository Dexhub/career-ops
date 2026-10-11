import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";

/**
 * Single gateway from the web app to the core data layer (`core/db.mjs`,
 * node:sqlite over data/career-ops.db). Every web read/write of tracker,
 * inbox, follow-ups, status-log, scan-history or pdf-index data goes through
 * this module — never a parallel SQL implementation, never the retired
 * markdown/TSV files.
 *
 * The core module lives OUTSIDE web/ (the engine checkout root), which
 * Turbopack's pinned root refuses to bundle — so it is loaded at runtime via a
 * dynamic file-URL import, the same ignore-comment pattern tracker-lock.ts and
 * pdf-index.ts already use. Top-level await resolves it once per process, so
 * every downstream helper stays synchronous (node:sqlite is sync).
 *
 * Availability is a real state, not an error: a data-only root or an old
 * checkout has no core/db.mjs. Readers degrade to empty data (the same shape
 * the old file readers produced for a missing file); writers answer with a
 * clear 4xx/5xx from their route.
 */

export type ApplicationRow = {
  num: number;
  date: string;
  company: string;
  role: string;
  via: string;
  location: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
  url: string;
  updated_at?: string;
};

export type StatusEventRow = {
  id: number;
  app_num: number;
  event_date: string;
  from_status: string;
  to_status: string;
  source: string;
  note: string;
};

export type PipelineItemRow = {
  seq: number;
  section: string;
  url: string;
  checked: number;
  raw: string;
  added_at?: string;
};

export type ScanHistoryRow = {
  url: string;
  first_seen: string;
  portal: string;
  title: string;
  company: string;
  status: string;
  location: string;
  fingerprint: string;
  posted_at: string;
  trust_score: string;
  trust_flags: string;
  normalized_company: string;
  requisition_id: string;
  language: string;
};

export type PdfIndexRow = {
  id: number;
  report: string;
  report_norm: string;
  pdf: string;
  html: string;
  format: string;
  date: string;
  kind: string;
};

export type FollowUpRow = {
  num: number;
  app_num: number;
  date: string;
  company: string;
  role: string;
  channel: string;
  contact: string;
  notes: string;
};

export type FollowUpNextRow = {
  app_num: number;
  next_date: string;
  set_date: string;
};

export type CoreDb = {
  resolveDbPath(): string;
  // applications + status log
  listApplications(filter?: { status?: string; company?: string }): ApplicationRow[];
  getApplication(num: number | string): ApplicationRow | undefined;
  appendStatusEvent(e: {
    appNum: number;
    eventDate: string;
    fromStatus?: string;
    toStatus?: string;
    source?: string;
    note?: string;
  }): void;
  listStatusEvents(appNum?: number | null): StatusEventRow[];
  // follow-ups
  listFollowUps(): FollowUpRow[];
  maxFollowUpNum(): number;
  upsertFollowUp(f: Partial<FollowUpRow> & { num: number }): void;
  listFollowUpNext(): FollowUpNextRow[];
  setFollowUpNext(appNum: number, nextDate: string, setDate: string): void;
  clearFollowUpNext(appNum: number): void;
  // pipeline (inbox)
  listPipelineItems(filter?: { section?: string; checked?: number | boolean }): PipelineItemRow[];
  hasPipelineUrl(url: string): boolean;
  addPipelineItem(item: { url: string; section?: string; checked?: number; raw?: string }): void;
  updatePipelineItem(url: string, patch: Partial<Pick<PipelineItemRow, "section" | "checked" | "raw">>): void;
  // scan history
  getScanHistory(url: string): ScanHistoryRow | undefined;
  listScanHistory(): ScanHistoryRow[];
  // pdf index
  getPdfIndexEntry(report: string, opts?: { kind?: string }): PdfIndexRow | undefined;
  listPdfIndex(): PdfIndexRow[];
  // generic escape hatches (still the core's own prepared statements)
  tx<T>(fn: () => T): T;
  all(sql: string, params?: unknown[]): unknown[];
  get(sql: string, params?: unknown[]): unknown;
  run(sql: string, params?: unknown[]): unknown;
};

let mod: CoreDb | null = null;
let loadError: Error | null = null;

try {
  const file = path.join(resolveCodeRoot(process.cwd(), process.env), "core", "db.mjs");
  // Dynamic runtime import — the bundlers must not trace this (the module is
  // outside the Turbopack root and uses node:sqlite, a Node builtin).
  mod = (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ pathToFileURL(file).href)) as CoreDb;
} catch (e) {
  loadError = e instanceof Error ? e : new Error(String(e));
}

/** True when core/db.mjs loaded and the data layer is usable. */
export function coreDbAvailable(): boolean {
  return mod !== null;
}

/** The core data layer. Throws (with the original load error) when missing —
 *  call coreDbAvailable() first on paths that must degrade gracefully. */
export function coreDb(): CoreDb {
  if (!mod) throw loadError ?? new Error("core/db.mjs unavailable");
  return mod;
}

/** Map a node:sqlite throw onto an HTTP response. A busy/locked database is
 *  transient contention (the CLI or a scan holds a write txn) → 409 retryable,
 *  mirroring the old file-lock's TrackerBusyError/FollowupsBusyError mapping. */
export function dbWriteError(e: unknown, fallback = "write failed"): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (/busy|locked/i.test(msg)) {
    return Response.json(
      { error: "database is busy — try again in a moment" },
      { status: 409, headers: { "Retry-After": "1" } },
    );
  }
  return Response.json({ error: msg || fallback }, { status: 500 });
}
