import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { atomicWrite } from "@/lib/core/safe-write";
import { resolveDataRoot } from "@/lib/core/data-root.mjs";
import { resolveCodeRoot, resolveRootScript } from "@/lib/core/code-root.mjs";
import { parseStatusLog } from "@/lib/pipeline-sankey.mjs";
// Pipeline rows are parsed in a plain .mjs for the same reason as
// tracker-table.mjs: so `node --test` can exercise the real parser.
import { parseInbox } from "@/lib/pipeline-table.mjs";
// One definition of the `{n}-RESERVED.md` convention, shared with
// run-cli-support.mjs — see report-files.mjs for why it lives there.
import { isReservedReportFile } from "@/lib/report-files.mjs";
// The data layer: data/career-ops.db via core/db.mjs — the single source of
// truth for tracker, inbox, status-log, scan-history and pdf-index data.
import { coreDb, coreDbAvailable } from "@/lib/db";

/**
 * Resolve the career-ops "home" — the directory holding the user's sibling
 * files (cv.md, data/, reports/). In production the web/ app lives inside the
 * career-ops checkout, so the home is its parent (..). Dev overrides via
 * CAREER_OPS_ROOT to read the user's real (gitignored) data from a separate
 * checkout — see web/.env.local.
 */
export function careerOpsRoot(): string {
  // `process.cwd()` is `<core>/web` for `next dev`/`next start`, so its parent is
  // the core checkout — the same directory `path-resolver.mjs` calls `__dirname`.
  // resolveDataRoot() needs it explicitly because relative env values and marker
  // contents resolve against it; see data-root.mjs for why that base matters.
  const coreRoot = path.resolve(process.cwd(), "..");
  return resolveDataRoot(
    coreRoot,
    (p) => {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null; // absent, unreadable, or a directory — all mean "no marker"
      }
    },
    process.env,
    path.resolve,
    path.join,
  );
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). The `.mjs`
 * is assembled here from the bare name so the literal never appears as a direct
 * `execFile`/`spawn` argument — Next's bundler statically traces such literals
 * as module imports and fails the production build otherwise.
 *
 * Scripts live in the engine checkout — never in the data root. Under the #524
 * split layout (CAREER_OPS_ROOT pointing at a data-only directory) the data
 * root has no `.mjs` files, so resolving here made every script-driven endpoint
 * (Explore discovery, doctor, portals verify, followups, run) report the
 * checkout as missing. CAREER_OPS_CODE_ROOT selects the checkout explicitly.
 */
export function rootScript(nameNoExt: string): string {
  // resolveRootScript() already returns the absolute `<checkout>/<name>.mjs`, and
  // its path.join carries the Turbopack ignore: the core checkout is selected at
  // runtime and must not be bundled into the web server output.
  return resolveRootScript(resolveCodeRoot(process.cwd(), process.env), nameNoExt);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

export type InboxJob = { url: string; company: string; role: string; location?: string; compensation?: string; done: boolean; postedAt?: string };

/** Read the inbox from pipeline_items (the data/pipeline.md replacement).
 *  Each row preserves the original annotated line in `raw`, so the proven
 *  row grammar in pipeline-table.mjs still does the parsing — one parser,
 *  whether the line came from the legacy file or the DB (#1015, #1017). */
export function readInbox(): InboxJob[] {
  if (!coreDbAvailable()) return [];
  const rows = coreDb().listPipelineItems();
  if (!rows.length) return [];
  // parseInbox only reads "- [ ]" checkbox lines, so section membership is
  // carried by the raw line itself (processed rows aren't checkbox rows).
  return parseInbox(rows.map((r) => r.raw).join("\n"));
}

/**
 * scan_history → Map<url, first_seen(YYYY-MM-DD)>. The scanner stamps every
 * discovered posting with the date it was first seen, so we derive the inbox's
 * freshness signal here WITHOUT touching the core (see the inbox-triage build:
 * freshness = option A, no scanner change). Tolerant by construction: no data
 * layer → empty map (freshness facet just hides); a malformed date is skipped,
 * never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const dates = new Map<string, string>();
  if (!coreDbAvailable()) return dates;
  for (const row of coreDb().listScanHistory()) {
    const firstSeen = (row.first_seen ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(row.url)) dates.set(row.url, firstSeen);
  }
  return dates;
}

export type Application = {
  n: string;
  date: string;
  company: string;
  /** Intermediary channel (#1596): agency/recruiter firm, "—" for direct, "" when the tracker has no Via column. */
  via: string;
  role: string;
  /** Tracker's `Location` column — recognized by the alias table; "" when the tracker has no such column. */
  location: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  /** Tracker's `Apply Link` column — usually a markdown link to the original ad; "" when the column is absent. */
  applyLink: string;
  /** Tracker's `Follow-up` column — a date or "—"; "" when the column is absent. */
  followUp: string;
  notes: string;
};

