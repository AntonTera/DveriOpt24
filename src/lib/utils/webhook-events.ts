import { StoredDealState } from "@/lib/types";

export function isStaleWebhookEvent(previousState: StoredDealState | null, receivedAt: string): boolean {
  const lastAppliedEventAt = previousState?.last_event_received_at;
  if (!lastAppliedEventAt) {
    return false;
  }

  return Date.parse(receivedAt) < Date.parse(lastAppliedEventAt);
}
