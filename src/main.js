// ============================================================================
//  App bootstrap. Gates on auth, then wires the three panes — projects sidebar,
//  chat agent, and the manual editor — over one shared active project.
// ============================================================================
import { initAuth, onAuthChange, signOut, getUser } from "./auth.js";
import {
  newId,
  listProjects,
  saveProject,
  deleteProject,
  duplicateProject,
} from "./store.js";
import { Editor } from "./editor.js";
import { Chat } from "./chat.js";

const $ = (id) => document.getElementById(id);

// Lazy 3D mockup loader — keeps three.js out of the initial bundle until a
// mockup is actually needed (by the editor's 📱 button or the chat agent).
const mockupApi = {
  renderMockup: (args) => import("./mockup.js").then((m) => m.renderMockup(args)),
  openModal: (args) => import("./mockup.js").then((m) => m.openMockupModal(args)),
};

let editor, chat;
let currentProjectId = null;
let started = false;

// A pleasant text-only starter so a brand-new project renders + animates right
// away (no asset uploads needed). The AI replaces this on the first request.
function starterScene() {
  return {
    width: 1080,
    height: 1350,
    duration: 4.5,
    fps: 30,
    background: [
      { at: 0, color: "#0b0c10" },
      { at: 1, color: "#15203a" },
    ],
    layers: [
      {
        type: "text",
        text: "Your idea,\nan ad in seconds.",
        x: 540,
        y: 430,
        align: "center",
        font: "Inter, system-ui, sans-serif",
        size: 96,
        weight: "800",
        lineHeight: 104,
        gradient: [
          { at: 0, color: "#5b8cff" },
          { at: 0.5, color: "#a855f7" },
          { at: 1, color: "#ec4899" },
        ],
        shadow: { color: "rgba(139,92,246,0.45)", blur: 36, y: 0 },
        animations: [
          { prop: "opacity", from: 0, to: 1, start: 0.2, duration: 0.7, ease: "easeOutCubic" },
          { prop: "ty", from: 50, to: 0, start: 0.2, duration: 0.8, ease: "easeOutCubic" },
        ],
      },
      {
        type: "text",
        text: "Describe it in chat — or paste an example ad to match.",
        x: 540,
        y: 690,
        align: "center",
        size: 40,
        weight: "500",
        color: "#9aa3b2",
        maxWidth: 840,
        animations: [
          { prop: "opacity", from: 0, to: 1, start: 0.6, duration: 0.6, ease: "easeOutCubic" },
          { prop: "ty", from: 26, to: 0, start: 0.6, duration: 0.6, ease: "easeOutCubic" },
        ],
      },
      {
        type: "button",
        text: "Start in the chat →",
        x: 540,
        y: 900,
        width: 520,
        height: 98,
        radius: 49,
        gradient: [
          { at: 0, color: "#2563eb" },
          { at: 1, color: "#7c3aed" },
        ],
        color: "#ffffff",
        size: 38,
        weight: "700",
        shadow: { color: "rgba(124,58,237,0.55)", blur: 44, y: 14 },
        animations: [
          { prop: "opacity", from: 0, to: 1, start: 1.0, duration: 0.3, ease: "easeOutCubic" },
          { prop: "scale", from: 0.7, to: 1, start: 1.0, duration: 0.6, ease: "easeOutBack" },
        ],
      },
    ],
  };
}

