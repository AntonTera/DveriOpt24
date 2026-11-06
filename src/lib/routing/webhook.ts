import { matchesSecret } from "./config";
import type { RoutingEnqueueJob } from "./handlers";
import { enqueueRoutingJobs } from "./repository";

const BODY_LIMIT = 1024 * 1024;

async function readLimitedBody(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode();
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

export async function acceptRoutingWebhook(
  request: Request,
  enabled: boolean,
  secret: string | undefined,
  parse: (body: string, contentType: string, now: Date) => RoutingEnqueueJob[]
) {
  if (!enabled) return Response.json({ ok: false }, { status: 404 });

  const token = request.headers.get("x-webhook-secret") ?? new URL(request.url).searchParams.get("secret");
  if (!matchesSecret(token, secret)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let jobs: RoutingEnqueueJob[];
  try {
    const body = await readLimitedBody(request);
    if (body === null) return Response.json({ ok: false, error: "Payload too large" }, { status: 413 });
    jobs = parse(body, request.headers.get("content-type") ?? "", new Date());
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ ok: false, error: "Too many events" }, { status: 413 });
    return Response.json({ ok: false, error: "Invalid webhook body" }, { status: 400 });
  }

  try {
    if (jobs.length) await enqueueRoutingJobs(jobs);
    return Response.json({ ok: true, accepted: jobs.length });
  } catch {
    return Response.json({ ok: false, error: "Routing enqueue failed" }, { status: 503 });
  }
}
