import { isRealISODate, localISODate } from "@/lib/followups";
import { parseFollowupId } from "@/lib/followup-id.mjs";
import { coreDb, coreDbAvailable, dbWriteError } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pin an application's NEXT follow-up date, overriding the computed cadence.
// Stored in the follow_up_next table (app_num PRIMARY KEY — one pin per
// application, an upsert supersedes the previous pin, matching the old
// directive-line pruning). The core followup-cadence.mjs reads it; the pin
// wins over the computed schedule (it even revives a cold application) until a
// follow-up is logged on/after the set-date, which resumes the normal cadence.

export async function POST(req: Request) {
  let body: { appNum?: string | number; date?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const appNum = parseFollowupId(body.appNum);
  if (appNum === null) {
    return Response.json({ error: "appNum (application #) required" }, { status: 400 });
  }
  const date = (body.date ?? "").trim();
  if (!isRealISODate(date)) {
    return Response.json({ error: "date must be a real calendar date (YYYY-MM-DD)" }, { status: 400 });
  }

  if (!coreDbAvailable()) {
    return Response.json({ error: "the career-ops data layer is unavailable" }, { status: 503 });
  }
  try {
    coreDb().setFollowUpNext(appNum, date, localISODate());
    return Response.json({ ok: true, appNum, date });
  } catch (e) {
    return dbWriteError(e, "write failed");
  }
}

// Clear the pin for an application (the computed cadence takes over again).
export async function DELETE(req: Request) {
  let body: { appNum?: string | number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const appNum = parseFollowupId(body.appNum);
  if (appNum === null) {
    return Response.json({ error: "appNum (application #) required" }, { status: 400 });
  }

  if (!coreDbAvailable()) return Response.json({ error: "no follow-up log" }, { status: 404 });
  try {
    const db = coreDb();
    const existing = db.get("SELECT app_num FROM follow_up_next WHERE app_num = ?", [appNum]);
    if (!existing) {
      return Response.json({ error: `no pinned next-date for application #${appNum}` }, { status: 404 });
    }
    db.clearFollowUpNext(appNum);
    return Response.json({ ok: true, appNum });
  } catch (e) {
    return dbWriteError(e, "delete failed");
  }
}
