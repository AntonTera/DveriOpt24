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

export function getServerEnv() {
  const env = serverEnvSchema.parse(process.env);

  return {
    ...env,
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(
      /\\n/g,
      "\n"
    )
  };
}
