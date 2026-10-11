import { readApplications } from "@/lib/career-ops";
import { coreDb, coreDbAvailable } from "@/lib/db";
import { getNormalizeTextKey } from "@/lib/core/text-key";
import { evaluatedKeys, isEvaluated } from "@/lib/whats-new-suppression.mjs";
import type { DiscoveredOffer } from "@/lib/explore";
import { collectWhatsNew, resolveOfferLimit } from "@/lib/whats-new.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The SUPPLY loop, ZERO tokens: "new matches this week" = roles surfaced by past
// free scans (the scan_history table) in the last N days that the user hasn't
// evaluated yet. No scan runs here — it reads the history a past scan already
// wrote, so the home stays instant + free (directly answers the #1 token-cost
// complaint). cols: url, first_seen, portal, title, company, status, location.
// The rows are re-serialized in that historical TSV column order so the proven
// pure helper (collectWhatsNew + its node --test coverage) parses them unchanged.
// Company matching keys come from the CORE (see lib/core/text-key.ts), never a
// local reimplementation. The previous ASCII-only key deleted every non-Latin
// letter, so "Škoda" collided with "Koda" — suppressing a real offer as
// "already evaluated" — and "日本電産" keyed to the empty string (#2666).

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const days = Math.min(30, Math.max(1, Number(searchParams.get("days")) || 7));
  // Home only needs enough offers for its cards; Explore's “See all” hand-off
  // asks for more. Both stay finite — `count` is always complete, so the true
  // total is free while the rendered list keeps a ceiling (see MAX_OFFER_LIMIT).
  const offerLimit = resolveOfferLimit(searchParams.get("limit"));
  const cutoff = Date.now() - days * 86_400_000;
  if (!coreDbAvailable()) return Response.json({ offers: [], count: 0 });
  const cell = (v: unknown) => String(v ?? "").replace(/[\t\r\n]+/g, " ");
  const rows = coreDb()
    .listScanHistory()
    .map((r) => [r.url, r.first_seen, r.portal, r.title, r.company, r.status, r.location].map(cell).join("\t"));

  // Roles already evaluated → don't resurface as "new". Keyed on company AND
  // role, not company alone: suppressing by employer removed that employer's
  // entire board after one evaluation (#3131). See lib/whats-new-suppression.
  const normalizeTextKey = await getNormalizeTextKey();
  const evaluated = evaluatedKeys(readApplications(), normalizeTextKey);

  const toOffer = (c: string[]): DiscoveredOffer | null => {
    const [url, firstSeen, portal, title, company, status, location] = c;
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (status && /skipped|expired/i.test(status)) return null;
    if (isEvaluated(evaluated, normalizeTextKey, company, title)) return null;
    return {
      url,
      company: (company || "").trim(),
      title: (title || "").trim(),
      location: (location || "").trim(),
      postedAt: /^\d{4}-\d{2}-\d{2}$/.test(firstSeen || "") ? firstSeen : "",
      ats: (portal || "").replace(/-full$/, "").trim() || "other",
      source: "whats-new",
    };
  };

  const { offers, count } = collectWhatsNew(rows, { cutoff, toOffer, offerLimit });
  return Response.json({ offers, count });
}
