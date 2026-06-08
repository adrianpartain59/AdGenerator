// ============================================================================
//  Static Ad Generator - Animation Engine
//  Renders a "scene" (a list of layers) onto a canvas and animates it over
//  time. You define the scene + animations as data in scene.js; this file
//  knows how to draw and tween them. You normally don't need to edit this.
// ============================================================================

// ---------------------------------------------------------------------------
//  Easing functions
//  Reference these by name (string) in your animation keyframes, e.g.
//      { prop: 'opacity', from: 0, to: 1, start: 0, duration: 0.5, ease: 'easeOutCubic' }
// ---------------------------------------------------------------------------
export const Easing = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  easeOutQuart: (t) => 1 - Math.pow(1 - t, 4),
  easeOutExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeOutElastic: (t) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0
      ? 0
      : t === 1
      ? 1
      : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
};

// Animatable transform properties and their defaults. These never change the
// layer's "base" layout values, they are applied on top at render time, which
// keeps animation code separate from layout.
const TRANSFORM_DEFAULTS = {
  opacity: 1, // 0..1
  tx: 0, // translate X (px)
  ty: 0, // translate Y (px)
  scale: 1, // uniform scale around the layer anchor
  rotation: 0, // degrees, in-plane (Z axis) rotation around the layer anchor
  rotationX: 0, // degrees, pseudo-3D tilt around the X axis (foreshortens height)
  rotationY: 0, // degrees, pseudo-3D tilt around the Y axis (foreshortens width)
};

// ---------------------------------------------------------------------------
//  Asset loading
// ---------------------------------------------------------------------------
const imageCache = new Map();

export function loadImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    img.src = src;
  });
  imageCache.set(src, p);
  return p;
}

// Preload every image referenced by the scene so the first frame is correct.
// `resolve` maps a layer's logical src (e.g. "Vial.png") to an actual URL such
// as an object URL for a project asset; by default src is used as-is. The
// returned Map stays keyed by the original layer.src so drawing code is
// unaffected.
export async function preloadScene(scene, resolve = (s) => s) {
  const srcs = new Set();
  for (const layer of scene.layers) {
    if (layer.type === "image" && layer.src) srcs.add(layer.src);
  }
  const arr = [...srcs];
  const loaded = await Promise.all(arr.map((s) => loadImage(resolve(s) ?? s)));
  const map = new Map();
  arr.forEach((s, i) => map.set(s, loaded[i]));
  return map;
}

