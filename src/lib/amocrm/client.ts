import {
  AMOCRM_ACCOUNT_BASE_URL,
  TYPE_OBJECT_FIELD_ID
} from "@/lib/constants/amocrm";
import { getServerEnv } from "@/lib/env";
import { AmoLeadSnapshot, AmoFieldMutation } from "@/lib/types";
import { sleep } from "@/lib/utils/sleep";
import { displayDateToUnix } from "@/lib/utils/datetime";

interface AmoLeadResponse {
  id: number;
  name: string;
  price?: number | null;
  updated_at?: number | null;
  pipeline_id: number;
  status_id: number;
  responsible_user_id: number | null;
  custom_fields_values?: Array<{
    field_id: number;
    values: Array<{
      value?: string | number;
      enum_id?: number;
    }>;
  }>;
}

function getAuthHeaders() {
  const env = getServerEnv();

  return {
    Authorization: `Bearer ${env.AMOCRM_LONG_LIVED_TOKEN}`,
    "Content-Type": "application/json"
  };
}

const RETRYABLE_AMOCRM_STATUS_CODES = new Set([408, 429, 502, 503, 504]);

let amoRequestQueue: Promise<void> = Promise.resolve();
let nextAllowedAmoRequestAt = 0;

class AmoCrmResponseError extends Error {}

function getRetryDelayMs(attempt: number, retryAfterHeader: string | null) {
  const env = getServerEnv();

  if (retryAfterHeader) {
    const retryAfterSeconds = Number(retryAfterHeader);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
      return Math.min(env.AMOCRM_RETRY_MAX_DELAY_MS, retryAfterSeconds * 1000);
    }

    const retryAfterDate = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryAfterDate)) {
      return Math.min(env.AMOCRM_RETRY_MAX_DELAY_MS, Math.max(0, retryAfterDate - Date.now()));
    }
  }

  return Math.min(
    env.AMOCRM_RETRY_MAX_DELAY_MS,
    env.AMOCRM_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1)
  );
}

async function waitForAmoRateLimitSlot() {
  const env = getServerEnv();
  const waitMs = Math.max(0, nextAllowedAmoRequestAt - Date.now());

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  nextAllowedAmoRequestAt = Date.now() + env.AMOCRM_MIN_REQUEST_INTERVAL_MS;
}

async function runAmoRequestWithRateLimit<T>(request: () => Promise<T>) {
  const scheduled = amoRequestQueue.then(async () => {
    await waitForAmoRateLimitSlot();
    return request();
  });

  amoRequestQueue = scheduled.then(
    () => undefined,
    () => undefined
  );

  return scheduled;
}

function isRetryableAmoFetchError(error: unknown) {
  return error instanceof Error;
}

async function amoFetch(path: string, init?: RequestInit) {
  const env = getServerEnv();
  let attempt = 0;

  while (attempt <= env.AMOCRM_MAX_RETRIES) {
    attempt += 1;

    try {
      const response = await runAmoRequestWithRateLimit(() =>
        fetch(`${env.AMOCRM_BASE_URL ?? AMOCRM_ACCOUNT_BASE_URL}${path}`, {
          ...init,
          headers: {
            ...getAuthHeaders(),
            ...(init?.headers ?? {})
          },
          cache: "no-store"
        })
      );

      if (response.ok) {
        return response;
      }

      const body = await response.text();
      const canRetry =
        RETRYABLE_AMOCRM_STATUS_CODES.has(response.status) &&
        attempt <= env.AMOCRM_MAX_RETRIES;

      if (canRetry) {
        await sleep(getRetryDelayMs(attempt, response.headers.get("retry-after")));
        continue;
      }

      throw new AmoCrmResponseError(`amoCRM request failed (${response.status}): ${body}`);
    } catch (error) {
      if (error instanceof AmoCrmResponseError) {
        throw error;
      }

      const canRetry = isRetryableAmoFetchError(error) && attempt <= env.AMOCRM_MAX_RETRIES;

      if (canRetry) {
        await sleep(getRetryDelayMs(attempt, null));
        continue;
      }

      throw error;
    }
  }

  throw new Error("amoCRM request retries exhausted");
}

function extractObjectType(lead: AmoLeadResponse): string | null {
  const field = lead.custom_fields_values?.find((entry) => entry.field_id === TYPE_OBJECT_FIELD_ID);
  const value = field?.values?.[0]?.value;

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeUpdatedAt(value: number | null | undefined): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  return new Date().toISOString();
}

export async function fetchLead(leadId: number): Promise<AmoLeadSnapshot> {
  const response = await amoFetch(`/api/v4/leads/${leadId}`);
  const lead = (await response.json()) as AmoLeadResponse;

  return {
    id: lead.id,
    name: lead.name,
    budget: typeof lead.price === "number" && Number.isFinite(lead.price) ? lead.price : 0,
    updatedAt: normalizeUpdatedAt(lead.updated_at),
    pipelineId: lead.pipeline_id,
    statusId: lead.status_id,
    responsibleUserId: lead.responsible_user_id,
    objectType: extractObjectType(lead),
    link: `${AMOCRM_ACCOUNT_BASE_URL}/leads/detail/${lead.id}`
  };
}

export async function fetchUserName(userId: number | null): Promise<string> {
  if (!userId) {
    return "Не назначен";
  }

  const response = await amoFetch(`/api/v4/users/${userId}`);
  const payload = (await response.json()) as { id: number; name: string };

  return payload.name;
}

function formatMutationValue(fieldId: number, value: string | number) {
  if (
    fieldId === 1164525 ||
    fieldId === 1164531 ||
    fieldId === 1164537
  ) {
    return displayDateToUnix(String(value));
  }

  return value;
}

export async function patchLeadCustomFields(leadId: number, mutations: AmoFieldMutation[]) {
  if (mutations.length === 0) {
    return;
  }

  const customFieldsValues = mutations.map((mutation) => ({
    field_id: mutation.fieldId,
    values: [
      {
        value: formatMutationValue(mutation.fieldId, mutation.value)
      }
    ]
  }));

  await amoFetch("/api/v4/leads", {
    method: "PATCH",
    body: JSON.stringify([
      {
        id: leadId,
        custom_fields_values: customFieldsValues
      }
    ])
  });
}

export function resetAmoClientStateForTests() {
  amoRequestQueue = Promise.resolve();
  nextAllowedAmoRequestAt = 0;
}
