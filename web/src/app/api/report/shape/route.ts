import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, doctorState, readApplications, readInbox, trackerCanDelete } from "@/lib/career-ops";
import { coreDb, coreDbAvailable } from "@/lib/db";
import { scannerSupportsJson } from "@/lib/core/scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// STRUCTURAL diagnostics for the in-app bug reporter: shapes, counts and
// capability probes only — never file contents. A malformed tracker shows up
// here as "12 candidate rows, 5 parsed", which is exactly what triage needs,
// without a single company name leaving the machine.

function count(sql: string): number {
  try {
    if (!coreDbAvailable()) return 0;
    return Number((coreDb().get(sql) as { c?: number } | undefined)?.c ?? 0);
  } catch {
    return 0;
  }
}

function dirCount(rel: string, ext: string): number {
  try {
    return fs.readdirSync(path.join(careerOpsRoot(), rel)).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

export async function GET() {
  const doctor = doctorState();
  // "candidate" = a stored row; parsed = what the tolerant reader accepted.
  // A gap between the two is the data-contract fingerprint (e.g. pipeline
  // rows whose preserved raw line no longer parses as a checkbox row).
  const inboxCandidates = count("SELECT COUNT(*) AS c FROM pipeline_items");
  const trackerCandidates = count("SELECT COUNT(*) AS c FROM applications");
  return Response.json({
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    setup: {
      phase: doctor.phase,
      missing: doctor.missing, // system prereq FILENAMES only (cv.md, portals.yml…)
      hasCv: doctor.hasCv,
      hasData: doctor.hasData,
    },
    data: {
      inbox: { candidates: inboxCandidates, parsed: readInbox().length },
      tracker: { candidates: trackerCandidates, parsed: readApplications().length },
      reports: dirCount("reports", ".md"),
      pdfs: dirCount("output", ".pdf"),
      // Key name kept for triage continuity: "is there any follow-up data" —
      // now the follow_ups/follow_up_next tables instead of data/follow-ups.md.
      followupsFile:
        count("SELECT COUNT(*) AS c FROM follow_ups") > 0 ||
        count("SELECT COUNT(*) AS c FROM follow_up_next") > 0,
    },
    capabilities: {
      scanJson: scannerSupportsJson(),
      trackerDelete: trackerCanDelete(),
    },
  });
}
