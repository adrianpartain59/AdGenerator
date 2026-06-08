// ============================================================================
//  Editor — the full manual-control surface for one ad: live preview playback,
//  the transform/layer editor, the asset library, undo/redo, and MP4 export.
//
//  This is the original Static Ad Generator controller refactored into a class
//  so the chat agent can hand a freshly generated scene to `loadScene()` and so
//  it can share the active project's scene + assets. Persistence now goes
//  through store.js (Supabase) instead of the local file server, but the
//  rendering/animation/export code is reused unchanged from engine.js.
// ============================================================================
import { Renderer, preloadScene, loadImage } from "./engine.js";
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm";
import {
  getProject,
  saveProject,
  getAssets,
  listAssetMeta,
  putAsset,
  deleteAsset,
} from "./store.js";

const HISTORY_LIMIT = 100;
const EXPORT_SCALE = 2; // 1080×1350 × 2 = 2160×2700 (4K-class, 4:5)

const XFORM_FIELDS = [
  { key: "x", label: "Pos X", min: -200, max: (s) => s.width + 200, step: 1, def: 0 },
  { key: "y", label: "Pos Y", min: -200, max: (s) => s.height + 200, step: 1, def: 0 },
  { key: "z", label: "Z order", min: -100, max: 100, step: 1, def: 0 },
  { key: "scale", label: "Scale", min: 0.1, max: 3, step: 0.05, def: 1 },
  { key: "rotationX", label: "Rot X", min: -180, max: 180, step: 1, def: 0 },
  { key: "rotationY", label: "Rot Y", min: -180, max: 180, step: 1, def: 0 },
  { key: "rotation", label: "Rot Z", min: -180, max: 180, step: 1, def: 0 },
];

export class Editor {
  // `els` is a map of the editor pane's DOM elements (see index.html). `hooks`
  // lets the host wire optional integrations (e.g. the iPhone mockup tool).
  constructor(els, hooks = {}) {
    this.els = els;
    this.hooks = hooks;
    this.canvas = els.stage;

    this.scene = null;
    this.renderer = null;
    this.assets = null; // Map<name, Image>
    this.assetUrls = {}; // name -> object URL
    this.assetBlobs = new Map(); // name -> Blob (kept for undo restore)
    this.assetKinds = {}; // name -> kind (upload | ai_image | mockup | example)

    this.projectId = null;
    this.projectName = "";
    this.createdAt = null;

    this.histStack = [];
    this.histIndex = -1;
    this.applyingHistory = false;

    this.playing = false;
    this.time = 0;
    this.lastTs = 0;
    this.recording = false;
    this.saveTimer = null;

    this.selectedLayer = 0;
    this.fieldEls = {};

    this.bindControls();
  }

  resolveSrc = (name) => this.assetUrls[name] ?? name;

  // ----- playback ----------------------------------------------------------
  fmt(t) {
    return `${t.toFixed(2)}s`;
  }
  setTime(t) {
    const { els } = this;
    this.time = Math.max(0, Math.min(this.scene.duration, t));
    this.renderer.drawFrame(this.time);
    els.scrub.value = String((this.time / this.scene.duration) * 1000);
    els.time.textContent = `${this.fmt(this.time)} / ${this.fmt(this.scene.duration)}`;
  }
  tick = (ts) => {
    if (!this.playing) return;
    if (!this.lastTs) this.lastTs = ts;
    const dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    let next = this.time + dt;
    if (next >= this.scene.duration) {
      if (this.els.loop.checked && !this.recording) {
        next = next % this.scene.duration;
      } else {
        this.setTime(this.scene.duration);
        this.stop();
        return;
      }
    }
    this.setTime(next);
    requestAnimationFrame(this.tick);
  };
  play() {
    if (this.playing || !this.scene) return;
    if (this.time >= this.scene.duration) this.time = 0;
    this.playing = true;
    this.lastTs = 0;
    this.els.play.textContent = "❚❚ Pause";
    requestAnimationFrame(this.tick);
  }
  stop() {
    this.playing = false;
    this.els.play.textContent = "▶ Play";
  }
  togglePlay() {
    this.playing ? this.stop() : this.play();
  }

