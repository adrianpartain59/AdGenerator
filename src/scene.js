// ============================================================================
//  YOUR AD GOES HERE  ✏️
//  This is the only file you normally edit. A "scene" is:
//    - canvas size + duration
//    - a background
//    - a list of "layers" (images, text, buttons) drawn bottom-to-top
//  Each layer can have an `animations` array (you write these by hand).
//
//  COORDINATES: x/y is the layer's ANCHOR point (default anchor = "center").
//  Tip: click anywhere on the preview canvas to read its x,y coordinate.
//
//  TEXT can be a plain string (`text:`), optionally with a horizontal
//  `gradient`, OR rich text (`spans:`) where each segment can be bold/colored
//  for highlighting key words inline.
//
//  ANIMATION KEYFRAME shape:
//    { prop, from, to, start, duration, ease }
//      prop:     "opacity" | "tx" | "ty" | "scale" | "rotation"
//      start/duration in seconds. ease names live in engine.js > Easing.
//    tx/ty/scale/rotation are applied ON TOP of x/y (use for slide/pop/drift).
// ============================================================================

export const scene = {
  width: 1080,
  height: 1350, // 4:5 portrait (Instagram / feed ad)
  duration: 4.5,
  fps: 30,

  background: "#000000",

  layers: [
    // ----- Background (full bleed, subtle slow zoom) -------------------------
    {
      type: "image",
      src: "assets/CleanBackground.png",
      x: 540,
      y: 675,
      width: 1080,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0, duration: 0.8, ease: "easeOutCubic" },
        { prop: "scale", from: 1.08, to: 1.0, start: 0, duration: 7, ease: "easeOutQuad" },
      ],
    },

    // ----- Lifestyle mockup (behind, right) ----------------------------------
    {
      type: "image",
      src: "assets/LifestyleMockup.png",
      x: 705,
      y: 1120,
      width: 300,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.35, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: 240, to: 0, start: 0.35, duration: 0.9, ease: "easeOutCubic" },
        { prop: "scale", from: 0.92, to: 1.0, start: 0.35, duration: 0.9, ease: "easeOutBack" },
      ],
    },

    // ----- Home mockup (front, left) -----------------------------------------
    {
      type: "image",
      src: "assets/HomeMockup.png",
      x: 415,
      y: 1150,
      width: 330,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.55, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: 260, to: 0, start: 0.55, duration: 0.9, ease: "easeOutCubic" },
        { prop: "scale", from: 0.92, to: 1.0, start: 0.55, duration: 0.9, ease: "easeOutBack" },
      ],
    },

    // ----- Logo / brand ------------------------------------------------------
    {
      type: "image",
      src: "assets/pepaiLogoBottleDark.png",
      x: 410,
      y: 116,
      width: 78,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.1, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: -30, to: 0, start: 0.1, duration: 0.6, ease: "easeOutCubic" },
      ],
    },
    {
      type: "text",
      x: 525,
      y: 95,
      align: "center",
      size: 52,
      weight: "800",
      spans: [
        { text: "Pep ", color: "#ffffff" },
        { text: "AI", color: "#3b82f6" },
      ],
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.1, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: -30, to: 0, start: 0.1, duration: 0.6, ease: "easeOutCubic" },
      ],
    },

    // ----- Headline (single, neon blue→purple→pink gradient) -----------------
    {
      type: "text",
      text: "Master Your Routine.\nMaximize Results.",
      x: 540,
      y: 185,
      align: "center",
      font: "Inter, system-ui, sans-serif",
      size: 84,
      weight: "800",
      lineHeight: 92,
      gradient: [
        { at: 0, color: "#5b8cff" },
        { at: 0.5, color: "#a855f7" },
        { at: 1, color: "#ec4899" },
      ],
      shadow: { color: "rgba(139,92,246,0.45)", blur: 36, y: 0 },
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.3, duration: 0.7, ease: "easeOutCubic" },
        { prop: "ty", from: 50, to: 0, start: 0.3, duration: 0.8, ease: "easeOutCubic" },
      ],
    },

    // ----- Subheadline (rich text — key terms bolded) ------------------------
    {
      type: "text",
      x: 540,
      y: 440,
      align: "center",
      size: 48,
      weight: "400",
      color: "#9aa3b2",
      boldWeight: "700",
      lineHeight: 60,
      maxWidth: 860,
      spans: [
        { text: "Precision tracking", bold: true, color: "#ffffff" },
        { text: " for " },
        { text: "GLP-1s, peptides", bold: true, color: "#ffffff" },
        { text: ", and daily lifestyle metrics." },
      ],
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.7, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: 26, to: 0, start: 0.7, duration: 0.6, ease: "easeOutCubic" },
      ],
    },

    // ----- Vial left (outer side of left phone, tilted) ----------------------
    {
      type: "image",
      src: "assets/Vial.png",
      x: 185,
      y: 1060,
      width: 155,
      rotation: -22,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.4, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: 50, to: 0, start: 0.4, duration: 0.9, ease: "easeOutBack" },
        { prop: "scale", from: 0.85, to: 1.0, start: 0.4, duration: 0.9, ease: "easeOutBack" },
      ],
    },

    // ----- Vial right (outer side of right phone, tilted) -------------------
    {
      type: "image",
      src: "assets/Vial.png",
      x: 900,
      y: 1090,
      width: 140,
      rotation: 18,
      anchor: "center",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 0.5, duration: 0.6, ease: "easeOutCubic" },
        { prop: "ty", from: 60, to: 0, start: 0.5, duration: 0.9, ease: "easeOutBack" },
        { prop: "scale", from: 0.85, to: 1.0, start: 0.5, duration: 0.9, ease: "easeOutBack" },
      ],
    },

    // ----- Primary CTA (gradient pill, pops in) ------------------------------
    {
      type: "button",
      text: "Unlock 3 Days Free",
      x: 540,
      y: 645,
      width: 500,
      height: 98,
      radius: 49,
      anchor: "center",
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

    // ----- Micro-copy (trust line under the CTA) -----------------------------
    {
      type: "text",
      text: "No commitment · Cancel anytime · Easy setup",
      x: 540,
      y: 716,
      align: "center",
      size: 22,
      weight: "500",
      color: "#7b8494",
      animations: [
        { prop: "opacity", from: 0, to: 1, start: 1.3, duration: 0.5, ease: "easeOutCubic" },
      ],
    },

  ],
};