/**
 * Read the tracker from the applications table (source of truth). Column
 * meanings are unchanged from the markdown tracker: `report` keeps its
 * markdown-link cell (e.g. `[001](../reports/001-….md)`) so findReportFile's
 * link resolution works exactly as before. `followUp` has no DB column —
 * follow-up scheduling lives in follow_ups/follow_up_next — so it is "" here,
 * the same value the parser produced when the tracker had no such column.
 */
export function readApplications(): Application[] {
  if (!coreDbAvailable()) return [];
  return coreDb().listApplications().map((r) => ({
    n: String(r.num),
    date: r.date,
    company: r.company,
    via: r.via,
    role: r.role,
    location: r.location,
    score: r.score,
    status: r.status,
    pdf: r.pdf,
    report: r.report,
    applyLink: r.url,
    followUp: "",
    notes: r.notes,
  }));
}

export type StatusLogRow = {
  num: number;
  date: string;
  from: string;
  to: string;
  source: string;
  note: string;
};

/** Append-only status transitions (status_events). An empty table is normal
 *  (no status change recorded yet) and yields []. */
export function readStatusLog(): StatusLogRow[] {
  return parseStatusLog(readApplicationStatusLog() ?? "");
}

/** The status ledger reconstructed in its historical TSV shape
 *  (num\tdate\tfrom\tto\tsource\tnote) from status_events, so existing
 *  consumers (parseStatusLog, the analytics history view) read it unchanged.
 *  null mirrors the old "no log file yet": data layer missing or no events. */
export function readApplicationStatusLog(): string | null {
  if (!coreDbAvailable()) return null;
  const events = coreDb().listStatusEvents();
  if (!events.length) return null;
  const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  return events
    .map((e) => [e.app_num, e.event_date, e.from_status, e.to_status, e.source, e.note].map(cell).join("\t"))
    .join("\n");
}

/** Resolve the report-number key in the pdf_index table for a given report id.
 *  Digits-only, full-string match — parseInt alone would let "12abc" resolve to
 *  report 12, matching the wrong index row. Returns null for anything malformed,
 *  so callers never have to re-validate. */