// ---------------------------------------------------------------------------
//  Animation resolution: given a layer and a time, compute the current value
//  of each transform property.
// ---------------------------------------------------------------------------
function resolveProp(layer, prop, time) {
  const base = TRANSFORM_DEFAULTS[prop];
  const anims = (layer.animations || []).filter((a) => a.prop === prop);
  if (anims.length === 0) return layer[prop] ?? base;

  // Start from the layer's declared static value (or the default).
  let value = layer[prop] ?? base;

  // Apply each animation in order. Each one is authoritative for its window.
  for (const a of anims) {
    const start = a.start ?? 0;
    const duration = a.duration ?? 0;
    const from = a.from ?? value;
    const to = a.to ?? value;
    const ease = Easing[a.ease] || Easing.easeOutCubic;

    if (time <= start) {
      value = from;
    } else if (time >= start + duration) {
      value = to;
    } else {
      const t = duration === 0 ? 1 : (time - start) / duration;
      value = from + (to - from) * ease(t);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
//  Drawing
// ---------------------------------------------------------------------------
function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  if (!maxWidth) return text.split("\n");
  const lines = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawImageLayer(ctx, layer, assets) {
  const img = assets.get(layer.src);
  if (!img) return;
  let w = layer.width;
  let h = layer.height;
  if (w && !h) h = (img.height / img.width) * w;
  if (h && !w) w = (img.width / img.height) * h;
  if (!w && !h) {
    w = img.width;
    h = img.height;
  }
  // x/y is the anchor point. Default anchor is center.
  const anchor = layer.anchor || "center";
  const { ox, oy } = anchorOffset(anchor, w, h);
  ctx.drawImage(img, -ox, -oy, w, h);
}

function drawTextLayer(ctx, layer) {
  const size = layer.size ?? 48;
  const weight = layer.weight ?? "normal";
  const family = layer.font ?? "Inter, system-ui, sans-serif";
  const lineHeight = layer.lineHeight ?? size * 1.15;
  ctx.font = `${weight} ${size}px ${family}`;
  ctx.textBaseline = "top";
  ctx.textAlign = layer.align ?? "left";

  const lines = wrapText(ctx, layer.text ?? "", layer.maxWidth);
  const align = layer.align ?? "left";

  // Horizontal gradient spanning the widest line (for neon-style fills).
  let gradientFill = null;
  if (layer.gradient) {
    let maxW = 0;
    lines.forEach((l) => (maxW = Math.max(maxW, ctx.measureText(l).width)));
    let gx0 = 0;
    let gx1 = maxW;
    if (align === "center") {
      gx0 = -maxW / 2;
      gx1 = maxW / 2;
    } else if (align === "right") {
      gx0 = -maxW;
      gx1 = 0;
    }
    gradientFill = ctx.createLinearGradient(gx0, 0, gx1, 0);
    layer.gradient.forEach((stop) => gradientFill.addColorStop(stop.at, stop.color));
  }

  lines.forEach((line, i) => {
    const y = i * lineHeight;
    if (layer.shadow) {
      ctx.save();
      ctx.shadowColor = layer.shadow.color ?? "rgba(0,0,0,0.5)";
      ctx.shadowBlur = layer.shadow.blur ?? 12;
      ctx.shadowOffsetX = layer.shadow.x ?? 0;
      ctx.shadowOffsetY = layer.shadow.y ?? 4;
    }
    ctx.fillStyle = gradientFill ?? layer.color ?? "#ffffff";
    ctx.fillText(line, 0, y);
    if (layer.shadow) ctx.restore();

    if (layer.stroke) {
      ctx.lineWidth = layer.stroke.width ?? 2;
      ctx.strokeStyle = layer.stroke.color ?? "#000";
      ctx.strokeText(line, 0, y);
    }
  });
}

// Rich text: layer.spans = [{ text, bold?, color?, size? }, ...]
// Renders mixed weights/colors on one block, wrapping at maxWidth. Supports
// per-word styling so you can bold key metrics inside a sentence.
function drawRichText(ctx, layer) {
  const size = layer.size ?? 32;
  const family = layer.font ?? "Inter, system-ui, sans-serif";
  const baseWeight = layer.weight ?? "400";
  const boldWeight = layer.boldWeight ?? "700";
  const baseColor = layer.color ?? "#ffffff";
  const lineHeight = layer.lineHeight ?? size * 1.3;
  const align = layer.align ?? "left";
  const maxWidth = layer.maxWidth ?? Infinity;

  const fontFor = (span) =>
    `${span && span.bold ? boldWeight : baseWeight} ${size}px ${family}`;

  // Tokenize spans into words / spaces / newlines, preserving each word's style.
  const tokens = [];
  for (const span of layer.spans) {
    const parts = (span.text ?? "").split(/(\s+)/);
    for (const part of parts) {
      if (part === "") continue;
      if (/\n/.test(part)) tokens.push({ type: "newline" });
      else if (/^\s+$/.test(part)) tokens.push({ type: "space", span });
      else tokens.push({ type: "word", text: part, span });
    }
  }

  // Wrap into lines.
  const lines = [];
  let line = [];
  let width = 0;
  for (const tk of tokens) {
    if (tk.type === "newline") {
      lines.push(line);
      line = [];
      width = 0;
      continue;
    }
    ctx.font = tk.type === "word" ? fontFor(tk.span) : `${baseWeight} ${size}px ${family}`;
    const w = ctx.measureText(tk.type === "word" ? tk.text : " ").width;
    if (tk.type === "word" && width + w > maxWidth && line.length) {
      if (line[line.length - 1]?.type === "space") {
        width -= line.pop().width;
      }
      lines.push(line);
      line = [];
      width = 0;
    }
    line.push({ ...tk, width: w });
    width += w;
  }
  if (line.length) lines.push(line);

  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  lines.forEach((lineTokens, i) => {
    const lineWidth = lineTokens.reduce((a, t) => a + t.width, 0);
    let x = 0;
    if (align === "center") x = -lineWidth / 2;
    else if (align === "right") x = -lineWidth;
    const y = i * lineHeight;

    for (const t of lineTokens) {
      if (t.type === "word") {
        if (layer.shadow) {
          ctx.save();
          ctx.shadowColor = layer.shadow.color ?? "rgba(0,0,0,0.5)";
          ctx.shadowBlur = layer.shadow.blur ?? 12;
          ctx.shadowOffsetX = layer.shadow.x ?? 0;
          ctx.shadowOffsetY = layer.shadow.y ?? 4;
        }
        ctx.font = fontFor(t.span);
        ctx.fillStyle = t.span.color ?? baseColor;
        ctx.fillText(t.text, x, y);
        if (layer.shadow) ctx.restore();
      }
      x += t.width;
    }
  });
}

function drawButtonLayer(ctx, layer) {
  const w = layer.width ?? 300;
  const h = layer.height ?? 80;
  const radius = layer.radius ?? h / 2;
  // x/y is the anchor point.
  const anchor = layer.anchor || "center";
  const { ox, oy } = anchorOffset(anchor, w, h);
  const left = -ox;
  const top = -oy;

  if (layer.shadow) {
    ctx.save();
    ctx.shadowColor = layer.shadow.color ?? "rgba(0,0,0,0.35)";
    ctx.shadowBlur = layer.shadow.blur ?? 24;
    ctx.shadowOffsetX = layer.shadow.x ?? 0;
    ctx.shadowOffsetY = layer.shadow.y ?? 8;
  }

  roundRectPath(ctx, left, top, w, h, radius);
  if (layer.gradient) {
    const g = ctx.createLinearGradient(left, top, left + w, top);
    layer.gradient.forEach((stop) => g.addColorStop(stop.at, stop.color));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = layer.bg ?? "#2563eb";
  }
  ctx.fill();
  if (layer.shadow) ctx.restore();

  if (layer.border) {
    ctx.lineWidth = layer.border.width ?? 2;
    ctx.strokeStyle = layer.border.color ?? "#ffffff";
    roundRectPath(ctx, left, top, w, h, radius);
    ctx.stroke();
  }

  if (layer.text) {
    const size = layer.size ?? 32;
    const weight = layer.weight ?? "600";
    const family = layer.font ?? "Inter, system-ui, sans-serif";
    ctx.font = `${weight} ${size}px ${family}`;
    ctx.fillStyle = layer.color ?? "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(layer.text, left + w / 2, top + h / 2 + (layer.textOffsetY ?? 0));
  }
}

function anchorOffset(anchor, w, h) {
  // Returns the offset from the anchor point to the top-left corner.
  let ox = w / 2;
  let oy = h / 2;
  if (anchor.includes("left")) ox = 0;
  if (anchor.includes("right")) ox = w;
  if (anchor.includes("top")) oy = 0;
  if (anchor.includes("bottom")) oy = h;
  return { ox, oy };
}

// ---------------------------------------------------------------------------
//  Renderer: draws one frame of the scene at the given time (seconds).
// ---------------------------------------------------------------------------
export class Renderer {
  constructor(canvas, scene, assets, renderScale = 1) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scene = scene;
    this.assets = assets;
    this.renderScale = renderScale;
    canvas.width = scene.width * renderScale;
    canvas.height = scene.height * renderScale;
  }

  drawFrame(time) {
    const { ctx, scene } = this;
    // Draw everything in scene coordinates; renderScale upscales the output
    // (e.g. for 4K export) without touching any layout math.
    const s = this.renderScale || 1;
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, scene.width, scene.height);

    // Background
    if (scene.background) {
      if (Array.isArray(scene.background)) {
        const g = ctx.createLinearGradient(0, 0, 0, scene.height);
        scene.background.forEach((s) => g.addColorStop(s.at, s.color));
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = scene.background;
      }
      ctx.fillRect(0, 0, scene.width, scene.height);
    }

    // Draw in z-order (low z behind, high z in front); ties keep array order.
    for (const layer of this.orderedLayers()) {
      if (layer.visible === false) continue;

      // Resolve animated transform values for this moment in time.
      const opacity = resolveProp(layer, "opacity", time);
      const tx = resolveProp(layer, "tx", time);
      const ty = resolveProp(layer, "ty", time);
      const scale = resolveProp(layer, "scale", time);
      const rotation = resolveProp(layer, "rotation", time);
      const rotationX = resolveProp(layer, "rotationX", time);
      const rotationY = resolveProp(layer, "rotationY", time);

      if (opacity <= 0) continue;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
      ctx.translate((layer.x ?? 0) + tx, (layer.y ?? 0) + ty);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      // X/Y tilt foreshorten one axis (pseudo-3D); scale is uniform.
      const sx = scale * Math.cos((rotationY * Math.PI) / 180);
      const sy = scale * Math.cos((rotationX * Math.PI) / 180);
      if (sx !== 1 || sy !== 1) ctx.scale(sx, sy);

      switch (layer.type) {
        case "image":
          drawImageLayer(ctx, layer, this.assets);
          break;
        case "text":
          if (layer.spans) drawRichText(ctx, layer);
          else drawTextLayer(ctx, layer);
          break;
        case "button":
          drawButtonLayer(ctx, layer);
          break;
        default:
          break;
      }
      ctx.restore();
    }
  }

  // Layer indices sorted by z (ascending = back to front). Stable: equal z
  // keeps the original array order.
  orderedIndices() {
    return this.scene.layers
      .map((_, i) => i)
      .sort((a, b) => {
        const za = this.scene.layers[a].z ?? 0;
        const zb = this.scene.layers[b].z ?? 0;
        return za - zb || a - b;
      });
  }

  orderedLayers() {
    return this.orderedIndices().map((i) => this.scene.layers[i]);
  }

  // Local-space bounding box for a layer: { w, h, left, top }, where left/top
  // is the offset from the layer's anchor point to the box's top-left corner
  // (before translate/rotate/scale are applied).
  measureLayer(layer) {
    const { ctx } = this;
    if (layer.type === "image") {
      const img = this.assets.get(layer.src);
      let w = layer.width;
      let h = layer.height;
      if (img) {
        if (w && !h) h = (img.height / img.width) * w;
        else if (h && !w) w = (img.width / img.height) * h;
        else if (!w && !h) {
          w = img.width;
          h = img.height;
        }
      }
      w = w || 0;
      h = h || 0;
      const { ox, oy } = anchorOffset(layer.anchor || "center", w, h);
      return { w, h, left: -ox, top: -oy };
    }

    if (layer.type === "button") {
      const w = layer.width ?? 300;
      const h = layer.height ?? 80;
      const { ox, oy } = anchorOffset(layer.anchor || "center", w, h);
      return { w, h, left: -ox, top: -oy };
    }

    if (layer.type === "text") {
      const isRich = !!layer.spans;
      const size = layer.size ?? (isRich ? 32 : 48);
      const family = layer.font ?? "Inter, system-ui, sans-serif";
      const weight = layer.weight ?? (isRich ? "400" : "normal");
      const lineHeight = layer.lineHeight ?? size * (isRich ? 1.3 : 1.15);
      ctx.font = `${weight} ${size}px ${family}`;
      const text = isRich
        ? layer.spans.map((s) => s.text ?? "").join("")
        : layer.text ?? "";
      const lines = wrapText(ctx, text, layer.maxWidth);
      let w = 0;
      for (const l of lines) w = Math.max(w, ctx.measureText(l).width);
      const h = lines.length * lineHeight;
      const align = layer.align ?? "left";
      let left = 0;
      if (align === "center") left = -w / 2;
      else if (align === "right") left = -w;
      return { w, h, left, top: 0 };
    }

    return { w: 0, h: 0, left: 0, top: 0 };
  }

  // Returns the index of the topmost visible layer under scene point (px, py)
  // at the given time, or -1 if none.
  hitTest(px, py, time) {
    // Walk front-to-back (reverse of draw order) so the topmost layer wins.
    const order = this.orderedIndices();
    for (let k = order.length - 1; k >= 0; k--) {
      const i = order[k];
      const layer = this.scene.layers[i];
      if (layer.visible === false) continue;
      if (resolveProp(layer, "opacity", time) <= 0) continue;

      const tx = resolveProp(layer, "tx", time);
      const ty = resolveProp(layer, "ty", time);
      const scale = resolveProp(layer, "scale", time);
      const rotation = resolveProp(layer, "rotation", time);
      const rotationX = resolveProp(layer, "rotationX", time);
      const rotationY = resolveProp(layer, "rotationY", time);
      const sx = scale * Math.cos((rotationY * Math.PI) / 180);
      const sy = scale * Math.cos((rotationX * Math.PI) / 180);
      if (!sx || !sy) continue;

      // Inverse-transform the point into the layer's local space.
      const dx = px - ((layer.x ?? 0) + tx);
      const dy = py - ((layer.y ?? 0) + ty);
      const rad = -(rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const lx = (dx * cos - dy * sin) / sx;
      const ly = (dx * sin + dy * cos) / sy;

      const b = this.measureLayer(layer);
      if (lx >= b.left && lx <= b.left + b.w && ly >= b.top && ly <= b.top + b.h) {
        return i;
      }
    }
    return -1;
  }
}
