// ============================================================================
//  iPhone 3D mockup — wraps a UI screenshot onto a 3D iPhone 17 Pro and renders
//  it to a PNG. Ported from the Mockup repo's app.js into a reusable engine with
//  two entry points:
//     renderMockup({ screenshotBlob, options })  → headless PNG Blob (used by the
//        chat agent's `render_iphone_mockup` action)
//     openMockupModal({ editor, name })          → interactive pose-and-add modal
//        (used by the editor's 📱 button on a screenshot asset)
//
//  Loads the model + studio HDRI copied into assets/3d/. The decoded environment
//  map is cached across instances so repeated renders stay cheap.
// ============================================================================
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

const MODEL_URL = "assets/3d/iPhone%2017%20Pro.glb";
const ENV_URL = "assets/3d/studio_small_08_4k.exr";
const SCREEN_ASPECT = 1206 / 2622; // iPhone 17 Pro display UV aspect

const COLOR_PRESETS = [
  { name: "Silver", hex: "#c9ccce" },
  { name: "Deep Blue", hex: "#2e4257" },
  { name: "Cosmic Orange", hex: "#c8623a" },
  { name: "Black", hex: "#2b2b2e" },
  { name: "Natural", hex: "#9a948b" },
];

// Decoded equirect HDRI, cached (reused for PMREM on each renderer).
let _envEquirect = null;
function loadEnvEquirect() {
  if (_envEquirect) return Promise.resolve(_envEquirect);
  return new Promise((resolve, reject) => {
    new EXRLoader().load(
      ENV_URL,
      (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        _envEquirect = tex;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

// ---------------------------------------------------------------------------
//  The engine: one renderer + scene + phone model bound to a canvas.
// ---------------------------------------------------------------------------
class Mockup {
  constructor(canvas, { interactive = false } = {}) {
    this.canvas = canvas;
    this.interactive = interactive;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = null; // transparent by default

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
    this.camera.position.set(0, 0.05, 0.6);

    this.phone = new THREE.Group();
    this.scene.add(this.phone);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.3));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(1, 2, 2);
    this.scene.add(key);

    this.screenMaterial = null;
    this.defaultScreenMaps = null;
    this.uploadedTexture = null;
    this.uploadedSize = { w: 1, h: 1 };
    this.bodyMaterials = {};
    this.fit = "cover";

    if (interactive) {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.08;
      this.controls.minDistance = 0.15;
      this.controls.maxDistance = 3;
    }
  }

  async load() {
    const [env, gltf] = await Promise.all([
      loadEnvEquirect(),
      new GLTFLoader().loadAsync(MODEL_URL),
    ]);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromEquirectangular(env).texture;
    pmrem.dispose();

    const model = gltf.scene;
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    model.scale.setScalar(0.16 / maxDim);
    model.rotation.y = Math.PI;
    this.phone.add(model);

    model.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.name === "OLED") {
          this.screenMaterial = m;
          this.defaultScreenMaps = { map: m.map, emissiveMap: m.emissiveMap, color: m.color.clone() };
          m.toneMapped = false;
        }
        if (m.name === "Glass") {
          m.opacity = 0.08;
          m.needsUpdate = true;
        }
        if (m.name === "Anodized aluminum") this.bodyMaterials.frame = m;
        if (m.name === "Plastic antena") this.bodyMaterials.antenna = m;
        if (m.name === "Frosted glass") this.bodyMaterials.back = m;
      }
    });
    for (const m of Object.values(this.bodyMaterials)) {
      if (m && m.normalScale) m.normalScale.set(0.1, -0.1);
    }
    if (this.bodyMaterials.frame) this.bodyMaterials.frame.metalness = 0.6;
    this.setBodyColor(COLOR_PRESETS[0].hex);
    this.applyFinish(0.42);
    return this;
  }

  setScreenFromBlob(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      new THREE.TextureLoader().load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        tex.center.set(0.5, 0.5);
        this.uploadedSize = { w: tex.image.width, h: tex.image.height };
        this.uploadedTexture = tex;
        this.applyScreenTexture();
        this.applyFit();
        URL.revokeObjectURL(url);
        this.render();
        resolve();
      });
    });
  }

  applyScreenTexture() {
    const m = this.screenMaterial;
    if (!m || !this.uploadedTexture) return;
    m.map = null;
    m.color = new THREE.Color(0x000000);
    m.emissiveMap = this.uploadedTexture;
    m.emissive = new THREE.Color(0xffffff);
    m.toneMapped = false;
    m.needsUpdate = true;
  }

  applyFit() {
    const t = this.uploadedTexture;
    if (!t) return;
    const imgAspect = this.uploadedSize.w / this.uploadedSize.h;
    t.repeat.set(1, 1);
    t.offset.set(0, 0);
    const wider = imgAspect > SCREEN_ASPECT;
    if (this.fit === "cover") {
      if (wider) {
        const r = SCREEN_ASPECT / imgAspect;
        t.repeat.set(r, 1);
        t.offset.set((1 - r) / 2, 0);
      } else {
        const r = imgAspect / SCREEN_ASPECT;
        t.repeat.set(1, r);
        t.offset.set(0, (1 - r) / 2);
      }
    } else if (this.fit === "contain") {
      if (wider) {
        const r = imgAspect / SCREEN_ASPECT;
        t.repeat.set(1, r);
        t.offset.set(0, (1 - r) / 2);
      } else {
        const r = SCREEN_ASPECT / imgAspect;
        t.repeat.set(r, 1);
        t.offset.set((1 - r) / 2, 0);
      }
    }
    t.repeat.x *= -1; // screen UVs are mirrored along U
    this.render();
  }

  setBodyColor(hex) {
    const c = new THREE.Color(hex);
    if (this.bodyMaterials.frame) this.bodyMaterials.frame.color.copy(c);
    const lighter = c.clone().lerp(new THREE.Color(0xffffff), 0.15);
    if (this.bodyMaterials.antenna) this.bodyMaterials.antenna.color.copy(lighter);
    if (this.bodyMaterials.back) this.bodyMaterials.back.color.copy(c);
    this.render();
  }
  applyFinish(r) {
    for (const m of Object.values(this.bodyMaterials)) if (m) m.roughness = r;
    this.render();
  }
  setBrightness(v) {
    if (this.screenMaterial) {
      this.screenMaterial.emissiveIntensity = v;
      this.screenMaterial.needsUpdate = true;
    }
    this.render();
  }
  setRotation(rotXDeg, rotYDeg) {
    this.phone.rotation.set(
      THREE.MathUtils.degToRad(rotXDeg || 0),
      THREE.MathUtils.degToRad(rotYDeg || 0),
      this.phone.rotation.z
    );
    this.render();
  }
  setBackground(hex, transparent) {
    this.scene.background = transparent ? null : new THREE.Color(hex || "#0b0c10");
    this.render();
  }

  // Apply the agent/modal option bag in one shot.
  applyOptions(opts = {}) {
    if (opts.fit) this.fit = opts.fit;
    if (opts.color) this.setBodyColor(opts.color);
    if (opts.finish != null) this.applyFinish(opts.finish);
    if (opts.brightness != null) this.setBrightness(opts.brightness);
    if (opts.rotX != null || opts.rotY != null) this.setRotation(opts.rotX, opts.rotY);
    this.setBackground(opts.bg, opts.transparent !== false);
    this.applyFit();
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }
  render() {
    if (this.controls) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
  toBlob() {
    this.render();
    return new Promise((res) => this.canvas.toBlob((b) => res(b), "image/png"));
  }
  dispose() {
    this.controls?.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
//  Headless render — used by the chat agent. Returns a transparent PNG Blob.
// ---------------------------------------------------------------------------
export async function renderMockup({ screenshotBlob, options = {} }) {
  const width = options.width || 1080;
  const height = options.height || 1350;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const mk = new Mockup(canvas, { interactive: false });
  try {
    mk.renderer.setPixelRatio(1);
    mk.renderer.setSize(width, height, false);
    mk.camera.aspect = width / height;
    mk.camera.updateProjectionMatrix();
    await mk.load();
    await mk.setScreenFromBlob(screenshotBlob);
    mk.applyOptions({ transparent: true, ...options });
    return await mk.toBlob();
  } finally {
    mk.dispose();
  }
}

// ---------------------------------------------------------------------------
//  Interactive modal — pose the phone by hand, then add the render as an asset.
// ---------------------------------------------------------------------------
export async function openMockupModal({ editor, name }) {
  const blob = editor.getAssetBlob(name);
  if (!blob) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal mockup-modal">
      <div class="modal-head">
        <span>iPhone mockup — ${name}</span>
        <button class="modal-close" title="Close">×</button>
      </div>
      <div class="mockup-body">
        <div class="mockup-stage"><canvas class="mockup-canvas"></canvas></div>
        <div class="mockup-controls">
          <label class="row"><span>Color</span><span class="swatches"></span></label>
          <label class="row"><span>Custom</span><input type="color" class="mk-color" value="#c9ccce" /></label>
          <label class="row"><span>Rotate Y</span><input type="range" class="mk-rotY" min="-180" max="180" value="-15" /></label>
          <label class="row"><span>Rotate X</span><input type="range" class="mk-rotX" min="-60" max="60" value="6" /></label>
          <label class="row"><span>Fit</span>
            <select class="mk-fit"><option value="cover">Cover</option><option value="contain">Contain</option></select>
          </label>
          <label class="row"><span>Brightness</span><input type="range" class="mk-bright" min="0" max="3" step="0.05" value="1.2" /></label>
          <label class="check"><input type="checkbox" class="mk-transparent" checked /><span>Transparent background</span></label>
          <label class="row"><span>Background</span><input type="color" class="mk-bg" value="#0b0c10" /></label>
          <div class="mockup-actions">
            <button class="btn primary mk-add">＋ Add render to project</button>
          </div>
          <div class="mockup-status"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (s) => overlay.querySelector(s);
  const canvas = $(".mockup-canvas");
  const status = $(".mockup-status");
  const close = () => {
    mk.dispose();
    overlay.remove();
  };
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  status.textContent = "Loading 3D model…";
  const mk = new Mockup(canvas, { interactive: true });
  const stage = $(".mockup-stage");
  const fit = () => mk.resize(stage.clientWidth, stage.clientHeight);
  await mk.load();
  await mk.setScreenFromBlob(blob);
  fit();
  window.addEventListener("resize", fit);

  // swatches
  const sw = $(".swatches");
  for (const p of COLOR_PRESETS) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.style.background = p.hex;
    b.title = p.name;
    b.addEventListener("click", () => mk.setBodyColor(p.hex));
    sw.appendChild(b);
  }

  const opts = { rotX: 6, rotY: -15, fit: "cover", brightness: 1.2, transparent: true, bg: "#0b0c10" };
  mk.applyOptions(opts);
  status.textContent = "Drag to orbit. Pose, then add to your project.";

  $(".mk-color").addEventListener("input", (e) => mk.setBodyColor(e.target.value));
  $(".mk-rotY").addEventListener("input", (e) => mk.setRotation(+$(".mk-rotX").value, +e.target.value));
  $(".mk-rotX").addEventListener("input", (e) => mk.setRotation(+e.target.value, +$(".mk-rotY").value));
  $(".mk-fit").addEventListener("change", (e) => {
    mk.fit = e.target.value;
    mk.applyFit();
  });
  $(".mk-bright").addEventListener("input", (e) => mk.setBrightness(+e.target.value));
  const applyBg = () => mk.setBackground($(".mk-bg").value, $(".mk-transparent").checked);
  $(".mk-transparent").addEventListener("change", applyBg);
  $(".mk-bg").addEventListener("input", applyBg);

  $(".mk-add").addEventListener("click", async () => {
    status.textContent = "Rendering…";
    const out = await mk.toBlob();
    const newName = editor.uniqueAssetName(name.replace(/\.[^.]+$/, "") + "-iphone.png");
    await editor.addAssetBlob(newName, out, "mockup");
    status.textContent = `Added “${newName}”.`;
    setTimeout(close, 600);
  });
}
