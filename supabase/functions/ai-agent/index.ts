// ============================================================================
//  ai-agent — Supabase Edge Function (Deno)
//
//  The brain of the AI Ad Studio. Runs a Gemini agent loop that:
//    • reads the user's chat, the current scene, uploaded assets + example ads
//    • writes the ad as a `scene` JSON object (the exact shape engine.js renders)
//    • can generate / edit brand-new imagery server-side (Gemini image model),
//      uploading the result straight into the user's private `assets` bucket
//    • can ask the browser to render a 3D iPhone mockup (a client-side action)
//
//  The Gemini key never leaves the server. The caller is authenticated with
//  their Supabase JWT; image bytes are written with the service-role key under
//  the caller's own folder so Storage RLS still lines up.
//
//  Protocol (JSON over POST):
//    Request:  { projectId, history[], scene, assets[], toolResults? }
//    Response: { type:"final",  reply, scene }
//          or  { type:"tool_calls", reply, clientActions[], history[] }
//
//  history entries: { role:"user"|"model", text?, json?, attachments?[] }
//  An assistant turn is a JSON envelope:
//    { reply, actions[], scene, done }
//      actions: { type:"generate_image"|"edit_image"|"render_iphone_mockup", ... }
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const TEXT_MODEL = Deno.env.get("GEMINI_TEXT_MODEL") ?? "gemini-2.5-flash";
const IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-2.5-flash-image";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GENAI = "https://generativelanguage.googleapis.com/v1beta/models";
const BUCKET = "assets";
const MAX_ITERS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------------
//  The scene schema taught to the model. Mirrors engine.js exactly.
// ---------------------------------------------------------------------------
const SCENE_GUIDE = `
You design vertical social ads as a "scene" object that a canvas engine renders
and animates. Output MUST conform to this schema (no extra keys):

scene = {
  width, height,          // pixels; default 1080 x 1350 (4:5). Other common: 1080x1920 (9:16), 1080x1080 (1:1)
  duration,               // seconds (2.5–7 typical)
  fps,                    // 30
  background,             // hex string e.g. "#0b0c10", OR a vertical gradient:
                          //   [ {at:0,color:"#000"}, {at:1,color:"#101826"} ]
  layers: [ ... ]         // drawn bottom -> top; later layers sit on top
}

Each layer has x,y = its ANCHOR point (default anchor "center"; also "top left",
"bottom", "top right", etc.). Optional per-layer: z (stacking, higher=front),
visible, and an animations array.

LAYER TYPES
  image:  { type:"image", src:"<assetName>", x, y, width?, height?, anchor?, rotation? }
          src MUST be one of the available asset names (see catalog). Give width
          OR height (the other is derived from the image's aspect).
  text:   { type:"text", text:"Line one\\nLine two", x, y, align:"left|center|right",
            font:"Inter, system-ui, sans-serif", size, weight:"400..800",
            color:"#fff", lineHeight?, maxWidth?,
            gradient?:[{at,color}], shadow?:{color,blur,y}, stroke?:{color,width} }
          Rich text alternative (per-word styling) — use INSTEAD of "text":
            spans:[ {text:"Save ",color:"#fff"}, {text:"50%",bold:true,color:"#5b8cff"} ],
            boldWeight:"700"
  button: { type:"button", text, x, y, width, height, radius?,
            bg:"#2563eb" OR gradient:[{at,color}], color:"#fff", size, weight,
            shadow?:{color,blur,y}, border?:{color,width} }   // a fake CTA pill

ANIMATIONS (each tweens ONE property over a time window, applied on top of x/y):
  { prop:"opacity"|"tx"|"ty"|"scale"|"rotation"|"rotationX"|"rotationY",
    from, to, start, duration, ease }
  opacity 0..1; tx/ty are pixel offsets; scale 1=normal; rotation in degrees.
  ease ∈ linear, easeInQuad, easeOutQuad, easeInOutQuad, easeInCubic, easeOutCubic,
        easeInOutCubic, easeOutQuart, easeOutExpo, easeOutBack, easeOutElastic
  Good motion: fade + slight ty rise (easeOutCubic) for entrances, scale pop
  (easeOutBack) for CTAs, slow background scale drift. Stagger "start" times so
  elements arrive in sequence within the duration.

DESIGN RULES
  • Keep all content inside the canvas; respect generous margins.
  • Strong hierarchy: big bold headline, supporting subhead, one clear CTA.
  • Match the style/palette/copy tone of any EXAMPLE ad image provided.
  • Only reference asset names that exist. If you need imagery that isn't in the
    catalog, request it with a generate_image action BEFORE placing it.
`;

