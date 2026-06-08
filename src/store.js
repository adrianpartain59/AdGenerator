// ============================================================================
//  Project persistence — backed by Supabase (Postgres + Storage), replacing the
//  old file-backed server.py + IndexedDB. Everything is owned by the signed-in
//  user and protected by Row Level Security (see supabase/schema.sql).
//
//      projects   table   { id, user_id, name, scene, created_at, updated_at }
//      assets     table   metadata { id, project_id, name, path, kind, w, h }
//                 bucket  `assets` holds the bytes at <user>/<project>/<name>
//      messages   table   persisted chat transcript
//
//  The exported project/asset API keeps the shape main.js/editor.js expect, so
//  the editor code barely changes; only the implementation moved to the cloud.
// ============================================================================
import { supabase } from "./supabaseClient.js";
import { getUser } from "./auth.js";

const BUCKET = "assets";

export function newId() {
  return crypto.randomUUID();
}

function uid() {
  const u = getUser();
  if (!u) throw new Error("Not signed in");
  return u.id;
}

function assetPath(projectId, name) {
  return `${uid()}/${projectId}/${name}`;
}

// Best-effort pixel dimensions for an image blob (used for layout + the AI).
async function imageSize(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return { width: null, height: null };
  }
}

// ---------------------------------------------------------------------------
//  Projects
// ---------------------------------------------------------------------------
export async function listProjects() {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Failed to list projects: ${error.message}`);
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    updatedAt: new Date(p.updated_at).getTime(),
  }));
}

export async function getProject(id) {
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, scene, created_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load project: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    scene: data.scene,
    createdAt: new Date(data.created_at).getTime(),
  };
}

// Upsert (insert or update) a project the current user owns.
export async function saveProject(project) {
  const row = {
    id: project.id,
    user_id: uid(),
    name: project.name ?? "Untitled",
    scene: project.scene ?? {},
  };
  if (project.createdAt) row.created_at = new Date(project.createdAt).toISOString();
  const { error } = await supabase.from("projects").upsert(row);
  if (error) throw new Error(`Failed to save project: ${error.message}`);
  return project;
}

export async function deleteProject(id) {
  // Remove the project's stored files first (cascade clears the table rows).
  await deleteProjectFiles(id);
  const { error } = await supabase.from("projects").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete project: ${error.message}`);
}

async function deleteProjectFiles(projectId) {
  const prefix = `${uid()}/${projectId}`;
  const { data } = await supabase.storage.from(BUCKET).list(prefix);
  if (data?.length) {
    await supabase.storage.from(BUCKET).remove(data.map((f) => `${prefix}/${f.name}`));
  }
}

export async function duplicateProject(id, newName) {
  const src = await getProject(id);
  if (!src) throw new Error("Project not found");
  const copyId = newId();
  const name = newName || `${src.name} copy`;
  await saveProject({ id: copyId, name, scene: structuredClone(src.scene), createdAt: Date.now() });
  // Copy every asset (bytes + metadata) into the new project.
  const assets = await getAssets(id);
  for (const a of assets) {
    await putAsset(copyId, a.name, a.blob, { kind: a.kind, width: a.width, height: a.height });
  }
  return { id: copyId, name };
}

// ---------------------------------------------------------------------------
//  Assets  (metadata in the table, bytes in the bucket; returns Blobs so the
//  editor can build object URLs and undo restores)
// ---------------------------------------------------------------------------
export async function listAssetMeta(projectId) {
  const { data, error } = await supabase
    .from("assets")
    .select("name, path, kind, width, height")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list assets: ${error.message}`);
  return data || [];
}

export async function getAssets(projectId) {
  const rows = await listAssetMeta(projectId);
  const out = [];
  for (const r of rows) {
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(r.path);
    if (error || !blob) continue;
    out.push({ name: r.name, blob, type: blob.type, kind: r.kind, width: r.width, height: r.height });
  }
  return out;
}

export async function putAsset(projectId, name, blob, meta = {}) {
  const path = assetPath(projectId, name);
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { contentType: blob.type || "image/png", upsert: true });
  if (upErr) throw new Error(`Failed to upload asset: ${upErr.message}`);

  let { width, height } = meta;
  if (width == null || height == null) ({ width, height } = await imageSize(blob));

  const { error } = await supabase.from("assets").upsert(
    {
      project_id: projectId,
      user_id: uid(),
      name,
      path,
      kind: meta.kind || "upload",
      width,
      height,
    },
    { onConflict: "project_id,name" }
  );
  if (error) throw new Error(`Failed to record asset: ${error.message}`);
  return { name, width, height };
}

export async function deleteAsset(projectId, name) {
  await supabase.storage.from(BUCKET).remove([assetPath(projectId, name)]);
  await supabase.from("assets").delete().eq("project_id", projectId).eq("name", name);
}

// ---------------------------------------------------------------------------
//  Messages (persisted chat transcript)
// ---------------------------------------------------------------------------
export async function listMessages(projectId) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load messages: ${error.message}`);
  return data || [];
}

export async function addMessage(projectId, role, content) {
  const { data, error } = await supabase
    .from("messages")
    .insert({ project_id: projectId, user_id: uid(), role, content })
    .select("id, role, content, created_at")
    .single();
  if (error) throw new Error(`Failed to save message: ${error.message}`);
  return data;
}
