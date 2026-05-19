import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    AMOCRM_BASE_URL: "https://dveriopt24.amocrm.ru",
    AMOCRM_LONG_LIVED_TOKEN: "token",
    AMOCRM_MIN_REQUEST_INTERVAL_MS: 220,
    AMOCRM_MAX_RETRIES: 4,
    AMOCRM_RETRY_BASE_DELAY_MS: 500,
    AMOCRM_RETRY_MAX_DELAY_MS: 5000
  })
}));

vi.mock("@/lib/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined)
}));

import { fetchLead, patchLeadCustomFields, resetAmoClientStateForTests } from "@/lib/amocrm/client";
import { sleep } from "@/lib/utils/sleep";

const sleepMock = vi.mocked(sleep);

function makeJsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
      }
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body))
  } as unknown as Response;
}

describe("amocrm client retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAmoClientStateForTests();
  });

  it("retries temporary amoCRM errors and respects retry-after", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeJsonResponse("busy", 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(
        makeJsonResponse({
          id: 42,
          name: "Deal",
          price: 100000,
          updated_at: 1776410000,
          pipeline_id: 4908391,
          status_id: 44423716,
          responsible_user_id: 12043998,
          custom_fields_values: []
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const lead = await fetchLead(42);

    expect(lead.id).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(2000);
  });

  it("retries network failures before succeeding", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(makeJsonResponse({}, 200));

    vi.stubGlobal("fetch", fetchMock);

    await patchLeadCustomFields(42, [{ fieldId: 1164529, value: 0 }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(500);
  });

  it("does not retry non-retryable amoCRM responses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeJsonResponse("bad request", 400));

    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchLead(42)).rejects.toThrow("amoCRM request failed (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
