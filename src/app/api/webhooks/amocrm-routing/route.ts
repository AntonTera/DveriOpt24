import { isRoutingEnabled } from "@/lib/routing/config";
import { parseRoutingWebhook } from "@/lib/routing/ingress";
import { acceptRoutingWebhook } from "@/lib/routing/webhook";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return acceptRoutingWebhook(request, isRoutingEnabled(), process.env.CRM_ROUTING_WEBHOOK_SECRET, parseRoutingWebhook);
}
