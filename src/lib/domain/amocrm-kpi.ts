import {
  AMO_KPI_MANAGER_NAME_BY_USER_ID,
  AMO_KPI_SUPPORTED_STATUS_IDS,
  AMO_STATUS,
  EXCLUDED_RESPONSIBLE_USER_ID,
  KPI_STAGE_META,
  KPI_STAGE_ORDER,
  MAIN_PIPELINE_ID,
  OBJECT_TYPE_RULES,
  getStatusSort
} from "@/lib/constants/amocrm";
import { AmoLeadSnapshot, KpiStage, StoredDealState } from "@/lib/types";

export interface AmoHistoryEvent {
  id: string;
  type: string;
  created_at: number;
  value_before: Array<{ lead_status?: { id: number; pipeline_id: number }; responsible_user?: { id: number } }>;
  value_after: Array<{ lead_status?: { id: number; pipeline_id: number }; responsible_user?: { id: number } }>;
}

export function shouldHandleAmoKpiStatus(statusId: number | null): statusId is number {
  return statusId !== null && AMO_KPI_SUPPORTED_STATUS_IDS.has(statusId);
}

export function isExcludedResponsibleUser(userId: number | null): boolean {
  return userId === EXCLUDED_RESPONSIBLE_USER_ID;
}

export function resolveManagerNameByUserId(userId: number | null): string | null {
  return userId ? AMO_KPI_MANAGER_NAME_BY_USER_ID[userId] ?? null : null;
}

export function missingKpiHistoryStages(lead: AmoLeadSnapshot, state: StoredDealState | null): KpiStage[] {
  if (state?.is_frozen || lead.statusId === AMO_STATUS.REFUSED) return [];
  const rule = lead.objectType ? OBJECT_TYPE_RULES[lead.objectType] : undefined;
  return KPI_STAGE_ORDER.filter((stage) => {
    const atCaptureStage = lead.statusId === KPI_STAGE_META[stage].reachedStatusId;
    if ((!rule?.[stage] && !atCaptureStage) || getStatusSort(lead.statusId) < KPI_STAGE_META[stage].reachedSort) return false;
    const previous = state?.active_kpis[stage];
    const captured = lead.kpiFields?.[stage];
    const row = state?.kp_rows[stage]?.payload ?? state?.zp_rows[stage]?.payload;
    return !previous && (!captured?.date || !captured.manager || (Boolean(rule?.[stage]) && !row));
  });
}

export function resolveLeadStageHistory(lead: AmoLeadSnapshot, events: AmoHistoryEvent[]): AmoLeadSnapshot["stageHistory"] {
  const sorted = [...events].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  const responsibilityChanges = sorted.filter((e) => e.type === "entity_responsible_changed");
  const history: NonNullable<AmoLeadSnapshot["stageHistory"]> = {};

  for (const event of sorted) {
    if (event.type !== "lead_status_changed") continue;
    const after = event.value_after[0]?.lead_status;
    const before = event.value_before[0]?.lead_status;
    if (!after || after.pipeline_id !== MAIN_PIPELINE_ID || after.id === AMO_STATUS.REFUSED) continue;
    // A transition's author need not be the manager responsible for the lead.
    const nextAssignment = responsibilityChanges.find((e) =>
      e.created_at > event.created_at || (e.created_at === event.created_at && e.id > event.id)
    );
    const userId = nextAssignment?.value_before[0]?.responsible_user?.id ?? lead.responsibleUserId;
    const manager = resolveManagerNameByUserId(userId);
    if (!manager) continue;
    for (const stage of KPI_STAGE_ORDER) {
      const threshold = KPI_STAGE_META[stage].reachedSort;
      const beforeSort = before?.pipeline_id === MAIN_PIPELINE_ID ? getStatusSort(before.id) : 0;
      if (!history[stage] && beforeSort < threshold && getStatusSort(after.id) >= threshold) {
        history[stage] = { occurredAt: new Date(event.created_at * 1000).toISOString(), manager };
      }
    }
  }
  return history;
}
