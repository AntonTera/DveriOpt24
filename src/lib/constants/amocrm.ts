import { KpiStage } from "@/lib/types";

export type AmoKpiStage = KpiStage;

export const AMOCRM_ACCOUNT_BASE_URL = "https://dveriopt24.amocrm.ru";
export const MAIN_PIPELINE_ID = 4908391;

export const AMO_STATUS = {
  WORK: 44423710,
  MEASURE: 44423716,
  INSTALL: 44616253,
  SALARY_RECONCILED: 44616256,
  COMMISSION_RECEIVED: 142,
  REFUSED: 143
} as const;

export const AMO_STATUS_SORT = {
  [AMO_STATUS.WORK]: 20,
  [AMO_STATUS.MEASURE]: 40,
  [AMO_STATUS.INSTALL]: 70,
  [AMO_STATUS.SALARY_RECONCILED]: 90,
  [AMO_STATUS.COMMISSION_RECEIVED]: 10000,
  [AMO_STATUS.REFUSED]: 11000
} as const;

export const TYPE_OBJECT_FIELD_ID = 1020845;

export const TYPE_OBJECT_ENUMS = {
  "Межкомнатная": 554403,
  "Входная": 554405,
  "Откосы": 685515,
  "Входная нестандарт": 741585,
  "Козырьки": 743144
} as const;

export const ALLOWED_RESPONSIBLE_USER_NAMES = new Set(["Филипп", "Людмила"]);
export const EXCLUDED_RESPONSIBLE_USER_ID = 8445565;
export const AMO_KPI_MANAGER_NAME_BY_USER_ID: Record<number, string> = {
  7268314: "Филипп",
  12043998: "Людмила"
};

export const KPI_FIELD_IDS = {
  work: {
    date: 1164525,
    manager: 1164527,
    money: 1164529
  },
  measure: {
    date: 1164531,
    manager: 1164533,
    money: 1164535
  },
  install: {
    date: 1164537,
    manager: 1164539,
    money: 1164541
  }
} as const;

export const OBJECT_TYPE_RULES: Record<string, Partial<Record<KpiStage, true>>> = {
  "Входная": {
    measure: true,
    install: true
  },
  "Межкомнатная": {
    work: true
  },
  "Откосы": {
    work: true
  },
  "Козырьки": {
    work: true
  },
  "Входная нестандарт": {
    work: true
  }
};

export const KPI_STAGE_META: Record<
  KpiStage,
  {
    label: string;
    reachedStatusId: number;
    reachedSort: number;
    fieldIds: (typeof KPI_FIELD_IDS)[KpiStage];
  }
> = {
  work: {
    label: "В работу",
    reachedStatusId: AMO_STATUS.WORK,
    reachedSort: 20,
    fieldIds: KPI_FIELD_IDS.work
  },
  measure: {
    label: "Замер",
    reachedStatusId: AMO_STATUS.MEASURE,
    reachedSort: 40,
    fieldIds: KPI_FIELD_IDS.measure
  },
  install: {
    label: "Монтаж",
    reachedStatusId: AMO_STATUS.INSTALL,
    reachedSort: 70,
    fieldIds: KPI_FIELD_IDS.install
  }
};

export const KPI_STAGE_ORDER: KpiStage[] = ["work", "measure", "install"];
export const SALARY_TRIGGER_STATUS_IDS = new Set<number>([
  AMO_STATUS.SALARY_RECONCILED,
  AMO_STATUS.COMMISSION_RECEIVED
]);
export const AMO_KPI_SUPPORTED_STATUS_IDS = new Set<number>([
  AMO_STATUS.WORK,
  AMO_STATUS.MEASURE,
  AMO_STATUS.INSTALL,
  AMO_STATUS.SALARY_RECONCILED,
  AMO_STATUS.REFUSED
]);
export const AMO_KPI_STAGE_BY_STATUS: Partial<Record<number, AmoKpiStage>> = {
  [AMO_STATUS.WORK]: "work",
  [AMO_STATUS.MEASURE]: "measure",
  [AMO_STATUS.INSTALL]: "install"
};

export function getStatusSort(statusId: number | null | undefined): number {
  if (!statusId) {
    return 0;
  }

  return AMO_STATUS_SORT[statusId as keyof typeof AMO_STATUS_SORT] ?? 0;
}
