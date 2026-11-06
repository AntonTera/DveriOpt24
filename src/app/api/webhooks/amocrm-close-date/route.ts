import { isCloseDateEnabled } from "@/lib/routing/config";
import { parseCloseDateWebhook } from "@/lib/routing/close-date";
import { acceptRoutingWebhook } from "@/lib/routing/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return acceptRoutingWebhook(request, isCloseDateEnabled(), process.env.CRM_CLOSE_DATE_WEBHOOK_SECRET, parseCloseDateWebhook);
}
