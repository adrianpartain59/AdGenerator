# Supabase setup — AI Ad Studio

The app needs a Supabase project for **auth**, **project/asset/chat storage**, and
the **`ai-agent` edge function** (which holds your Gemini key as a secret). One-time
setup, ~5 minutes.

## 1. Create the project
Create a new project at [supabase.com](https://supabase.com) (free tier is fine).
From **Project Settings → API**, copy the **Project URL** and the **anon public**
key into [`src/supabaseClient.js`](../src/supabaseClient.js).

## 2. Create the schema
Open **SQL Editor → New query**, paste the contents of
[`schema.sql`](schema.sql), and run it. This creates the `projects`, `assets`, and
`messages` tables (all owner-only via Row Level Security) and a private `assets`
storage bucket.

## 3. Simplest auth flow
**Authentication → Sign In / Providers → Email** → turn **off** "Confirm email" so
sign-up logs you straight in. (Leave it on to verify addresses; then set
**Authentication → URL Configuration → Site URL** to your deployed URL.)

## 4. Deploy the AI edge function
Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo
root:

```bash
supabase login
supabase link --project-ref <your-project-ref>

# Your Gemini key (https://aistudio.google.com/apikey) — stays server-side only.
supabase secrets set GEMINI_API_KEY=your_gemini_key
# Optional model overrides (defaults shown):
# supabase secrets set GEMINI_TEXT_MODEL=gemini-2.5-flash
# supabase secrets set GEMINI_IMAGE_MODEL=gemini-2.5-flash-image

supabase functions deploy ai-agent
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are injected
into the function automatically — you don't set those.

### Local function dev (optional)
```bash
supabase functions serve ai-agent --env-file ./supabase/.env
```
with `GEMINI_API_KEY=...` in `supabase/.env`. Point the client at the local URL if
you serve it this way; otherwise the deployed function works in local dev too.

## What the function does
`ai-agent` runs a Gemini loop that authors the ad as a `scene` JSON object, can
**generate/edit images** (server-side, uploaded to your `assets` bucket), and can ask
the browser to **render a 3D iPhone mockup**. The Gemini key never reaches the client.