const RESPONSE_GUIDE = `
Reply ONLY with a single JSON object (no markdown fences):
{
  "reply": "a short, friendly chat message describing what you did/asked",
  "actions": [ /* optional, see below */ ],
  "scene":  { /* the full scene object, or null if you only asked a question */ },
  "done":   true   /* true when the scene is final and no further actions are needed */
}

ACTIONS you may request (they run, then you'll be called again with the results):
  { "type":"generate_image", "name":"<assetName>", "prompt":"...", "aspect":"4:5|9:16|1:1|16:9" }
      Creates a brand-new image and adds it to the catalog under <assetName>.
  { "type":"edit_image", "name":"<newAssetName>", "source":"<existingAssetName>", "prompt":"..." }
      Edits an existing asset into a new one.
  { "type":"render_iphone_mockup", "name":"<newAssetName>", "screenshot":"<assetName>",
    "options":{ "color":"#c9ccce", "rotX":0, "rotY":0, "bg":"#0b0c10", "transparent":true } }
      Wraps a UI screenshot onto a 3D iPhone and adds the render as <newAssetName>.

When you request actions, set "done": false and omit/repeat "scene" as a draft.
After the actions are fulfilled you'll be re-invoked; THEN return the final scene
with "done": true. If no actions are needed, return the final scene with "done": true
in one shot.
`;

