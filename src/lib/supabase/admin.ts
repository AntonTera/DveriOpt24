import { createClient } from "@supabase/supabase-js";

import { getServerEnv } from "@/lib/env";

export function getSupabaseAdmin() {
  const env = getServerEnv();

  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
