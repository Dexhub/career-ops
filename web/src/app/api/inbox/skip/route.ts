import { NextResponse } from "next/server";
import { postingUrl } from "@/lib/inbox-skip.mjs";
import { coreDb, coreDbAvailable, type PipelineItemRow } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Inbox Skip/undo: flip checked 0 ↔ 1 on the matching pending pipeline_items
// row (the data/pipeline.md replacement). This is NOT /api/status — Home
// DecisionCard Skip writes a tracker Discarded status; the inbox is the
// pipeline checklist. The row's `raw` line is flipped in lockstep so every
// reader of the preserved line (readInbox's parser) agrees with `checked`.
// SQLite serializes this against the CLI/scanner — no file lock needed.

export async function POST(req: Request) {
  let body: { url?: unknown; done?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const url = postingUrl(body.url);
  if (!url) {
    return NextResponse.json({ error: "url must be an http(s) posting URL", code: "invalid-url" }, { status: 400 });
  }
  if (body.done !== undefined && typeof body.done !== "boolean") {
    return NextResponse.json({ error: "done must be a boolean" }, { status: 400 });
  }
  const done = body.done !== false;

  if (!coreDbAvailable()) {
    return NextResponse.json(
      { error: "inbox skip needs the career-ops data layer; this root has data only", code: "core-script-missing" },
      { status: 503 },
    );
  }

  try {
    const db = coreDb();
    // Pending rows only — processed entries are history, not an inbox item the
    // user can skip (same scoping the old Pending-section range check enforced).
    const row = db.get("SELECT * FROM pipeline_items WHERE url = ? AND section = 'pending'", [url]) as
      | PipelineItemRow
      | undefined;
    if (!row) {
      return NextResponse.json({ error: "no pipeline row for that URL", code: "unmatched" }, { status: 404 });
    }
    const already = (row.checked ? 1 : 0) === (done ? 1 : 0);
    if (!already) {
      // Flip the stored checkbox marker inside the preserved raw line too.
      const raw = row.raw.replace(/^(\s*-\s*)\[[ xX]\]/, `$1[${done ? "x" : " "}]`);
      db.updatePipelineItem(url, { checked: done ? 1 : 0, raw });
    }
    return NextResponse.json({ ok: true, done, matched: 1, changed: already ? 0 : 1 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/busy|locked/i.test(msg)) {
      return NextResponse.json(
        { error: "The pipeline is being written right now (CLI or another tab). Try again.", code: "busy" },
        { status: 409, headers: { "Retry-After": "5" } },
      );
    }
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}
