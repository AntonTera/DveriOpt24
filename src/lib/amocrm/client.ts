import {
  AMOCRM_ACCOUNT_BASE_URL,
  TYPE_OBJECT_FIELD_ID
} from "@/lib/constants/amocrm";
import { getServerEnv } from "@/lib/env";
import { AmoLeadSnapshot, AmoFieldMutation } from "@/lib/types";
import { displayDateToUnix } from "@/lib/utils/datetime";

interface AmoLeadResponse {
  id: number;
  name: string;
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

async function amoFetch(path: string, init?: RequestInit) {
  const env = getServerEnv();
  const response = await fetch(`${env.AMOCRM_BASE_URL ?? AMOCRM_ACCOUNT_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...getAuthHeaders(),
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`amoCRM request failed (${response.status}): ${body}`);
  }

  return response;
}

function extractObjectType(lead: AmoLeadResponse): string | null {
  const field = lead.custom_fields_values?.find((entry) => entry.field_id === TYPE_OBJECT_FIELD_ID);
  const value = field?.values?.[0]?.value;

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export async function fetchLead(leadId: number): Promise<AmoLeadSnapshot> {
  const response = await amoFetch(`/api/v4/leads/${leadId}`);
  const lead = (await response.json()) as AmoLeadResponse;

  return {
    id: lead.id,
    name: lead.name,
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