// ---------------------------------------------------------------------------
//  Gemini helpers
// ---------------------------------------------------------------------------
async function callText(contents: unknown[], systemText: string) {
  const res = await fetch(`${GENAI}/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents,
      generationConfig: { responseMimeType: "application/json", temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini text error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => p.text ?? "").join("");
  return parseEnvelope(text);
}

function parseEnvelope(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return { reply: text || "(no response)", actions: [], scene: null, done: true };
  }
}

// Generate (or edit) an image; returns { dataB64, mimeType }.
async function callImage(prompt: string, sourceInline?: { mimeType: string; data: string }) {
  const parts: any[] = [{ text: prompt }];
  if (sourceInline) parts.push({ inlineData: sourceInline });
  const res = await fetch(`${GENAI}/${IMAGE_MODEL}:generateContent?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }] }),
  });
  if (!res.ok) throw new Error(`Gemini image error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const out = data?.candidates?.[0]?.content?.parts ?? [];
  const img = out.find((p: any) => p.inlineData?.data);
  if (!img) throw new Error("Image model returned no image");
  return { dataB64: img.inlineData.data as string, mimeType: img.inlineData.mimeType ?? "image/png" };
}

// ---------------------------------------------------------------------------
//  PNG/JPEG dimension sniffing (so asset rows record width/height).
// ---------------------------------------------------------------------------
function imageDims(bytes: Uint8Array): { width: number | null; height: number | null } {
  // PNG: width/height are big-endian uint32 at offset 16 and 20.
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const dv = new DataView(bytes.buffer);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  return { width: null, height: null };
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
//  Build the Gemini `contents` array from our history + project context.
// ---------------------------------------------------------------------------
function buildContents(history: any[], scene: any, assets: any[]) {
  const catalog = assets.length
    ? assets
        .map((a) => `  - ${a.name} (${a.kind}, ${a.width ?? "?"}x${a.height ?? "?"})`)
        .join("\n")
    : "  (none yet)";
  const context =
    `AVAILABLE ASSETS:\n${catalog}\n\n` +
    `CURRENT SCENE (edit this; null/empty means start fresh):\n` +
    `${JSON.stringify(scene ?? null)}`;

  const contents: any[] = [{ role: "user", parts: [{ text: context }] }];

  history.forEach((turn, i) => {
    const parts: any[] = [];
    if (turn.role === "model" && turn.json) {
      parts.push({ text: JSON.stringify(turn.json) });
      contents.push({ role: "model", parts });
      return;
    }
    if (turn.text) parts.push({ text: turn.text });
    // Attach inline image thumbnails (example ads / pasted images) to user turns.
    for (const att of turn.attachments ?? []) {
      if (att.dataUrl) {
        const [, mime, data] = att.dataUrl.match(/^data:(.*?);base64,(.*)$/) ?? [];
        if (data) parts.push({ inlineData: { mimeType: mime, data } });
      }
      if (att.label) parts.push({ text: `(image above: "${att.label}")` });
    }
    if (parts.length) contents.push({ role: "user", parts });
  });

  return contents;
}

// ---------------------------------------------------------------------------
//  Run one server-side action (image generation). Returns a result line for
//  the model, after uploading the bytes into the caller's asset bucket.
// ---------------------------------------------------------------------------
async function runServerAction(action: any, ctx: { userId: string; projectId: string; admin: any; assets: any[] }) {
  const name = action.name || `ai-${crypto.randomUUID().slice(0, 8)}.png`;
  const aspect = action.aspect || "4:5";
  const dimsHint =
    aspect === "9:16" ? "1080x1920" : aspect === "1:1" ? "1080x1080" : aspect === "16:9" ? "1920x1080" : "1080x1350";
  let result;
  if (action.type === "edit_image") {
    const src = ctx.assets.find((a) => a.name === action.source);
    let sourceInline;
    if (src) {
      const { data } = await ctx.admin.storage.from(BUCKET).download(src.path);
      if (data) {
        const buf = new Uint8Array(await data.arrayBuffer());
        sourceInline = { mimeType: data.type || "image/png", data: btoaBytes(buf) };
      }
    }
    result = await callImage(action.prompt, sourceInline);
  } else {
    result = await callImage(
      `${action.prompt}\n\nProduce a clean, high-quality image suitable for an ad, ${aspect} aspect ratio (~${dimsHint}).`
    );
  }

  const bytes = b64ToBytes(result.dataB64);
  const path = `${ctx.userId}/${ctx.projectId}/${name}`;
  await ctx.admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: result.mimeType,
    upsert: true,
  });
  const dims = imageDims(bytes);
  await ctx.admin.from("assets").upsert(
    {
      project_id: ctx.projectId,
      user_id: ctx.userId,
      name,
      path,
      kind: "ai_image",
      width: dims.width,
      height: dims.height,
    },
    { onConflict: "project_id,name" }
  );
  ctx.assets.push({ name, path, kind: "ai_image", width: dims.width, height: dims.height });
  return { name, width: dims.width, height: dims.height, ok: true };
}

function btoaBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not set on the function" }, 500);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const body = await req.json();
    const { projectId, scene } = body;
    const history: any[] = body.history ?? [];
    if (!projectId) return json({ error: "projectId required" }, 400);

    // Source the asset catalog from the DB (authoritative + has storage paths),
    // rather than trusting whatever the client sent.
    const { data: assetRows } = await admin
      .from("assets")
      .select("name, path, kind, width, height")
      .eq("project_id", projectId)
      .eq("user_id", user.id);
    const assets: any[] = assetRows ?? [];

    const ctx = { userId: user.id, projectId, admin, assets };

    // If the client is resuming after running client-side actions, fold their
    // results into history so the model sees them on the next call.
    if (body.toolResults?.length) {
      history.push({
        role: "user",
        text: `Tool results (assets are now available): ${JSON.stringify(body.toolResults)}`,
      });
    }

    const systemText = `${SCENE_GUIDE}\n\n${RESPONSE_GUIDE}`;
    let lastReply = "";
    let lastScene = scene ?? null;

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const contents = buildContents(history, lastScene, ctx.assets);
      const env = await callText(contents, systemText);
      lastReply = env.reply ?? lastReply;
      if (env.scene) lastScene = env.scene;

      const actions: any[] = Array.isArray(env.actions) ? env.actions : [];
      const clientActions = actions.filter((a) => a.type === "render_iphone_mockup");
      const serverActions = actions.filter((a) => a.type === "generate_image" || a.type === "edit_image");

      // Run server actions inline, then record the model turn + their results.
      history.push({ role: "model", json: env });
      if (serverActions.length) {
        const results = [];
        for (const a of serverActions) {
          try {
            results.push(await runServerAction(a, ctx));
          } catch (e) {
            results.push({ name: a.name, ok: false, error: String(e) });
          }
        }
        history.push({ role: "user", text: `Generated images: ${JSON.stringify(results)}` });
      }

      // Client must render mockups in the browser — hand back and pause.
      if (clientActions.length) {
        return json({
          type: "tool_calls",
          reply: lastReply,
          clientActions,
          history,
          scene: lastScene,
        });
      }

      // Done when the model says so and there's nothing left to run.
      if (env.done && !serverActions.length) {
        return json({ type: "final", reply: lastReply, scene: lastScene });
      }
      // Otherwise loop so the model can finalize using the generated images.
    }

    return json({ type: "final", reply: lastReply || "Done.", scene: lastScene });
  } catch (e) {
    console.error(e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
