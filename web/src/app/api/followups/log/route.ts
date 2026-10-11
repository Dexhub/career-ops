import { CHANNELS, isRealISODate, localISODate } from "@/lib/followups";
import { parseFollowupId } from "@/lib/followup-id.mjs";
import { coreDb, coreDbAvailable, dbWriteError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Append-only follow-up log → the follow_ups table (NEVER clobber; the cadence
// calculator reads this to advance the schedule). Columns are the canonical
// row the core's followup-cadence.mjs consumes:
//   num | app_num | date | company | role | channel | contact | notes
// SQLite serializes writers (web, CLI, seeder) — the old in-process queue +
// cross-process file lock pair is retired with data/follow-ups.md itself.

/** Cells must stay single-line and pipe-free (the cadence calculator and the
 *  history panel render them inline). `max` optional — notes are deliberately
 *  uncapped (user decision), identity fields keep a sanity cap. */
function cell(v: unknown, max?: number): string {
  const s = String(v ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "/")
    .trim();
  return max ? s.slice(0, max) : s;
}

export async function POST(req: Request) {
  let body: {
    appNum?: string | number;
    num?: string | number; // legacy alias for appNum (old home-card payload)
    company?: string;
    role?: string;
    date?: string;
    channel?: string;
    contact?: string;
    notes?: string;
    note?: string; // legacy alias for notes
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const appNum = parseFollowupId(body.appNum ?? body.num);
  if (appNum === null) {
    return Response.json({ error: "appNum (application #) required" }, { status: 400 });
  }
  const company = cell(body.company, 80);
  if (!company) return Response.json({ error: "company required" }, { status: 400 });

  // Default to the LOCAL day (local-first app — server clock is the user's
  // clock); validate as a REAL calendar date, not just the shape: one
  // impossible date (2026-13-45) in the log would crash the cadence engine.
  const date = (body.date ?? localISODate()).trim();
  if (!isRealISODate(date)) {
    return Response.json({ error: "date must be a real calendar date (YYYY-MM-DD)" }, { status: 400 });
  }
  const rawChannel = (body.channel ?? "Other").trim();
  const channel = CHANNELS.find((c) => c.toLowerCase() === rawChannel.toLowerCase());
  if (!channel) {
    return Response.json({ error: `channel must be one of: ${CHANNELS.join(", ")}` }, { status: 400 });
  }
  const role = cell(body.role, 80);
  const contact = cell(body.contact, 120);
  const notes = cell(body.notes ?? body.note ?? "");

  if (!coreDbAvailable()) {
    return Response.json({ error: "the career-ops data layer is unavailable" }, { status: 503 });
  }
  try {
    const db = coreDb();
    // num allocation + insert in ONE transaction, so two concurrent logs can't
    // mint the same num (the old file writer serialized this with a queue).
    const num = db.tx(() => {
      const next = db.maxFollowUpNum() + 1;
      db.upsertFollowUp({ num: next, app_num: appNum, date, company, role, channel, contact, notes });
      return next;
    });
    return Response.json({ ok: true, num, appNum, date, channel });
  } catch (e) {
    return dbWriteError(e, "write failed");
  }
}

// Remove ONE logged follow-up by its `num` (mistake correction — user-initiated
// from the history panel). Only the matching row is dropped.
export async function DELETE(req: Request) {
  let body: { num?: string | number };
  try {
    body = (await req.json()) as { num?: string | number };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const num = parseFollowupId(body.num);
  if (num === null) return Response.json({ error: "num required" }, { status: 400 });

  if (!coreDbAvailable()) return Response.json({ error: "no follow-up log" }, { status: 404 });
  try {
    const db = coreDb();
    const existing = db.get("SELECT num FROM follow_ups WHERE num = ?", [num]);
    if (!existing) return Response.json({ error: `follow-up #${num} not found` }, { status: 404 });
    db.run("DELETE FROM follow_ups WHERE num = ?", [num]);
    return Response.json({ ok: true, num });
  } catch (e) {
    return dbWriteError(e, "delete failed");
  }
}
