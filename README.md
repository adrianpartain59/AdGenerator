# AI Ad Studio

A ChatGPT-style studio for making **moving social ads**. Describe the ad you want —
or paste an example ad and your app screenshots — and a Gemini agent builds it for
you: layout, copy, animations, brand-new imagery, and 3D iPhone mockups. When it's
done you drop into a full editor with complete manual control over every element,
then export an MP4.

No build step — vanilla ES modules + the HTML5 Canvas, plus Three.js (3D mockups) and
Supabase (accounts + cloud storage), all loaded from CDNs.

---

## What it does

- **Chat → ad.** Tell the agent what you want; it returns ad copy and a fully
  composed, animated scene that loads straight into the editor.
- **Use your assets.** Paste/drag/upload logos, product shots, screenshots, and
  example ads. The agent references them by name and matches the example's style.
- **AI imagery.** Ask for backgrounds or visuals and the agent generates them
  (Gemini image model), adding the result to your asset library.
- **3D iPhone mockups.** Drop in a UI screenshot and the agent (or you, via the 📱
  button on any asset) wraps it onto a posed iPhone 17 Pro and uses it in the ad.
- **Full editor.** Live preview/scrub, click-to-select layers, position/scale/rotate,
  z-order, undo/redo, autosave — then **Export MP4 (4K)**.
- **Accounts + cloud saving.** Sign in; every project, asset, and conversation is
  saved to your Supabase project and synced across devices.

---

## Setup

1. **Supabase + Gemini** — follow [`supabase/README.md`](supabase/README.md): create a
   project, run `schema.sql`, paste your URL + anon key into
   [`src/supabaseClient.js`](src/supabaseClient.js), set the `GEMINI_API_KEY` secret,
   and `supabase functions deploy ai-agent`.
2. **Run it locally** — a local server is required (ESM modules, the 3D `.glb`/`.exr`,
   and un-tainted canvas export all need HTTP, not `file://`):

   ```bash
   ./start.sh           # serves http://localhost:8000 and opens it
   ./start.sh 9000      # or pick a port
   ```

3. **Sign in** and start a project. Type a request in chat, or paste an example ad.

---

## Architecture

```
Browser (vanilla ESM)
  src/auth.js          email+password gate (Supabase)
  src/main.js          bootstrap: sidebar ↔ chat ↔ editor over one project
  src/chat.js          ChatGPT-style chat; calls the ai-agent function, runs
                       client-side tool actions (3D mockups), loads the result
  src/editor.js        canvas preview, transform/layer editor, undo/redo, MP4 export
  src/engine.js        the scene renderer + animation engine (the ad format)
  src/mockup.js        Three.js iPhone mockup — headless render + manual modal
  src/store.js         Supabase-backed projects / assets / messages

Supabase
  Auth · Postgres (projects, assets, messages) · Storage (private `assets` bucket)
  functions/ai-agent   Gemini agent: writes the scene, generates images, asks the
                       browser for mockups. Gemini key stays server-side.
```

A **scene** is `{ width, height, duration, fps, background, layers[] }`; layers are
`image | text | button`, each with an `animations[]` array. That's the exact JSON the
agent emits and the editor edits — see [`src/engine.js`](src/engine.js) for the full
schema and the easing list.

---

## Export

**Export MP4 (4K)** renders every frame off-screen with WebCodecs (H.264) and
downloads an `.mp4` (falls back to `.webm` where WebCodecs is unavailable).

---

## Files

| Area | Files |
| ---- | ----- |
| App shell | `index.html`, `styles.css`, `src/main.js` |
| AI chat | `src/chat.js`, `supabase/functions/ai-agent/index.ts` |
| Editor + engine | `src/editor.js`, `src/engine.js` |
| 3D mockup | `src/mockup.js`, `assets/3d/` |
| Data + auth | `src/store.js`, `src/auth.js`, `src/supabaseClient.js`, `supabase/schema.sql` |
| Dev server | `server.py`, `start.sh` |
