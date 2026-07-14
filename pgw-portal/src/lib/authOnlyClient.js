import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/* A throwaway Supabase client used ONLY for signing up new users.
   persistSession: false keeps it from ever touching localStorage, so
   creating a login here can never overwrite the master's own session
   (which lives on the main `supabase` client in supabaseClient.js). */
export const authOnlyClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