function pdfIndexTarget(n: string): number | null {
  const trimmed = n.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

export async function pdfReadyForReport(n: string): Promise<boolean> {
  return (await pdfPathForReport(n)) !== null;
}

export type PdfPathForReportResult =
  | { status: "found"; path: string }
  | { status: "not-found" }
  | { status: "invalid" }
  | { status: "rejected" };

/** The exact PDF path indexed for this report number, or null if none exists
 *  (malformed id, no index row, the indexed file is missing on disk, or the
 *  index resolved outside the workspace). Lets the viewer route serve the
 *  SPECIFIC report's PDF instead of guessing the newest file for the company —
 *  two applications at the same company have two different tailored CVs.
 *
 *  The lookup is the core's own getPdfIndexEntry (pdf_index table, kind-aware:
 *  cover-letter rows never answer a CV lookup) — the same resolver the CLI's
 *  generate-pdf flow writes through, so there is one definition of "which row
 *  matches this report", not two. */
export async function pdfPathStatusForReport(n: string): Promise<PdfPathForReportResult> {
  const target = pdfIndexTarget(n);
  if (target === null) return { status: "invalid" };
  if (!coreDbAvailable()) return { status: "not-found" };
  const root = careerOpsRoot();
  const row = coreDb().getPdfIndexEntry(String(target), { kind: "cv" });
  if (!row) return { status: "not-found" };
  if (!row.pdf) return { status: "rejected" };
  // The index is user-layer data turned into a filesystem read that this route
  // then serves — the path must be contained BY CONSTRUCTION, not by trusting
  // the writer. Rows are written relative to the WORKSPACE root
  // (careerOpsRoot()), same base as always, and must stay under output/.
  const abs = path.resolve(root, row.pdf);
  const outputDir = path.resolve(root, "output");
  if (!abs.startsWith(outputDir + path.sep)) return { status: "rejected" };
  // Scoped to outputDir, not the broader root: the lexical startsWith check
  // above only rejects an unresolved path outside output/, but a symlink
  // PLACED under output/ can still resolve to somewhere else inside root
  // (e.g. reports/) and pass a root-scoped realpath check — serving a file
  // this route was never meant to expose.
  if (!isRegularContainedFile(abs, outputDir)) return { status: "rejected" };
  return { status: "found", path: abs };
}

export async function pdfPathForReport(n: string): Promise<string | null> {
  const result = await pdfPathStatusForReport(n);
  return result.status === "found" ? result.path : null;
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(snapshot?: Pick<PipelineSummary, "applications" | "inbox">): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  // Home already reads these files. Reuse that snapshot so its setup check
  // neither parses the tracker twice nor disagrees with the rendered queue.
  const hasData = (snapshot?.applications ?? readApplications()).length > 0 ||
    (snapshot?.inbox ?? readInbox()).some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) onto each raw posting — the inbox's
    // triage view orders/faceted-filters on it entirely client-side.
    inbox: readInbox().map((j) => ({ ...j, postedAt: j.postedAt ?? scanDates.get(j.url) })),
    applications: readApplications(),
  };
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number.
 *  The tracker row's own report link is authoritative: report FILE numbers can
 *  differ from application numbers (e.g. app #309 → reports/308-…), so
 *  resolving only by leading filename number misses those. Links are
 *  normalized relative to the tracker file's directory (see #760). Falls back
 *  to the filename scan (reports/{n}-{slug}-{date}.md, possibly zero-padded)
 *  for rows without a parseable link.
 *
 *  Both the linked lookup and the fallback scan skip `{n}-RESERVED.md`
 *  placeholder files.
 *  `reserve-report-num.mjs` writes an empty `NNN-RESERVED.md` sentinel to
 *  claim a report number before a worker has actually written the report;
 *  it's normally deleted once the real report lands (or GC'd after 4h if
 *  abandoned). But "RESERVED" sorts alphabetically before nearly every real
 *  slug (company names start with lowercase/uppercase letters after the
 *  number-dash, "R" often lands mid-alphabet or earlier), so if a sentinel
 *  outlives its report — e.g. a worker was driven directly instead of
 *  through the orchestrator that owns cleanup — `.find()` could return the
 *  empty sentinel instead of the real report, making the report body and the
 *  Apply/PDF-ready checks disappear. */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  const root = careerOpsRoot();
  const app = readApplications().find((a) => parseInt(a.n, 10) === target);
  const linked = app?.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    // Containment: a hand-edited link must not resolve outside the project.
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

/** True containment check: resolves symlinks before comparing, so a link
 *  planted under data/ or reports/ can't leak files outside the project. */
function containedRealpath(p: string, root: string): boolean {
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep);
  } catch {
    return false; // missing file or unresolvable link — treat as not found
  }
}

