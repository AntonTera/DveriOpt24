import { getDutyConfig, matchesSecret } from "@/lib/routing/config";
import { createRoutingCrm } from "@/lib/routing/crm";
import { MAX_SHIFT_PAGES, previewRoutingShift } from "@/lib/routing/handlers";
import { createDutyLookup } from "@/lib/routing/schedule";
import { formatDisplayDate } from "@/lib/utils/datetime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !matchesSecret(request.headers.get("authorization"), `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const rawPage = new URL(request.url).searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (!/^\d+$/.test(rawPage) || !Number.isInteger(page) || page < 1 || page > MAX_SHIFT_PAGES) {
    return Response.json({ ok: false, error: "Invalid page" }, { status: 400 });
  }

  try {
    const config = getDutyConfig();
    const signal = AbortSignal.timeout(20_000);
    const crm = createRoutingCrm(signal);
    const lookup = createDutyLookup(config, crm, signal);
    const now = new Date();
    const preview = await previewRoutingShift({
      crm, dutyOwnerIds: config.dutyOwnerIds, getDutyOwner: () => lookup(now)
    }, page);
    return Response.json({ ok: true, day: formatDisplayDate(now), ...preview }, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch {
    return Response.json({ ok: false, error: "Shift preview unavailable" }, { status: 503 });
  }
}
