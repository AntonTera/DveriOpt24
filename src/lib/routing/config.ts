import { timingSafeEqual } from "node:crypto";
import { EXCLUDED_RESPONSIBLE_USER_ID } from "@/lib/constants/amocrm";
import { FORMER_DUTY_OWNER_ID } from "./handlers";
import { PHILIPP_ID } from "./roster";

export const isRoutingEnabled = () => process.env.CRM_ROUTING_ENABLED === "true";
export const isShiftRotationEnabled = () => process.env.CRM_SHIFT_ROTATION_ENABLED === "true";
export const isCloseDateEnabled = () => process.env.CRM_CLOSE_DATE_ENABLED === "true";

export function getDutyConfig() {
  const spreadsheetId = process.env.CRM_SHIFT_SPREADSHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("CRM shift spreadsheet is not configured");

  const configuredId = process.env.CRM_SVETLANA_USER_ID?.trim();
  const svetlanaId = configuredId ? Number(configuredId) : undefined;
  if (svetlanaId !== undefined && (!/^\d+$/.test(configuredId!) || !Number.isSafeInteger(svetlanaId) ||
      svetlanaId <= 0 || [PHILIPP_ID, FORMER_DUTY_OWNER_ID, EXCLUDED_RESPONSIBLE_USER_ID].includes(svetlanaId))) {
    throw new Error("Invalid CRM shift user configuration");
  }
  return { spreadsheetId, svetlanaId, dutyOwnerIds: svetlanaId ? [PHILIPP_ID, svetlanaId] : [PHILIPP_ID] };
}

export function matchesSecret(value: string | null, expected: string | undefined) {
  if (!value || !expected) return false;
  const actual = Buffer.from(value);
  const secret = Buffer.from(expected);
  return actual.length === secret.length && timingSafeEqual(actual, secret);
}