  // ----- MP4 export (WebCodecs) with WebM fallback -------------------------
  async exportVideo() {
    const { els, scene } = this;
    if (typeof VideoEncoder === "undefined") {
      els.status.textContent = "WebCodecs unavailable — exporting WebM instead…";
      return this.exportVideoWebM();
    }
    const fps = scene.fps || 30;
    const width = Math.round((scene.width * EXPORT_SCALE) / 2) * 2;
    const height = Math.round((scene.height * EXPORT_SCALE) / 2) * 2;
    const config = {
      codec: "avc1.640033",
      width,
      height,
      bitrate: 30_000_000,
      framerate: fps,
    };
    let support;
    try {
      support = await VideoEncoder.isConfigSupported(config);
    } catch {
      support = { supported: false };
    }
    if (!support.supported) {
      els.status.textContent = "MP4 (H.264) unsupported here — exporting WebM…";
      return this.exportVideoWebM();
    }

    this.stop();
    this.recording = true;
    els.export.disabled = true;
    els.play.disabled = true;
    els.status.textContent = "Preparing MP4…";

    const off = document.createElement("canvas");
    const offRenderer = new Renderer(off, scene, this.assets, EXPORT_SCALE);
    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: "avc", width, height },
      fastStart: "in-memory",
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error(e);
        els.status.textContent = `Encode error: ${e.message}`;
      },
    });
    encoder.configure(config);

    const totalFrames = Math.max(1, Math.round(scene.duration * fps));
    const frameDur = 1_000_000 / fps;
    try {
      for (let i = 0; i < totalFrames; i++) {
        offRenderer.drawFrame(i / fps);
        const frame = new VideoFrame(off, {
          timestamp: Math.round(i * frameDur),
          duration: Math.round(frameDur),
        });
        encoder.encode(frame, { keyFrame: i % fps === 0 });
        frame.close();
        els.status.textContent = `Rendering ${i + 1}/${totalFrames} · ${width}×${height}`;
        if (encoder.encodeQueueSize > 8) {
          await new Promise((resolve) => {
            const onDequeue = () => {
              if (encoder.encodeQueueSize <= 8) {
                encoder.removeEventListener("dequeue", onDequeue);
                resolve();
              }
            };
            encoder.addEventListener("dequeue", onDequeue);
          });
        } else {
          await new Promise((r) => setTimeout(r));
        }
      }
      await encoder.flush();
      muxer.finalize();
      const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
      this.download(blob, `ad-${Date.now()}.mp4`);
      els.status.textContent = `Exported ✓  MP4 ${width}×${height}`;
    } catch (err) {
      console.error(err);
      els.status.textContent = `Export failed: ${err.message}`;
    } finally {
      try {
        encoder.close();
      } catch {}
      this.recording = false;
      els.export.disabled = false;
      els.play.disabled = false;
      this.setTime(this.time);
    }
  }

  pickMime() {
    const candidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
  }
  async exportVideoWebM() {
    const { els, scene, canvas } = this;
    const mime = this.pickMime();
    if (!mime) {
      els.status.textContent = "Export not supported in this browser.";
      return;
    }
    this.stop();
    this.recording = true;
    els.export.disabled = true;
    els.play.disabled = true;
    els.status.textContent = "Recording…";
    const fps = scene.fps || 30;
    const stream = canvas.captureStream(fps);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16_000_000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const finished = new Promise((res) => (rec.onstop = res));
    this.setTime(0);
    rec.start();
    await new Promise((resolve) => {
      let last = 0;
      const step = (ts) => {
        if (!last) last = ts;
        const dt = (ts - last) / 1000;
        last = ts;
        const next = this.time + dt;
        if (next >= scene.duration) {
          this.setTime(scene.duration);
          resolve();
          return;
        }
        this.setTime(next);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    await new Promise((r) => setTimeout(r, 250));
    rec.stop();
    await finished;
    this.download(new Blob(chunks, { type: mime }), `ad-${Date.now()}.webm`);
    this.recording = false;
    els.export.disabled = false;
    els.play.disabled = false;
    els.status.textContent = "Exported ✓  (WebM)";
  }

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ----- transform / layer editor -----------------------------------------
  layerLabel(layer, i) {
    let detail = "";
    if (layer.type === "image" && layer.src) detail = layer.src.split("/").pop();
    else if (layer.text) detail = layer.text.replace(/\s+/g, " ").trim().slice(0, 22);
    else if (layer.spans)
      detail = layer.spans.map((s) => s.text).join("").replace(/\s+/g, " ").trim().slice(0, 22);
    return `${i + 1}. ${layer.type}${detail ? " · " + detail : ""}`;
  }
  applyField(key, value) {
    const layer = this.scene.layers[this.selectedLayer];
    if (!layer) return;
    layer[key] = value;
    this.renderer.drawFrame(this.time);
    this.scheduleSave();
  }
  selectLayer(i) {
    if (i < 0 || i >= this.scene.layers.length) return;
    this.selectedLayer = i;
    this.els.layerSelect.value = String(i);
    this.loadLayerIntoEditor();
  }
  loadLayerIntoEditor() {
    const layer = this.scene.layers[this.selectedLayer];
    if (!layer) return;
    for (const f of XFORM_FIELDS) {
      const v = layer[f.key] ?? f.def;
      this.fieldEls[f.key].range.value = String(v);
      this.fieldEls[f.key].num.value = String(v);
    }
  }
  async copyXform() {
    const layer = this.scene.layers[this.selectedLayer];
    if (!layer) return;
    const out = {};
    for (const f of XFORM_FIELDS) {
      const v = layer[f.key];
      if (v !== undefined && v !== f.def) out[f.key] = v;
    }
    const text = JSON.stringify(out, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      this.els.status.textContent = "Copied transform values ✓";
    } catch {
      this.els.status.textContent = text;
    }
  }
  buildEditor() {
    const { els, scene } = this;
    els.layerSelect.innerHTML = "";
    scene.layers.forEach((layer, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = this.layerLabel(layer, i);
      els.layerSelect.appendChild(opt);
    });

    els.xform.innerHTML = "";
    for (const f of XFORM_FIELDS) {
      const min = typeof f.min === "function" ? f.min(scene) : f.min;
      const max = typeof f.max === "function" ? f.max(scene) : f.max;
      const row = document.createElement("div");
      row.className = "xrow";
      const lab = document.createElement("label");
      lab.textContent = f.label;
      const range = document.createElement("input");
      range.type = "range";
      range.min = min;
      range.max = max;
      range.step = f.step;
      const num = document.createElement("input");
      num.type = "number";
      num.min = min;
      num.max = max;
      num.step = f.step;
      range.addEventListener("input", () => {
        num.value = range.value;
        this.applyField(f.key, Number(range.value));
      });
      num.addEventListener("input", () => {
        range.value = num.value;
        this.applyField(f.key, Number(num.value));
      });
      range.addEventListener("change", () => this.recordHistory());
      num.addEventListener("change", () => this.recordHistory());
      row.append(lab, range, num);
      els.xform.appendChild(row);
      this.fieldEls[f.key] = { range, num };
    }

    if (this.selectedLayer >= scene.layers.length) this.selectedLayer = 0;
    els.layerSelect.value = String(this.selectedLayer);
    this.loadLayerIntoEditor();
  }

  // ----- save status + autosave -------------------------------------------
  setSaveStatus(state) {
    if (!this.els.saveStatus) return;
    const map = { saving: ["Saving…", "saving"], saved: ["Saved ✓", "saved"], idle: ["—", ""] };
    const [text, cls] = map[state] || map.idle;
    this.els.saveStatus.textContent = text;
    this.els.saveStatus.className = "savestatus" + (cls ? " " + cls : "");
  }
  scheduleSave() {
    if (!this.projectId) return;
    this.setSaveStatus("saving");
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }
  async saveNow() {
    if (!this.projectId) return;
    await saveProject({
      id: this.projectId,
      name: this.projectName,
      createdAt: this.createdAt,
      scene: this.scene,
    });
    this.setSaveStatus("saved");
  }

  // ----- undo / redo -------------------------------------------------------
  snapshot() {
    const assetNames = Object.keys(this.assetUrls);
    return {
      scene: structuredClone(this.scene),
      assetNames,
      selectedLayer: this.selectedLayer,
      sig: JSON.stringify({ s: this.scene, a: assetNames }),
    };
  }
  resetHistory() {
    this.histStack = [this.snapshot()];
    this.histIndex = 0;
  }
  recordHistory() {
    if (this.applyingHistory || !this.projectId) return;
    const snap = this.snapshot();
    if (this.histStack[this.histIndex]?.sig === snap.sig) return;
    this.histStack = this.histStack.slice(0, this.histIndex + 1);
    this.histStack.push(snap);
    if (this.histStack.length > HISTORY_LIMIT) this.histStack.shift();
    this.histIndex = this.histStack.length - 1;
  }
  async applySnapshot(snap) {
    this.applyingHistory = true;
    try {
      this.stop();
      const target = new Set(snap.assetNames);
      for (const name of Object.keys(this.assetUrls)) {
        if (!target.has(name)) {
          URL.revokeObjectURL(this.assetUrls[name]);
          delete this.assetUrls[name];
          this.assets.delete(name);
          await deleteAsset(this.projectId, name);
        }
      }
      for (const name of target) {
        if (!this.assetUrls[name] && this.assetBlobs.has(name)) {
          const blob = this.assetBlobs.get(name);
          await putAsset(this.projectId, name, blob, { kind: this.assetKinds[name] || "upload" });
          this.assetUrls[name] = URL.createObjectURL(blob);
        }
      }
      this.scene = structuredClone(snap.scene);
      if (!Array.isArray(this.scene.layers)) this.scene.layers = [];
      this.selectedLayer = Math.min(
        snap.selectedLayer ?? 0,
        Math.max(0, this.scene.layers.length - 1)
      );
      this.assets = await preloadScene(this.scene, this.resolveSrc);
      this.renderer = new Renderer(this.canvas, this.scene, this.assets);
      this.buildEditor();
      this.refreshAssetGrid();
      this.updateDims();
      this.setTime(0);
      await this.saveNow();
    } finally {
      this.applyingHistory = false;
    }
  }
  async undo() {
    if (this.histIndex <= 0) return;
    this.histIndex--;
    await this.applySnapshot(this.histStack[this.histIndex]);
    this.els.status.textContent = `Undo (${this.histIndex + 1}/${this.histStack.length})`;
  }
  async redo() {
    if (this.histIndex >= this.histStack.length - 1) return;
    this.histIndex++;
    await this.applySnapshot(this.histStack[this.histIndex]);
    this.els.status.textContent = `Redo (${this.histIndex + 1}/${this.histStack.length})`;
  }

  updateDims() {
    if (!this.els.dims) return;
    const s = this.scene;
    this.els.dims.textContent = `${s.width} × ${s.height} · ${s.fps}fps · ${s.duration}s`;
  }

  // ----- project loading ---------------------------------------------------
  async loadProject(id) {
    const project = await getProject(id);
    if (!project) return false;
    this.stop();

    for (const url of Object.values(this.assetUrls)) URL.revokeObjectURL(url);
    this.assetUrls = {};
    this.assetBlobs = new Map();
    this.assetKinds = {};
    const rows = await getAssets(id);
    for (const a of rows) {
      this.assetBlobs.set(a.name, a.blob);
      this.assetUrls[a.name] = URL.createObjectURL(a.blob);
      this.assetKinds[a.name] = a.kind || "upload";
    }

    this.projectId = id;
    this.projectName = project.name;
    this.createdAt = project.createdAt ?? Date.now();
    this.scene = project.scene && Object.keys(project.scene).length ? project.scene : blankScene();
    if (!Array.isArray(this.scene.layers)) this.scene.layers = [];
    this.selectedLayer = 0;

    this.assets = await preloadScene(this.scene, this.resolveSrc);
    this.renderer = new Renderer(this.canvas, this.scene, this.assets);
    this.buildEditor();
    this.refreshAssetGrid();
    this.updateDims();
    this.setSaveStatus("saved");
    this.resetHistory();
    this.time = 0;
    this.setTime(0);
    if (this.els.status) this.els.status.textContent = "Ready";
    return true;
  }

  // Apply a scene produced by the AI (or any external source) to the active
  // project. Assets it references must already exist (the agent adds them via
  // addAssetBlob / refreshAssets before calling this).
  async loadScene(scene) {
    if (!scene) return;
    await this.refreshAssets();
    this.stop();
    this.scene = scene;
    if (!Array.isArray(this.scene.layers)) this.scene.layers = [];
    this.selectedLayer = 0;
    this.assets = await preloadScene(this.scene, this.resolveSrc);
    this.renderer = new Renderer(this.canvas, this.scene, this.assets);
    this.buildEditor();
    this.refreshAssetGrid();
    this.updateDims();
    this.recordHistory();
    await this.saveNow();
    this.time = 0;
    this.setTime(0);
    this.play();
  }

  getScene() {
    return this.scene;
  }

  // ----- asset library -----------------------------------------------------
  // Returns a compact description of the current assets for the AI/sidebar.
  describeAssets() {
    return Object.keys(this.assetUrls).map((name) => {
      const img = this.assets?.get(name);
      return {
        name,
        kind: this.assetKinds[name] || "upload",
        width: img?.naturalWidth || img?.width || null,
        height: img?.naturalHeight || img?.height || null,
        url: this.assetUrls[name],
      };
    });
  }
  getAssetBlob(name) {
    return this.assetBlobs.get(name) || null;
  }

  uniqueAssetName(filename) {
    let name = filename.replace(/[^\w.\-]+/g, "_");
    if (!this.assetUrls[name]) return name;
    const dot = name.lastIndexOf(".");
    const base = dot >= 0 ? name.slice(0, dot) : name;
    const ext = dot >= 0 ? name.slice(dot) : "";
    let i = 1;
    while (this.assetUrls[`${base}-${i}${ext}`]) i++;
    return `${base}-${i}${ext}`;
  }

  async handleAssetFiles(fileList, kind = "upload") {
    const files = [...fileList].filter((f) => f.type.startsWith("image/"));
    const added = [];
    for (const file of files) {
      const meta = await this.addAssetBlob(this.uniqueAssetName(file.name), file, kind);
      added.push(meta);
    }
    if (added.length) {
      this.refreshAssetGrid();
      this.setSaveStatus("saved");
      this.recordHistory();
    }
    return added;
  }

  // Add a single image blob as a project asset (used by uploads, AI image
  // generation, and the iPhone mockup tool). Returns { name, width, height }.
  async addAssetBlob(name, blob, kind = "upload") {
    const meta = await putAsset(this.projectId, name, blob, { kind });
    this.assetBlobs.set(name, blob);
    this.assetUrls[name] = URL.createObjectURL(blob);
    this.assetKinds[name] = kind;
    if (this.assets) {
      try {
        this.assets.set(name, await loadImage(this.assetUrls[name]));
      } catch {}
    }
    this.refreshAssetGrid();
    return { name, ...meta };
  }

  // Pull in any assets that exist in the store but aren't loaded locally yet
  // (e.g. images the edge function generated server-side during a chat turn).
  async refreshAssets() {
    if (!this.projectId) return;
    const rows = await listAssetMeta(this.projectId);
    let changed = false;
    for (const r of rows) {
      if (this.assetUrls[r.name]) continue;
      const got = await downloadAsset(r.path);
      if (!got) continue;
      this.assetBlobs.set(r.name, got);
      this.assetUrls[r.name] = URL.createObjectURL(got);
      this.assetKinds[r.name] = r.kind || "upload";
      if (this.assets) {
        try {
          this.assets.set(r.name, await loadImage(this.assetUrls[r.name]));
        } catch {}
      }
      changed = true;
    }
    if (changed) this.refreshAssetGrid();
  }

  async addImageLayer(name) {
    const img = await loadImage(this.resolveSrc(name));
    this.assets.set(name, img);
    this.scene.layers.push({
      type: "image",
      src: name,
      x: Math.round(this.scene.width / 2),
      y: Math.round(this.scene.height / 2),
      width: 300,
      anchor: "center",
    });
    this.buildEditor();
    this.selectLayer(this.scene.layers.length - 1);
    this.setTime(this.time);
    this.scheduleSave();
    this.recordHistory();
  }

  async deleteAssetByName(name) {
    const before = this.scene.layers.length;
    this.scene.layers = this.scene.layers.filter((l) => !(l.type === "image" && l.src === name));
    await deleteAsset(this.projectId, name);
    URL.revokeObjectURL(this.assetUrls[name]);
    delete this.assetUrls[name];
    this.assets.delete(name);
    this.refreshAssetGrid();
    if (this.scene.layers.length !== before) {
      this.selectedLayer = 0;
      this.buildEditor();
      this.setTime(this.time);
    }
    this.scheduleSave();
    this.recordHistory();
  }

  refreshAssetGrid() {
    const { els } = this;
    els.assetGrid.innerHTML = "";
    const names = Object.keys(this.assetUrls);
    if (!names.length) {
      els.assetGrid.innerHTML = `<div class="empty">No assets yet — upload some or ask the AI.</div>`;
      return;
    }
    for (const name of names) {
      const tile = document.createElement("div");
      tile.className = "asset";
      tile.title = `Add "${name}" as a layer`;
      const img = document.createElement("img");
      img.src = this.assetUrls[name];
      const label = document.createElement("div");
      label.className = "name";
      label.textContent = name;

      const actions = document.createElement("div");
      actions.className = "asset-actions";
      // Optional: wrap a screenshot onto the 3D iPhone (wired by the host).
      if (this.hooks.onMockup) {
        const phone = document.createElement("button");
        phone.className = "act phone";
        phone.textContent = "📱";
        phone.title = "Put on iPhone mockup";
        phone.addEventListener("click", (e) => {
          e.stopPropagation();
          this.hooks.onMockup(name);
        });
        actions.appendChild(phone);
      }
      const del = document.createElement("button");
      del.className = "act del";
      del.textContent = "×";
      del.title = "Delete asset";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteAssetByName(name);
      });
      actions.appendChild(del);

      tile.addEventListener("click", () => this.addImageLayer(name));
      tile.append(img, label, actions);
      els.assetGrid.appendChild(tile);
    }
  }

  // ----- input wiring ------------------------------------------------------
  bindControls() {
    const { els } = this;
    els.play.addEventListener("click", () => this.togglePlay());
    els.restart.addEventListener("click", () => {
      this.setTime(0);
      this.play();
    });
    els.scrub.addEventListener("input", () => {
      this.stop();
      this.setTime((Number(els.scrub.value) / 1000) * this.scene.duration);
    });
    els.export.addEventListener("click", () => this.exportVideo());
    els.layerSelect.addEventListener("change", () => this.selectLayer(Number(els.layerSelect.value)));
    if (els.copyXform) els.copyXform.addEventListener("click", () => this.copyXform());

    if (els.assetInput) {
      els.assetInput.addEventListener("change", (e) => {
        this.handleAssetFiles(e.target.files);
        e.target.value = "";
      });
    }
    const stageWrap = this.canvas.closest(".stage-wrap") || this.canvas.parentElement;
    if (stageWrap) {
      stageWrap.addEventListener("dragover", (e) => e.preventDefault());
      stageWrap.addEventListener("drop", (e) => {
        e.preventDefault();
        if (e.dataTransfer?.files?.length) this.handleAssetFiles(e.dataTransfer.files);
      });
    }

    this.canvas.addEventListener("click", (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - r.left) / r.width) * this.scene.width);
      const y = Math.round(((e.clientY - r.top) / r.height) * this.scene.height);
      if (e.shiftKey) {
        this.applyField("x", x);
        this.applyField("y", y);
        this.loadLayerIntoEditor();
        this.recordHistory();
        if (els.coord) els.coord.textContent = `moved layer → x: ${x}, y: ${y}`;
        return;
      }
      const hit = this.renderer.hitTest(x, y, this.time);
      if (hit >= 0) {
        this.selectLayer(hit);
        if (els.coord) els.coord.textContent = `selected → ${this.layerLabel(this.scene.layers[hit], hit)}`;
      } else if (els.coord) {
        els.coord.textContent = `clicked  x: ${x}, y: ${y}`;
      }
    });

    window.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        this.redo();
        return;
      }
      const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (e.code === "Space" && !typing && this.scene) {
        e.preventDefault();
        this.togglePlay();
      }
    });
  }
}

export function blankScene() {
  return { width: 1080, height: 1350, duration: 4.5, fps: 30, background: "#0b0c10", layers: [] };
}

// Download a single asset's bytes by storage path (used by refreshAssets).
async function downloadAsset(path) {
  const { supabase } = await import("./supabaseClient.js");
  const { data } = await supabase.storage.from("assets").download(path);
  return data || null;
}
