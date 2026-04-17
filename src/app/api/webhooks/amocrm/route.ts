import { parseIncomingWebhook } from "@/lib/amocrm/webhook-parser";
import { getServerEnv } from "@/lib/env";
import { insertWebhookEvents } from "@/lib/repositories";
import { logError, logWarn } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

function isWebhookAuthorized(request: Request): boolean {
  const env = getServerEnv();
  if (!env.WEBHOOK_SHARED_SECRET) {
    return true;
  }

  const headerSecret = request.headers.get("x-webhook-secret");
  const bearer = request.headers.get("authorization");
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");

  return (
    headerSecret === env.WEBHOOK_SHARED_SECRET ||
    bearer === `Bearer ${env.WEBHOOK_SHARED_SECRET}` ||
    querySecret === env.WEBHOOK_SHARED_SECRET
  );
}

export async function POST(request: Request) {
  try {
    if (!isWebhookAuthorized(request)) {
      return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const { events } = await parseIncomingWebhook(request);
    if (events.length === 0) {
      logWarn("Webhook received without lead events");
      return Response.json({ ok: true, queued: 0 });
    }

    await insertWebhookEvents(events);

    return Response.json({
      ok: true,
      queued: events.length
    });
  } catch (error) {
    logError("Webhook ingestion failed", {
      error: error instanceof Error ? error.message : "Unknown error"
    });

    return Response.json(
      {
        ok: false,
        error: "Failed to process webhook"
      },
      { status: 500 }
    );
  }
}
