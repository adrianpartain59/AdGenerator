// ============================================================================
//  Supabase client (browser).
//  The URL + anon key are safe to ship in client-side code — access is enforced
//  server-side by Row Level Security, not by hiding the key. NEVER put the
//  project's `service_role` key here; that one bypasses RLS (it belongs only in
//  the edge function's secrets).
//
//  >>> FILL THESE IN with your new Supabase project's values
//      (Dashboard → Project Settings → API). <<<
// ============================================================================
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://vbnczmeqsfatbyekxqyd.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZibmN6bWVxc2ZhdGJ5ZWt4cXlkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA4NzkyNDksImV4cCI6MjA5NjQ1NTI0OX0.87c3hI7S50ccQf2aLEbM3l54uFgPCZT9rzB2txvQbIs";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// True until the placeholders above are replaced — lets the UI show a helpful
// setup message instead of a stream of failed network calls.
export const isConfigured =
  !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.includes("YOUR-ANON");