// --------------------------------------------------------------------------
//  Projects sidebar
// --------------------------------------------------------------------------
async function refreshProjectList() {
  const projects = await listProjects();
  const list = $("projectList");
  list.innerHTML = "";
  for (const p of projects) {
    const row = document.createElement("div");
    row.className = "project-row" + (p.id === currentProjectId ? " active" : "");
    row.dataset.id = p.id;

    const name = document.createElement("span");
    name.className = "pr-name";
    name.textContent = p.name;
    name.title = p.name;
    name.addEventListener("click", () => selectProject(p.id));

    const actions = document.createElement("div");
    actions.className = "pr-actions";
    const ren = mini("✎", "Rename", async (e) => {
      e.stopPropagation();
      const n = prompt("Rename project:", p.name);
      if (n && n.trim()) {
        await saveProject({ id: p.id, name: n.trim(), scene: editor.getScene(), createdAt: editor.createdAt });
        if (p.id === currentProjectId) {
          editor.projectName = n.trim();
          $("projName").textContent = n.trim();
        }
        refreshProjectList();
      }
    });
    const dup = mini("⧉", "Duplicate", async (e) => {
      e.stopPropagation();
      const copy = await duplicateProject(p.id, `${p.name} copy`);
      await refreshProjectList();
      selectProject(copy.id);
    });
    const del = mini("🗑", "Delete", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete “${p.name}”? This cannot be undone.`)) return;
      await deleteProject(p.id);
      const remaining = await listProjects();
      await refreshProjectList();
      if (p.id === currentProjectId) {
        if (remaining.length) selectProject(remaining[0].id);
        else createProject();
      }
    });
    actions.append(ren, dup, del);
    row.append(name, actions);
    list.appendChild(row);
  }
}

function mini(label, title, onClick) {
  const b = document.createElement("button");
  b.className = "btn mini";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

async function createProject(name = "Untitled ad") {
  const id = newId();
  await saveProject({ id, name, scene: starterScene(), createdAt: Date.now() });
  await refreshProjectList();
  await selectProject(id);
}

async function selectProject(id) {
  currentProjectId = id;
  localStorage.setItem("lastProjectId", id);
  const ok = await editor.loadProject(id);
  if (!ok) return;
  $("projName").textContent = editor.projectName;
  await chat.loadProject(id);
  editor.play();
  // reflect active row
  document.querySelectorAll(".project-row").forEach((r) =>
    r.classList.toggle("active", r.dataset.id === id)
  );
}

// --------------------------------------------------------------------------
//  View toggle (chat / split / editor focus)
// --------------------------------------------------------------------------
function wireViewToggle() {
  const buttons = document.querySelectorAll(".view-toggle button");
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      document.body.className = document.body.className
        .replace(/layout-\w+/g, "")
        .trim();
      document.body.classList.add(`layout-${b.dataset.view}`);
      buttons.forEach((x) => x.classList.toggle("active", x === b));
    })
  );
}

// --------------------------------------------------------------------------
//  Boot
// --------------------------------------------------------------------------
function buildEditor() {
  const els = {
    stage: $("stage"),
    play: $("playPause"),
    restart: $("restart"),
    export: $("export"),
    scrub: $("scrub"),
    time: $("time"),
    loop: $("loop"),
    dims: $("dims"),
    layerSelect: $("layerSelect"),
    xform: $("xform"),
    copyXform: $("copyXform"),
    assetInput: $("assetInput"),
    assetGrid: $("assetGrid"),
    status: $("status"),
    coord: $("coord"),
    saveStatus: $("saveStatus"),
  };
  return new Editor(els, {
    onMockup: (name) => mockupApi.openModal({ editor, name }),
  });
}

function buildChat() {
  const els = {
    transcript: $("transcript"),
    input: $("chatInput"),
    send: $("chatSend"),
    attach: $("attach"),
    attachInput: $("attachInput"),
    pills: $("attPills"),
    status: $("chatStatus"),
  };
  return new Chat(els, {
    editor,
    mockup: mockupApi,
    onScene: () => {}, // hook for future (e.g. auto-switch to editor view)
  });
}

async function startApp() {
  if (started) return;
  started = true;
  editor = buildEditor();
  chat = buildChat();
  wireViewToggle();
  $("newProject").addEventListener("click", () => createProject().catch(showSetupError));
  $("signOut").addEventListener("click", () => signOut());

  try {
    let projects = await listProjects();
    if (!projects.length) {
      await createProject("My first ad");
      return;
    }
    await refreshProjectList();
    const ids = projects.map((p) => p.id);
    const last = localStorage.getItem("lastProjectId");
    const target = (last && ids.includes(last) && last) || projects[0].id;
    await selectProject(target);
  } catch (err) {
    showSetupError(err);
  }
}

// Surface backend/setup problems in the chat instead of failing silently.
function showSetupError(err) {
  console.error(err);
  const m = String(err?.message || err);
  const friendly =
    /Could not find the table|schema cache|does not exist|relation/i.test(m)
      ? "You're signed in, but your Supabase database isn't set up yet. Open your project → SQL Editor → New query, paste the contents of supabase/schema.sql, run it, then reload this page."
      : `Couldn't reach your data: ${m}`;
  chat?.systemNotice(friendly);
}

async function main() {
  onAuthChange((session) => {
    const email = session?.user?.email;
    if (email) $("acctEmail").textContent = email;
    if (session) startApp();
  });
  await initAuth();
  if (getUser()) startApp();
}

main();
