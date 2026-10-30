import {
  AMO_STATUS,
  KPI_STAGE_META,
  KPI_STAGE_ORDER,
  OBJECT_TYPE_RULES,
  SALARY_TRIGGER_STATUS_IDS,
  getStatusSort
} from "@/lib/constants/amocrm";
import {
  ActiveKpiRecord,
  AmoFieldMutation,
  AmoLeadSnapshot,
  KpiStage,
  LeadKpiState,
  SheetName,
  SheetRowPayload,
  StoredDealState
} from "@/lib/types";
import { formatDisplayDate, formatDisplayTime } from "@/lib/utils/datetime";

function buildStageRecord(
  stage: KpiStage,
  amount: number,
  lead: AmoLeadSnapshot,
  previousState: StoredDealState | null,
  processedAt: string,
  managerName: string
): ActiveKpiRecord {
  const previous = previousState?.active_kpis?.[stage];
  const captured = lead.kpiFields?.[stage];
  const history = lead.stageHistory?.[stage];
  const row = previousState?.kp_rows[stage]?.payload ?? previousState?.zp_rows[stage]?.payload;
  const occurredAt = history?.occurredAt ?? processedAt;

  return {
    stage,
    label: KPI_STAGE_META[stage].label,
    amount,
    date: captured?.date ?? previous?.date ?? row?.date ?? formatDisplayDate(occurredAt),
    time: previous?.time ?? row?.time ?? formatDisplayTime(occurredAt),
    manager: captured?.manager ?? previous?.manager ?? history?.manager ?? managerName
  };
}

function createSheetRow(lead: AmoLeadSnapshot, record: ActiveKpiRecord): SheetRowPayload {
  return {
    stage: record.stage,
    date: record.date,
    time: record.time,
    kpiLabel: record.label,
    leadName: lead.name,
    amount: record.amount,
    link: lead.link,
    dealId: lead.id,
    installDate: record.stage === "install" ? record.date : null
  };
}

function areSheetRowsEqual(left: SheetRowPayload | undefined, right: SheetRowPayload | undefined): boolean {
  if (!left || !right) {
    return false;
  }

  // JSONB does not preserve property order when rows are read back from Postgres.
  const keys: Array<keyof SheetRowPayload> = [
    "stage", "date", "time", "kpiLabel", "leadName", "amount", "link", "dealId", "installDate"
  ];
  return keys.every((key) => left[key] === right[key]);
}

function calculateKpiAmount(budget: number): number {
  const normalizedBudget = Number.isFinite(budget) ? Math.max(0, budget) : 0;

  return Math.round(normalizedBudget * 0.08);
}

function buildActiveKpis(
  lead: AmoLeadSnapshot,
  previousState: StoredDealState | null,
  processedAt: string,
  managerName: string
): Partial<Record<KpiStage, ActiveKpiRecord>> {
  const activeKpis: Partial<Record<KpiStage, ActiveKpiRecord>> = {};
  const rule = lead.objectType ? OBJECT_TYPE_RULES[lead.objectType] : undefined;

  if (!rule) {
    return activeKpis;
  }

  const statusSort = getStatusSort(lead.statusId);
  const amount = calculateKpiAmount(lead.budget);

  for (const stage of KPI_STAGE_ORDER) {
    if (!rule[stage]) {
      continue;
    }

    if (statusSort < KPI_STAGE_META[stage].reachedSort) {
      continue;
    }

    activeKpis[stage] = buildStageRecord(stage, amount, lead, previousState, processedAt, managerName);
  }

  return activeKpis;
}

function buildAmoFieldPatch(
  lead: AmoLeadSnapshot,
  previousState: StoredDealState | null,
  nextActiveKpis: Partial<Record<KpiStage, ActiveKpiRecord>>,
  isRefused: boolean,
  processedAt: string,
  managerName: string
): AmoFieldMutation[] {
  const mutations: AmoFieldMutation[] = [];

  for (const stage of KPI_STAGE_ORDER) {
    // Compare with actual CRM fields so a retry can also repair partial syncs.
    const previous = lead.kpiFields !== undefined ? lead.kpiFields[stage] : previousState?.active_kpis?.[stage];
    const next = nextActiveKpis[stage];
    const { fieldIds } = KPI_STAGE_META[stage];

    if (next) {
      if (!previous || previous.date !== next.date) {
        mutations.push({
          fieldId: fieldIds.date,
          value: next.date
        });
      }

      if (!previous || previous.manager !== next.manager) {
        mutations.push({
          fieldId: fieldIds.manager,
          value: next.manager
        });
      }

      if (!previous || previous.amount !== next.amount) {
        mutations.push({
          fieldId: fieldIds.money,
          value: next.amount
        });
      }
      continue;
    }

    // Keep capture dates/managers even for stages that do not pay for this object type.
    if (!isRefused && !previousState?.is_frozen && lead.statusId === KPI_STAGE_META[stage].reachedStatusId) {
      const history = lead.stageHistory?.[stage];
      if (!previous?.date) {
        mutations.push({ fieldId: fieldIds.date, value: formatDisplayDate(history?.occurredAt ?? processedAt) });
      }
      if (!previous?.manager) {
        mutations.push({ fieldId: fieldIds.manager, value: history?.manager ?? managerName });
      }
    }

    if (previous?.amount !== 0 && (previous || isRefused || lead.kpiFields !== undefined)) {
      mutations.push({
        fieldId: fieldIds.money,
        value: 0
      });
    }
  }

  const unique = new Map<number, AmoFieldMutation>();
  for (const mutation of mutations) {
    unique.set(mutation.fieldId, mutation);
  }

  return [...unique.values()];
}