export function isRegularContainedFile(p: string, root: string): boolean {
  try {
    return fs.statSync(p).isFile() && containedRealpath(p, root);
  } catch {
    return false;
  }
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    // Reports live in the user's runtime checkout, outside the web build graph.
    return {
      content: fs.readFileSync(/* turbopackIgnore: true */ file, "utf8"),
      file: path.basename(file),
    };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(careerOpsRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}


/**
 * AGENTS.md's two language axes, resolved from config/profile.yml.
 *
 * `language.output` governs human-facing prose; `language.modes_dir` selects the
 * market vocabulary and local evaluation rules. They compose freely — English
 * output with DACH vocabulary is a valid configuration — so they are returned
 * as separate fields rather than collapsed into one "locale".
 */
export type LanguageConfig = {
  /** language.output — prose language for user-facing text. Default "en". */
  output: string;
  /**
   * language.modes_dir's PRIMARY declared market, normalized without a
   * trailing slash. Default "modes". When modes_dir is an array (#3793 —
   * multiple simultaneous target markets), this is `modesDirs[0]`: the
   * evaluation-mode file can only come from one market at a time.
   */
  modesDir: string;
  /**
   * Every market declared in language.modes_dir, primary first. A plain
   * string config normalizes to a single-element array; the default (no
   * modes_dir configured) is `["modes"]`. Prefer this over `modesDir` when a
   * caller needs to know about ALL declared candidate markets, not just the
   * primary one (#3793).
   */
  modesDirs: string[];
  /** The primary market's evaluation-mode file, repo-root-relative. Default "modes/oferta.md". */
  evalModeFile: string;
};

/**
 * A `modes_dir` value we are willing to turn into a filesystem path.
 *
 * profile.yml is user-editable and this value is used to read a directory and
 * to build a path handed to an agent, so it is validated rather than trusted:
 * a crafted `modes/../../etc` must not escape the checkout. Rejecting falls
 * back to the default, which is always correct, never dangerous.
 */
const MODES_DIR_RE = /^modes(?:\/[A-Za-z0-9_-]+)?$/;

/**
 * Every localized evaluation mode's title line states the block range it
 * produces — "Valutazione completa A-F", "完整的 A-G 维度评估", "전체 평가 A-G".
 * Older translations say A-F and newer ones A-G (Block G, posting legitimacy),
 * so both count; the dash may be ASCII or typographic.
 *
 * This is what identifies the evaluation mode inside a market directory, in
 * preference to a hardcoded {dir → filename} map. A map would have to list all
 * 18 market directories that exist today and would silently go stale the next
 * time a translation lands — the exact class of bug this function is fixing.
 * Verified against every market directory in the repo: each contains exactly
 * one file whose title line matches, and no apply-mode collides.
 */
const EVAL_MODE_TITLE_RE = /A[-\u2010-\u2015][FG]/;

const DEFAULT_EVAL_MODE = "modes/oferta.md";

/**
 * Find the evaluation mode inside a market directory. Returns the default when
 * the directory is unreadable or nothing in it looks like an evaluation mode —
 * a wrong-but-working English evaluation beats a run that cannot start.
 */
function resolveEvalModeFile(root: string, modesDir: string): string {
  if (modesDir === "modes") return DEFAULT_EVAL_MODE;
  let names: string[];
  try {
    names = fs.readdirSync(path.join(root, modesDir));
  } catch {
    return DEFAULT_EVAL_MODE;
  }
  for (const name of names.sort()) {
    // `_shared.md`, `_profile.md` and friends are includes, never entry points.
    if (!name.endsWith(".md") || name.startsWith("_") || name === "README.md") continue;
    try {
      const first = fs.readFileSync(path.join(root, modesDir, name), "utf8").split("\n", 1)[0] ?? "";
      if (EVAL_MODE_TITLE_RE.test(first)) return `${modesDir}/${name}`;
    } catch {
      /* unreadable file — keep looking */
    }
  }
  return DEFAULT_EVAL_MODE;
}

/**
 * Read the language configuration. Never throws: a missing or malformed
 * profile.yml yields the English/global default, because a broken config
 * should degrade the market vocabulary, not block every evaluation.
 */
export function readLanguageConfig(): LanguageConfig {
  const root = careerOpsRoot();
  let modesDirs = ["modes"];
  let output = "en";
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(root, "config", "profile.yml"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const language = (parsed as Record<string, unknown>).language;
      if (language && typeof language === "object" && !Array.isArray(language)) {
        const l = language as Record<string, unknown>;
        if (typeof l.output === "string" && l.output.trim()) output = l.output.trim();
        // modes_dir may be a single declared market (string, the historical
        // shape) or a list of simultaneously declared candidate markets
        // (#3793). Either shape normalizes to a string array here; an empty
        // or fully-invalid list falls back to the ["modes"] default.
        const rawModesDir = l.modes_dir;
        const rawCandidates = Array.isArray(rawModesDir) ? rawModesDir : [rawModesDir];
        const resolveDeclaredDir = (value: unknown): string | null => {
          if (typeof value !== "string" || !value.trim()) return null;
          const candidate = value.trim().replace(/\/+$/, "");
          if (!MODES_DIR_RE.test(candidate)) return null;
          return fs.existsSync(path.join(root, candidate)) ? candidate : null;
        };
        // The first declared entry is primary. Do not filter it away and
        // silently promote a later market into the evaluation slot. This
        // mirrors gemini-eval.mjs: invalid primary -> default modes, while
        // valid secondary markets remain available as shared context.
        const primary = resolveDeclaredDir(rawCandidates[0]);
        const extras = rawCandidates.slice(1).map(resolveDeclaredDir).filter(
          (value): value is string => value !== null,
        );
        if (primary) {
          modesDirs = [primary, ...extras];
        } else if (extras.length) {
          modesDirs = ["modes", ...extras.filter((dir) => dir !== "modes")];
        }
      }
    }
  } catch {
    /* no profile yet, or malformed — defaults are correct */
  }
  const modesDir = modesDirs[0];
  return { output, modesDir, modesDirs, evalModeFile: resolveEvalModeFile(root, modesDir) };
}
