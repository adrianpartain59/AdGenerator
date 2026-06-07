// ============================================================================
//  App controller: preview playback + video export.
//  You don't normally need to edit this. Author your ad in scene.js.
// ============================================================================
import { Renderer, preloadScene } from "./engine.js";
import { scene } from "./scene.js";
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm";

const canvas = document.getElementById("stage");
const $ = (id) => document.getElementById(id);

const els = {
  play: $("playPause"),
  restart: $("restart"),
  loop: $("loop"),
  scrub: $("scrub"),
  time: $("time"),
  coord: $("coord"),
  export: $("export"),
  status: $("status"),
  dims: $("dims"),
  layerSelect: $("layerSelect"),
  xform: $("xform"),
  copyXform: $("copyXform"),
};

let renderer;
let assets; // loaded image map, reused for offscreen export
let playing = false;
let time = 0; // current time in seconds
let lastTs = 0;
let recording = false;

// Export resolution multiplier. 1080×1350 × 2 = 2160×2700 (4K-class, 4:5).
const EXPORT_SCALE = 2;

function fmt(t) {
  return `${t.toFixed(2)}s`;
}

function setTime(t) {
  time = Math.max(0, Math.min(scene.duration, t));
  renderer.drawFrame(time);
  els.scrub.value = String((time / scene.duration) * 1000);
  els.time.textContent = `${fmt(time)} / ${fmt(scene.duration)}`;
}

function tick(ts) {
  if (!playing) return;
  if (!lastTs) lastTs = ts;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;

  let next = time + dt;
  if (next >= scene.duration) {
    if (els.loop.checked && !recording) {
      next = next % scene.duration;
    } else {
      next = scene.duration;
      setTime(next);
      stop();
      return;
    }
  }
  setTime(next);
  requestAnimationFrame(tick);
}

function play() {
  if (playing) return;
  if (time >= scene.duration) time = 0;
  playing = true;
  lastTs = 0;
  els.play.textContent = "❚❚ Pause";
  requestAnimationFrame(tick);
}

function stop() {
  playing = false;
  els.play.textContent = "▶ Play";
}

function togglePlay() {
  playing ? stop() : play();
}

// --------------------------------------------------------------------------
//  Export to MP4 (H.264) using WebCodecs. Renders every frame offscreen at
//  EXPORT_SCALE and encodes it directly — nothing has to play in the tab.
// --------------------------------------------------------------------------
async function exportVideo() {
  // Fall back to WebM if WebCodecs / MP4 encoding isn't available.
  if (typeof VideoEncoder === "undefined") {
    els.status.textContent = "WebCodecs unavailable — exporting WebM instead…";
    return exportVideoWebM();
  }

  const fps = scene.fps || 30;
  // H.264 4:2:0 needs even dimensions.
  const width = Math.round((scene.width * EXPORT_SCALE) / 2) * 2;
  const height = Math.round((scene.height * EXPORT_SCALE) / 2) * 2;
  const config = {
    codec: "avc1.640033", // H.264 High Profile, Level 5.1 (handles 4K-class)
    width,
    height,
    bitrate: 30_000_000, // 30 Mbps for high quality
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
    return exportVideoWebM();
  }

  stop();
  recording = true;
  els.export.disabled = true;
  els.play.disabled = true;
  els.status.textContent = "Preparing MP4…";

  // Offscreen canvas + renderer at export resolution (never shown on screen).
  const off = document.createElement("canvas");
  const offRenderer = new Renderer(off, scene, assets, EXPORT_SCALE);

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
  const frameDur = 1_000_000 / fps; // microseconds

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

      // Apply backpressure if the encoder falls behind; otherwise yield so the
      // progress text repaints. No real-time playback required either way.
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `static-ad-${Date.now()}.mp4`;
    a.click();
    URL.revokeObjectURL(url);
    els.status.textContent = `Exported ✓  MP4 ${width}×${height}`;
  } catch (err) {
    console.error(err);
    els.status.textContent = `Export failed: ${err.message}`;
  } finally {
    try {
      encoder.close();
    } catch {}
    recording = false;
    els.export.disabled = false;
    els.play.disabled = false;
    setTime(time); // restore the on-screen preview frame
  }
}

// --------------------------------------------------------------------------
//  Fallback: WebM via MediaRecorder on the canvas stream (real-time capture).
// --------------------------------------------------------------------------
function pickMime() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || "";
}