function buildSheetRows(
  lead: AmoLeadSnapshot,
  activeKpis: Partial<Record<KpiStage, ActiveKpiRecord>>,
  sheetName: SheetName,
  includeRows: boolean
): SheetRowPayload[] {
  if (!includeRows) {
    return [];
  }

  return KPI_STAGE_ORDER.flatMap((stage) => {
    const record = activeKpis[stage];
    if (!record) {
      return [];
    }

    const row = createSheetRow(lead, record);

    if (sheetName === "ЗП new") {
      return [
        {
          ...row,
          time: null
        }
      ];
    }

    return [row];
  });
}

export function deriveLeadKpiState(params: {
  lead: AmoLeadSnapshot;
  previousState: StoredDealState | null;
  processedAt: string;
  managerName: string;
}): LeadKpiState {
  const { lead, previousState, processedAt, managerName } = params;
  const isRefused = lead.statusId === AMO_STATUS.REFUSED;
  const wasFrozen = previousState?.is_frozen ?? false;
  const shouldFreezeNow = lead.statusId === AMO_STATUS.COMMISSION_RECEIVED;

  let activeKpis: Partial<Record<KpiStage, ActiveKpiRecord>>;
  let objectType = lead.objectType;
  let isFrozen = wasFrozen || shouldFreezeNow;

  if (isRefused) {
    activeKpis = {};
    isFrozen = previousState?.is_frozen ?? false;
  } else if (wasFrozen) {
    activeKpis = previousState?.active_kpis ?? {};
    objectType = previousState?.object_type ?? lead.objectType;
  } else {
    activeKpis = buildActiveKpis(lead, previousState, processedAt, managerName);
  }

  const amoFieldsPatch = buildAmoFieldPatch(lead, previousState, activeKpis, isRefused, processedAt, managerName);
  const includeSalaryRows = !isRefused && (
    SALARY_TRIGGER_STATUS_IDS.has(lead.statusId) || Object.keys(previousState?.zp_rows ?? {}).length > 0
  );

  return {
    dealId: lead.id,
    objectType,
    isFrozen,
    activeKpis,
    amoFieldsPatch,
    sheetRowsKpNew: buildSheetRows(lead, activeKpis, "KP new", !isRefused),
    sheetRowsZpNew: buildSheetRows(lead, activeKpis, "ЗП new", includeSalaryRows)
  };
}

export function buildSheetSyncJobs(params: {
  lead: AmoLeadSnapshot;
  previousState: StoredDealState | null;
  nextState: LeadKpiState;
}): Array<{
  deal_id: number;
  sheet_name: SheetName;
  job_type: string;
  row_key: string;
  payload: {
    stage: KpiStage;
    rowIndex: number | null;
    row: SheetRowPayload;
  };
}> {
  const { lead, previousState, nextState } = params;
  const jobs: Array<{
    deal_id: number;
    sheet_name: SheetName;
    job_type: string;
    row_key: string;
    payload: {
      stage: KpiStage;
      rowIndex: number | null;
      row: SheetRowPayload;
    };
  }> = [];

  const buildDesiredMap = (rows: SheetRowPayload[]) =>
    Object.fromEntries(rows.map((row) => [row.stage, row])) as Partial<Record<KpiStage, SheetRowPayload>>;

  const desiredKpRows = buildDesiredMap(nextState.sheetRowsKpNew);
  const desiredZpRows = buildDesiredMap(nextState.sheetRowsZpNew);
  const previousKpRows = previousState?.kp_rows ?? {};
  const previousZpRows = previousState?.zp_rows ?? {};

  for (const stage of KPI_STAGE_ORDER) {
    const desired = desiredKpRows[stage];
    const previous = previousKpRows[stage];

    if (desired) {
      if (previous?.rowIndex && areSheetRowsEqual(previous.payload, desired)) {
        continue;
      }

      jobs.push({
        deal_id: lead.id,
        sheet_name: "KP new",
        job_type: previous ? "upsert" : "append",
        row_key: `${lead.id}:KP new:${stage}`,
        payload: {
          stage,
          rowIndex: previous?.rowIndex ?? null,
          row: desired
        }
      });
    } else if (previous && previous.payload.amount !== 0) {
      jobs.push({
        deal_id: lead.id,
        sheet_name: "KP new",
        job_type: "zero",
        row_key: `${lead.id}:KP new:${stage}`,
        payload: {
          stage,
          rowIndex: previous.rowIndex,
          row: {
            ...previous.payload,
            amount: 0
          }
        }
      });
    }
  }

  for (const stage of KPI_STAGE_ORDER) {
    const desired = desiredZpRows[stage];
    const previous = previousZpRows[stage];

    if (desired) {
      if (previous?.rowIndex && areSheetRowsEqual(previous.payload, desired)) {
        continue;
      }

      jobs.push({
        deal_id: lead.id,
        sheet_name: "ЗП new",
        job_type: previous ? "upsert" : "append",
        row_key: `${lead.id}:ЗП new:${stage}`,
        payload: {
          stage,
          rowIndex: previous?.rowIndex ?? null,
          row: desired
        }
      });
    } else if (previous && lead.statusId === AMO_STATUS.REFUSED && previous.payload.amount !== 0) {
      jobs.push({
        deal_id: lead.id,
        sheet_name: "ЗП new",
        job_type: "zero",
        row_key: `${lead.id}:ЗП new:${stage}`,
        payload: {
          stage,
          rowIndex: previous.rowIndex,
          row: {
            ...previous.payload,
            amount: 0
          }
        }
      });
    }
  }

  return jobs;
}
