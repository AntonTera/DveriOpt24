import { google } from "googleapis";
import { getServerEnv } from "@/lib/env";
import { formatDisplayDate } from "@/lib/utils/datetime";
import type { getDutyConfig } from "./config";
import type { RoutingCrm } from "./crm";
import { selectDutyOwner } from "./roster";

const SHIFT_RANGE = "'\u0413\u0440\u0430\u0444\u0438\u043a \u0440\u0430\u0431\u043e\u0442\u044b'!A:C";

export function createDutyLookup(
  config: ReturnType<typeof getDutyConfig>,
  crm: Pick<RoutingCrm, "isUserActive">,
  signal: AbortSignal
) {
  let cached: { day: string; ownerId: number | null } | undefined;
  return async (now: Date) => {
    const day = formatDisplayDate(now);
    if (cached?.day === day) return cached.ownerId;

    signal.throwIfAborted();
    const env = getServerEnv();
    const auth = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    const response = await google.sheets({ version: "v4", auth }).spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId, range: SHIFT_RANGE, valueRenderOption: "FORMATTED_VALUE"
    }, { signal, timeout: 5_000, retry: false });
    const shift = selectDutyOwner(response.data.values ?? [], day, config.svetlanaId);
    const ownerId = shift && await crm.isUserActive(shift.ownerId) ? shift.ownerId : null;
    cached = { day, ownerId };
    return ownerId;
  };
}
