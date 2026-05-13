import { describe, expect, it } from "vitest";

import { AMO_STATUS } from "@/lib/constants/amocrm";
import { buildAmoKpiPatch } from "@/lib/domain/amocrm-kpi";
import { AmoLeadSnapshot } from "@/lib/types";

function buildLead(overrides: Partial<AmoLeadSnapshot> = {}): AmoLeadSnapshot {
  return {
    id: 99,
    name: "Сделка KPI",
    budget: 125000,
    updatedAt: "2026-05-13T09:00:00.000Z",
    pipelineId: 4908391,
    statusId: AMO_STATUS.WORK,
    responsibleUserId: 12043998,
    objectType: "Входная",
    link: "https://dveriopt24.amocrm.ru/leads/detail/99",
    ...overrides
  };
}

describe("buildAmoKpiPatch", () => {
  it("creates work patch for work status", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.WORK,
      managerName: "Людмила"
    });

    expect(result).toEqual({
      scenario: "work_kpi_capture",
      mutations: [
        { fieldId: 1164525, value: "13.05.2026" },
        { fieldId: 1164527, value: "Людмила" },
        { fieldId: 1164529, value: 10000 }
      ]
    });
  });

  it("creates measure patch only for measure status", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.MEASURE,
      managerName: "Филипп"
    });

    expect(result?.scenario).toBe("measure_kpi_capture");
    expect(result?.mutations).toEqual([
      { fieldId: 1164531, value: "13.05.2026" },
      { fieldId: 1164533, value: "Филипп" },
      { fieldId: 1164535, value: 10000 }
    ]);
  });

  it("creates install patch only for install status", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.INSTALL,
      managerName: "Филипп"
    });

    expect(result?.scenario).toBe("install_kpi_capture");
    expect(result?.mutations).toEqual([
      { fieldId: 1164537, value: "13.05.2026" },
      { fieldId: 1164539, value: "Филипп" },
      { fieldId: 1164541, value: 10000 }
    ]);
  });

  it("recalculates only money fields on salary reconciled", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.SALARY_RECONCILED,
      managerName: null
    });

    expect(result).toEqual({
      scenario: "salary_reconciled_recalculation",
      mutations: [
        { fieldId: 1164529, value: 10000 },
        { fieldId: 1164535, value: 10000 },
        { fieldId: 1164541, value: 10000 }
      ]
    });
  });

  it("zeroes only money fields on refused status", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.REFUSED,
      managerName: null
    });

    expect(result).toEqual({
      scenario: "refused_zero_amounts",
      mutations: [
        { fieldId: 1164529, value: 0 },
        { fieldId: 1164535, value: 0 },
        { fieldId: 1164541, value: 0 }
      ]
    });
  });

  it("returns null for unsupported status", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: 999999,
      managerName: "Людмила"
    });

    expect(result).toBeNull();
  });

  it("returns null for unknown manager on capture statuses", () => {
    const result = buildAmoKpiPatch({
      lead: buildLead(),
      statusId: AMO_STATUS.MEASURE,
      managerName: null
    });

    expect(result).toBeNull();
  });

  it("is idempotent for repeated work status processing", () => {
    const lead = buildLead();

    const first = buildAmoKpiPatch({
      lead,
      statusId: AMO_STATUS.WORK,
      managerName: "Людмила"
    });
    const second = buildAmoKpiPatch({
      lead,
      statusId: AMO_STATUS.WORK,
      managerName: "Людмила"
    });

    expect(first).toEqual(second);
  });
});
