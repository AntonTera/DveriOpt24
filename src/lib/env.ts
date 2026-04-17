import { z } from "zod";

const serverEnvSchema = z.object({
  AMOCRM_BASE_URL: z.string().url().default("https://dveriopt24.amocrm.ru"),
  AMOCRM_LONG_LIVED_TOKEN: z.string().min(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: z.string().email(),
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z.string().min(1),
  GOOGLE_SHEETS_SPREADSHEET_ID: z.string().min(1),
  GOOGLE_SHEETS_KP_TAB: z.string().default("KP new"),
  GOOGLE_SHEETS_ZP_TAB: z.string().default("ЗП new"),
  WEBHOOK_SHARED_SECRET: z.string().optional(),
  CRON_SECRET: z.string().optional()
});

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1];
    const normalized = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const decoded = Buffer.from(normalized, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);

    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function assertSupabaseServiceRoleKey(key: string) {
  const payload = parseJwtPayload(key);
  const role = typeof payload?.role === "string" ? payload.role : null;

  if (role && role !== "service_role") {
    throw new Error(
      `SUPABASE_SERVICE_ROLE_KEY must be a Supabase service_role key, but received role "${role}".`
    );
  }
}

export function getServerEnv() {
  const env = serverEnvSchema.parse(process.env);
  assertSupabaseServiceRoleKey(env.SUPABASE_SERVICE_ROLE_KEY);

  return {
    ...env,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(
      /\\n/g,
      "\n"
    )
  };
}
