// ============================================================================
//  Chat — the ChatGPT-style conversation that drives the AI agent.
//
//  The user types (and pastes/drops images); each turn is sent to the `ai-agent`
//  edge function, which returns either a final scene (loaded into the editor) or
//  a set of client-side actions to run (currently: render a 3D iPhone mockup),
//  after which we resume the agent. Transcript turns persist via store.js.
// ============================================================================
import { supabase } from "./supabaseClient.js";
import { listMessages, addMessage } from "./store.js";

// Downscale an image blob to a base64 data URL (long edge ≤ max) for sending to
// the model as vision input — keeps the request small while staying legible.
async function thumbnailDataUrl(blob, max = 768) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  return await blobToDataUrl(out);
}
function blobToDataUrl(blob) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
}

export class Chat {
  // els: { transcript, input, send, attach, attachInput, pills, status }
  // host: { editor, mockup, getProjectId }
  constructor(els, host) {
    this.els = els;
    this.host = host;
    this.projectId = null;
    this.history = []; // agent-protocol history (user/model turns)
    this.pending = []; // staged attachments for the next send: {name, blob, dataUrl}
    this.busy = false;
    this.bind();
  }

  bind() {
    const { els } = this;
    els.send.addEventListener("click", () => this.send());
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });
    els.input.addEventListener("input", () => this.autosize());
    els.attach.addEventListener("click", () => els.attachInput.click());
    els.attachInput.addEventListener("change", (e) => {
      this.stageFiles(e.target.files);
      e.target.value = "";
    });
    els.input.addEventListener("paste", (e) => {
      const imgs = [...(e.clipboardData?.items ?? [])]
        .filter((i) => i.type.startsWith("image/"))
        .map((i) => i.getAsFile())
        .filter(Boolean);
      if (imgs.length) {
        e.preventDefault();
        this.stageFiles(imgs);
      }
    });
    const dz = els.transcript.closest(".chat") || els.transcript;
    dz.addEventListener("dragover", (e) => e.preventDefault());
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length) this.stageFiles(e.dataTransfer.files);
    });
  }

  autosize() {
    const ta = this.els.input;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }

  // ----- attachments staged for the next message --------------------------
  async stageFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    for (const file of files) {
      const dataUrl = await thumbnailDataUrl(file).catch(() => null);
      this.pending.push({ name: file.name, blob: file, dataUrl });
    }
    this.renderPills();
  }
  renderPills() {
    const { pills } = this.els;
    pills.innerHTML = "";
    pills.hidden = !this.pending.length;
    this.pending.forEach((att, i) => {
      const pill = document.createElement("div");
      pill.className = "att-pill";
      const img = document.createElement("img");
      img.src = att.dataUrl || URL.createObjectURL(att.blob);
      const x = document.createElement("button");
      x.textContent = "×";
      x.addEventListener("click", () => {
        this.pending.splice(i, 1);
        this.renderPills();
      });
      pill.append(img, x);
      pills.appendChild(pill);
    });
  }

  // ----- transcript rendering ---------------------------------------------
  addBubble(role, text, attachments = []) {
    const b = document.createElement("div");
    b.className = `bubble ${role}`;
    if (attachments.length) {
      const row = document.createElement("div");
      row.className = "bubble-imgs";
      for (const a of attachments) {
        const img = document.createElement("img");
        img.src = a.dataUrl || a.url;
        row.appendChild(img);
      }
      b.appendChild(row);
    }
    if (text) {
      const p = document.createElement("div");
      p.className = "bubble-text";
      p.textContent = text;
      b.appendChild(p);
    }
    this.els.transcript.appendChild(b);
    this.els.transcript.scrollTop = this.els.transcript.scrollHeight;
    return b;
  }
  setStatus(msg) {
    this.els.status.textContent = msg || "";
    this.els.status.hidden = !msg;
  }
  // Show a one-off system/setup message in the transcript.
  systemNotice(text) {
    this.addBubble("assistant", text);
  }

  // ----- project load ------------------------------------------------------
  async loadProject(id) {
    this.projectId = id;
    this.history = [];
    this.pending = [];
    this.renderPills();
    this.els.transcript.innerHTML = "";
    const rows = await listMessages(id);
    if (!rows.length) {
      this.addBubble(
        "assistant",
        "Hi! Describe the ad you want, or paste an example ad / your app screenshots and I'll build it. You can also drop in logos and product images to use."
      );
      return;
    }
    for (const r of rows) {
      const c = r.content || {};
      this.addBubble(r.role === "assistant" ? "assistant" : r.role, c.text || "", c.attachments || []);
      // Rebuild agent history from persisted turns.
      if (r.role === "user") {
        this.history.push({ role: "user", text: c.text, attachments: c.attachments });
      } else if (r.role === "assistant") {
        this.history.push({ role: "model", json: { reply: c.text, done: true } });
      }
    }
  }

  // ----- send + agent loop -------------------------------------------------
  async send() {
    if (this.busy) return;
    if (!this.projectId) {
      this.systemNotice(
        "No active project loaded — finish Supabase setup (run supabase/schema.sql in your project's SQL Editor) and reload."
      );
      return;
    }
    const text = this.els.input.value.trim();
    if (!text && !this.pending.length) return;

    // Upload staged images into the project so the AI (and editor) can use them.
    const attachments = [];
    for (const att of this.pending) {
      const meta = await this.host.editor
        .addAssetBlob(this.host.editor.uniqueAssetName(att.name), att.blob, "example")
        .catch(() => null);
      attachments.push({ label: meta?.name || att.name, dataUrl: att.dataUrl });
    }
    this.pending = [];
    this.renderPills();

    this.els.input.value = "";
    this.autosize();
    this.addBubble("user", text, attachments);
    this.history.push({ role: "user", text, attachments });
    await addMessage(this.projectId, "user", { text, attachments }).catch(() => {});

    this.busy = true;
    this.els.send.disabled = true;
    this.setStatus("Thinking…");
    try {
      await this.runAgent();
    } catch (e) {
      console.error(e);
      this.addBubble("assistant", `Something went wrong: ${e.message || e}`);
    } finally {
      this.busy = false;
      this.els.send.disabled = false;
      this.setStatus("");
    }
  }

  async runAgent(toolResults) {
    const { editor } = this.host;
    const res = await this.invoke({
      projectId: this.projectId,
      history: this.history,
      scene: editor.getScene(),
      toolResults,
    });

    if (res.type === "tool_calls") {
      this.history = res.history; // server-extended history (incl. model turn)
      if (res.reply) this.setStatus(res.reply);
      const results = await this.runClientActions(res.clientActions);
      return this.runAgent(results); // resume the agent with the results
    }

    // Final: show the reply, persist it, and load the scene into the editor.
    const reply = res.reply || "Done.";
    this.addBubble("assistant", reply);
    this.history.push({ role: "model", json: { reply, done: true } });
    await addMessage(this.projectId, "assistant", { text: reply }).catch(() => {});
    if (res.scene) {
      this.setStatus("Rendering your ad…");
      await editor.loadScene(res.scene);
      this.host.onScene?.();
    }
  }

  async invoke(body) {
    const { data, error } = await supabase.functions.invoke("ai-agent", { body });
    if (error) {
      // Surface the function's own error message when present.
      let detail = error.message;
      try {
        detail = (await error.context?.json())?.error || detail;
      } catch {}
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  // Execute the browser-only actions the agent requested (3D mockups), uploading
  // each render as a project asset, and return results to resume the agent.
  async runClientActions(actions) {
    const { editor, mockup } = this.host;
    const results = [];
    for (const a of actions) {
      try {
        if (a.type === "render_iphone_mockup") {
          this.setStatus(`Rendering iPhone mockup “${a.name}”…`);
          const shotBlob = editor.getAssetBlob(a.screenshot);
          if (!shotBlob) throw new Error(`screenshot "${a.screenshot}" not found`);
          const png = await mockup.renderMockup({ screenshotBlob: shotBlob, options: a.options || {} });
          const meta = await editor.addAssetBlob(a.name, png, "mockup");
          results.push({ name: a.name, width: meta.width, height: meta.height, ok: true });
        }
      } catch (e) {
        results.push({ name: a.name, ok: false, error: String(e.message ?? e) });
      }
    }
    return results;
  }
}