async function exportVideoWebM() {
  const mime = pickMime();
  if (!mime) {
    els.status.textContent = "Export not supported in this browser.";
    return;
  }
  stop();
  recording = true;
  els.export.disabled = true;
  els.play.disabled = true;
  els.status.textContent = "Recording…";

  const fps = scene.fps || 30;
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 16_000_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const finished = new Promise((res) => (rec.onstop = res));

  // Drive the animation in real time from 0 -> duration while recording.
  setTime(0);
  rec.start();
  await new Promise((resolve) => {
    let last = 0;
    function step(ts) {
      if (!last) last = ts;
      const dt = (ts - last) / 1000;
      last = ts;
      const next = time + dt;
      if (next >= scene.duration) {
        setTime(scene.duration);
        resolve();
        return;
      }
      setTime(next);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
  // Give the recorder a beat to capture the final frame.
  await new Promise((r) => setTimeout(r, 250));
  rec.stop();
  await finished;

  const blob = new Blob(chunks, { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `static-ad-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);

  recording = false;
  els.export.disabled = false;
  els.play.disabled = false;
  els.status.textContent = "Exported ✓  (WebM)";
}

// --------------------------------------------------------------------------
//  Layer transform editor (position X/Y/Z + rotation X/Y/Z)
// --------------------------------------------------------------------------
const XFORM_FIELDS = [
  { key: "x", label: "Pos X", min: -200, max: scene.width + 200, step: 1, def: 0 },
  { key: "y", label: "Pos Y", min: -200, max: scene.height + 200, step: 1, def: 0 },
  { key: "z", label: "Z order", min: -100, max: 100, step: 1, def: 0 },
  { key: "scale", label: "Scale", min: 0.1, max: 3, step: 0.05, def: 1 },
  { key: "rotationX", label: "Rot X", min: -180, max: 180, step: 1, def: 0 },
  { key: "rotationY", label: "Rot Y", min: -180, max: 180, step: 1, def: 0 },
  { key: "rotation", label: "Rot Z", min: -180, max: 180, step: 1, def: 0 },
];

let selectedLayer = 0;
const fieldEls = {}; // key -> { range, num }

function layerLabel(layer, i) {
  let detail = "";
  if (layer.type === "image" && layer.src) detail = layer.src.split("/").pop();
  else if (layer.text) detail = layer.text.replace(/\s+/g, " ").trim().slice(0, 22);
  else if (layer.spans) detail = layer.spans.map((s) => s.text).join("").replace(/\s+/g, " ").trim().slice(0, 22);
  return `${i + 1}. ${layer.type}${detail ? " · " + detail : ""}`;
}

function applyField(key, value) {
  scene.layers[selectedLayer][key] = value;
  renderer.drawFrame(time); // reflect immediately (also fine while playing)
}

function selectLayer(i) {
  if (i < 0 || i >= scene.layers.length) return;
  selectedLayer = i;
  els.layerSelect.value = String(i);
  loadLayerIntoEditor();
}

function loadLayerIntoEditor() {
  const layer = scene.layers[selectedLayer];
  for (const f of XFORM_FIELDS) {
    const v = layer[f.key] ?? f.def;
    fieldEls[f.key].range.value = String(v);
    fieldEls[f.key].num.value = String(v);
  }
}

async function copyXform() {
  const layer = scene.layers[selectedLayer];
  const out = {};
  for (const f of XFORM_FIELDS) {
    const v = layer[f.key];
    if (v !== undefined && v !== f.def) out[f.key] = v;
  }
  const text = JSON.stringify(out, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    els.status.textContent = "Copied transform values ✓";
  } catch {
    els.status.textContent = text;
  }
}

function buildEditor() {
  // Layer dropdown
  els.layerSelect.innerHTML = "";
  scene.layers.forEach((layer, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = layerLabel(layer, i);
    els.layerSelect.appendChild(opt);
  });
  els.layerSelect.addEventListener("change", () => {
    selectLayer(Number(els.layerSelect.value));
  });

  // Slider + number rows
  els.xform.innerHTML = "";
  for (const f of XFORM_FIELDS) {
    const row = document.createElement("div");
    row.className = "xrow";

    const lab = document.createElement("label");
    lab.textContent = f.label;

    const range = document.createElement("input");
    range.type = "range";
    range.min = f.min;
    range.max = f.max;
    range.step = f.step;

    const num = document.createElement("input");
    num.type = "number";
    num.min = f.min;
    num.max = f.max;
    num.step = f.step;

    range.addEventListener("input", () => {
      num.value = range.value;
      applyField(f.key, Number(range.value));
    });
    num.addEventListener("input", () => {
      range.value = num.value;
      applyField(f.key, Number(num.value));
    });

    row.append(lab, range, num);
    els.xform.appendChild(row);
    fieldEls[f.key] = { range, num };
  }

  els.copyXform.addEventListener("click", copyXform);
  loadLayerIntoEditor();
}

// --------------------------------------------------------------------------
//  Wire up controls
// --------------------------------------------------------------------------
function bindControls() {
  els.play.addEventListener("click", togglePlay);
  els.restart.addEventListener("click", () => {
    setTime(0);
    play();
  });
  els.scrub.addEventListener("input", () => {
    stop();
    setTime((Number(els.scrub.value) / 1000) * scene.duration);
  });
  els.export.addEventListener("click", exportVideo);

  // Click the canvas to read coordinates (handy for placing layers).
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const x = Math.round(((e.clientX - r.left) / r.width) * scene.width);
    const y = Math.round(((e.clientY - r.top) / r.height) * scene.height);
    if (e.shiftKey) {
      // Shift-click moves the selected layer to this point.
      applyField("x", x);
      applyField("y", y);
      loadLayerIntoEditor();
      els.coord.textContent = `moved layer → x: ${x}, y: ${y}`;
      return;
    }
    // Plain click selects the topmost element under the cursor.
    const hit = renderer.hitTest(x, y, time);
    if (hit >= 0) {
      selectLayer(hit);
      els.coord.textContent = `selected → ${layerLabel(scene.layers[hit], hit)}`;
    } else {
      els.coord.textContent = `clicked  x: ${x}, y: ${y}`;
    }
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
  });
}

async function init() {
  els.dims.textContent = `${scene.width} × ${scene.height} · ${scene.fps}fps · ${scene.duration}s`;
  els.status.textContent = "Loading assets…";
  try {
    assets = await preloadScene(scene);
    renderer = new Renderer(canvas, scene, assets);
    bindControls();
    buildEditor();
    setTime(0);
    els.status.textContent = "Ready";
    play();
  } catch (err) {
    console.error(err);
    els.status.textContent = `Error: ${err.message}`;
  }
}

init();
