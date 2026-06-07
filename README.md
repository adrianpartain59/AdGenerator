# Static Ad Generator

A tiny, dependency-free tool for turning image assets + text into **moving static ads**.
Author your ad as data in one file, preview it live, and export it as a video.

It does three things:

1. **Add & manipulate text** (headlines, subtext, fake buttons) — all in `src/scene.js`.
2. **Animate** images, text, and buttons — keyframes written by hand (slide, fade, pop, zoom…).
3. **Preview & export** — play/scrub in the browser, then export a video file.

No build step, no npm install. Just static HTML/CSS/JS + the HTML5 Canvas.

---

## Run it

Canvas video export needs the files served over HTTP (not opened as `file://`),
otherwise the browser taints the canvas and blocks export. Start a local server:

```bash
# from the project root
python3 -m http.server 8000
# then open http://localhost:8000
```

(Or use the helper: `./start.sh`)

---

## Author your ad — `src/scene.js`

A scene is the canvas size + duration + a list of **layers** drawn bottom→top.

```js
export const scene = {
  width: 1080,
  height: 1350,     // 4:5 portrait
  duration: 4.5,    // seconds
  fps: 30,
  background: "#05060a",            // or a gradient: [{at:0,color:"#000"}, ...]
  layers: [ /* images, text, buttons */ ],
};
```

### Layer types

**Image**

```js
{ type: "image", src: "assets/phone.png", x: 540, y: 900, width: 620, anchor: "center" }
```

**Text** (supports `\n`, `maxWidth` wrapping, gradient/shadow/stroke)

```js
{ type: "text", text: "Start Free", x: 540, y: 270, align: "center",
  font: '"Playfair Display", serif', size: 150, weight: "700", color: "#fff" }
```

**Button** (a *fake* button — just a rounded rect + label)

```js
{ type: "button", text: "3-Day Free Trial", x: 540, y: 900,
  width: 540, height: 100, radius: 50, bg: "#2563eb", color: "#fff", size: 40 }
```

> `x` / `y` is the layer's **anchor point** (default `"center"`; also `"top left"`, `"bottom"`, etc.).
> Click anywhere on the preview canvas to read its x,y — handy for placing layers.

### Animations (the manual part)

Give any layer an `animations` array. Each entry tweens one property over time:

```js
animations: [
  { prop: "opacity", from: 0, to: 1, start: 0.3, duration: 0.7, ease: "easeOutCubic" },
  { prop: "ty",      from: 60, to: 0, start: 0.3, duration: 0.7, ease: "easeOutBack" },
]
```

- `prop`: `opacity` (0–1), `tx`/`ty` (px offset), `scale` (1 = normal), `rotation` (deg)
- `tx/ty/scale/rotation` are applied **on top of** the layer's `x/y`, so layout and
  motion stay separate (use them for slide-in / pop / drift).
- `ease`: `linear`, `easeOutCubic`, `easeOutBack`, `easeOutExpo`, `easeOutElastic`,
  `easeInOutCubic`, … (full list in `src/engine.js` → `Easing`).

After editing `scene.js`, just **refresh** the browser.

---

## Export

Click **Export Video** → downloads a `.webm`.
To convert to MP4 (e.g. for most ad platforms):

```bash
ffmpeg -i static-ad-*.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart ad.mp4
```

---

## Files

| File             | What it is                                            |
| ---------------- | ----------------------------------------------------- |
| `src/scene.js`   | **Edit this.** Your ad: layers + animations.          |
| `src/engine.js`  | Rendering + tweening engine (rarely needs editing).   |
| `src/main.js`    | Playback controls + video export.                     |
| `index.html` / `styles.css` | The preview UI.                            |
| `assets/`        | Drop your own image assets here.                       |
