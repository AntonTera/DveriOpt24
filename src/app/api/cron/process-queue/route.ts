import { getServerEnv } from "@/lib/env";
import { processQueue } from "@/lib/services/process-queue";
import { logError } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;

function isCronAuthorized(request: Request): boolean {
  const env = getServerEnv();
  if (!env.CRON_SECRET) {
    return process.env.NODE_ENV !== "production";
  }

  return request.headers.get("authorization") === `Bearer ${env.CRON_SECRET}`;
}

async function handleQueueRun(request: Request) {
  if (!isCronAuthorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const result = await processQueue();

  return Response.json({
    ok: true,
    ...result
  });
}

export async function GET(request: Request) {
  try {
    return await handleQueueRun(request);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    logError("Queue processing failed", {
      error: errorMessage
    });

    return Response.json(
      { ok: false, error: "Queue processing failed", details: errorMessage },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
