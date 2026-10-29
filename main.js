import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ====================== EDIT THESE ====================== */

// Path to your Blender export.
const MODEL_URL = 'models/yuh.glb';

// Posters appear AFTER the model animation finishes.
// The real length is read from the file automatically. These two numbers
// are only used if the file has no animation: 100 frames / 24 fps ≈ 4.2s.
// (Use the frame rate from Blender: Output Properties > Frame Rate.)
const ANIMATION_FRAMES = 100;
const FPS = 24;
const EXTRA_DELAY = 0;          // extra seconds to wait after the trigger point

// When do the posters appear? 0.5 = halfway through the animation, 1 = at the end.
const REVEAL_AT = 0.5;
// true  = the animation STOPS exactly at the reveal point (only half plays).
// false = the animation keeps playing to the end while the posters sprout.
const STOP_AT_REVEAL = true;

// ---- Your posters ----
// Put your files in the "posters" folder, named 1, 2, 3 ... up to POSTER_COUNT.
// The extension (png, jpg, mp4 ...) is found automatically.
const POSTER_FOLDER = 'posters/';
const POSTER_COUNT = 35;
const POSTER_EXTENSIONS = ['png', 'jpg', 'JPG', 'jpeg', 'PNG', 'JPEG', 'webp', 'pic.jpg', 'gif', 'mp4', 'webm', 'mov'];
// Files whose exact names are known (taken from your screenshot). Add more if needed.
const POSTER_OVERRIDES = {
  9: '9.JPG', 10: '10.mp4', 15: '15.jpg', 16: '16.mp4',
  17: '17.pic.jpg', 18: '18.pic.jpg', 25: '25.JPG', 34: '34.jpg'
};

// Optional: list posters by hand instead (this overrides the automatic 1..35 above).
const POSTERS = [
  // { src: 'posters/flyer1.jpg', caption: 'compositions / flyers / flyer1.jpg' },
];
const PLACEHOLDER_COUNT = 45;   // only used if POSTER_COUNT is 0 and POSTERS is empty

// Layout: a messy cluster arching over the model, kept even left-to-right
const SPREAD_WIDTH = 9;    // total width of the cluster, left edge to right edge
const BASE_HEIGHT = 0.8;   // how high the two ends sit above the model's center
const ARCH_HEIGHT = 1.8;   // extra height in the middle of the arch
const MESSINESS_Y = 1.6;   // vertical scatter
const MESSINESS_Z = 3;     // depth scatter (who overlaps whom)
const SIZE_MIN = 0.6;      // smallest poster scale
const SIZE_MAX = 1.05;     // largest poster scale

// ---- Performance ----
const MAX_TEXTURE_SIZE = 512;   // posters are shrunk to this many pixels (longest side) on the GPU.
                                // Lower = smoother. The full-size image still opens when you click.
const MAX_PIXEL_RATIO = 1.25;   // render resolution cap (2 looks sharper but is much heavier)
const MIN_PIXEL_RATIO = 0.75;   // the lowest the page will drop to if it still can't keep up
const ADAPTIVE_RESOLUTION = true;  // automatically lowers resolution if the frame rate dips
const VIDEO_TEXTURE_SIZE = 320; // video posters are drawn this small (longest side)
const VIDEO_FPS = 15;           // video posters refresh this many times a second
const LOAD_CONCURRENCY = 3;     // how many poster files load/decode at once

const SPROUT_TIME = 1.0;        // seconds each poster takes to travel out from the model
const FOLLOW_STRENGTH = 0.9;    // how far everything turns with the mouse
const EASING = 0.06;            // lower = floatier

/* ======================================================== */

const mount = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, MAX_PIXEL_RATIO);
renderer.setPixelRatio(pixelRatio);
let forceRender = true;   // set to true whenever something changes that the loop can't detect on its own
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
mount.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0e);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(4, 8, 6);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.4, 12);
camera.lookAt(0, 1.4, 0);   // frames the model and the arcs above it

// Everything in this group follows the mouse: the model AND the posters
const group = new THREE.Group();
scene.add(group);

/* ---------------- Reveal state ---------------- */
let postersRevealing = false;   // true once the reveal has started
let revealStartTime = 0;
let fallbackTimer = null;

function resetPosters() {
  forceRender = true;
  postersRevealing = false;
  clearTimeout(fallbackTimer);
  posterMeshes.forEach(m => {
    m.visible = false;
    m.userData.reveal = 0;
  });
}

function startReveal() {
  if (postersRevealing) return;
  forceRender = true;
  postersRevealing = true;
  revealStartTime = performance.now() / 1000;
  // Videos stay paused (and cost nothing) until the posters appear
  posterMeshes.forEach(m => { if (m.userData.video) m.userData.video.play().catch(() => {}); });
}

function scheduleReveal(seconds) {
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(startReveal, (seconds + EXTRA_DELAY) * 1000);
}

/* ---------------- Model ---------------- */
let modelHolder = null;
let mixer = null;
let actions = [];
let revealTriggered = false;
const clock = new THREE.Clock();

function fitModel(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  obj.position.sub(center);
  const holder = new THREE.Group();
  holder.add(obj);
  holder.scale.setScalar(3.5 / size);
  return holder;
}

function showModel(gltf) {
  if (modelHolder) group.remove(modelHolder);
  resetPosters();

  modelHolder = fitModel(gltf.scene);
  group.add(modelHolder);

  mixer = null;
  actions = [];
  revealTriggered = false;

  if (gltf.animations.length) {
    mixer = new THREE.AnimationMixer(gltf.scene);
    let remaining = gltf.animations.length;
    let longest = 0;

    gltf.animations.forEach(clip => {
      longest = Math.max(longest, clip.duration);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);   // play once
      action.clampWhenFinished = true;     // hold the last frame
      action.play();
      actions.push(action);
    });

    // Backup: if the reveal point was never hit, reveal when everything has finished
    mixer.addEventListener('finished', () => {
      remaining--;
      if (remaining <= 0) triggerReveal();
    });

    console.log('Animation length:', longest.toFixed(2), 's (~' + Math.round(longest * FPS) + ' frames at ' + FPS + ' fps)');
    console.log('Posters appear at', (longest * REVEAL_AT).toFixed(2), 's (~' + Math.round(longest * REVEAL_AT * FPS) + ' frames)');
  } else {
    // No animation in the file: wait the equivalent of ANIMATION_FRAMES
    revealTriggered = true;
    scheduleReveal((ANIMATION_FRAMES / FPS) * REVEAL_AT);
  }
}

// Called once, when the animation reaches the reveal point
function triggerReveal() {
  if (revealTriggered) return;
  revealTriggered = true;
  if (STOP_AT_REVEAL && mixer) {
    // Snap each clip to exactly the reveal point and hold it there
    actions.forEach(a => {
      a.time = a.getClip().duration * REVEAL_AT;
      a.paused = true;
    });
    mixer.update(0);   // apply that frame to the model right now
  }
  scheduleReveal(0);
}

const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

loader.load(MODEL_URL, showModel, undefined, () => {
  console.warn('Could not load ' + MODEL_URL + ' - showing a placeholder.');
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1, 0.32, 160, 24),
    new THREE.MeshStandardMaterial({ color: 0x2f6fed, metalness: 0.3, roughness: 0.3 })
  );
  modelHolder = fitModel(mesh);
  group.add(modelHolder);
  revealTriggered = true;
  forceRender = true;
  scheduleReveal((ANIMATION_FRAMES / FPS) * REVEAL_AT);
});

/* ---------------- Posters ---------------- */
const palette = ['#c2a300', '#1b2a8a', '#e23b57', '#3a3a46', '#f2f2f2', '#2e7d4f', '#ff8fd0', '#7ab8e8', '#b03030'];
const words = ['pluie', 'donna', 'prune', 'space', 'night', 'flyer', 'live', 'open', 'club', 'show'];

function makePlaceholder(i) {
  const c = document.createElement('canvas');
  c.width = 300; c.height = 400;
  const g = c.getContext('2d');
  const bg = palette[i % palette.length];
  g.fillStyle = bg; g.fillRect(0, 0, 300, 400);
  const light = ['#f2f2f2', '#c2a300', '#ff8fd0', '#7ab8e8'].includes(bg);
  g.fillStyle = light ? '#111' : '#fff';
  g.font = 'bold 74px sans-serif';
  g.fillText(words[i % words.length], 18, 130);
  g.font = '22px sans-serif';
  g.fillText('No. ' + String(i + 1).padStart(2, '0'), 20, 372);
  return c;
}

const isVideoUrl = url => /\.(mp4|webm|mov)$/i.test(url);

// Tries to load one URL as an image or a video.
// Images are shrunk to MAX_TEXTURE_SIZE so the GPU has far less to upload and draw.
function loadMedia(url) {
  return new Promise((resolve, reject) => {
    if (isVideoUrl(url)) {
      const v = document.createElement('video');
      v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = false;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';
      v.onloadeddata = () => resolve({ type: 'video', el: v, w: v.videoWidth, h: v.videoHeight, url });
      v.onerror = () => reject(new Error('video failed: ' + url));
      v.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const r = Math.min(1, MAX_TEXTURE_SIZE / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * r));
        c.height = Math.max(1, Math.round(h * r));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        img.src = '';   // let the full-size decode be garbage collected
        resolve({ type: 'image', el: c, w, h, url });
      };
      img.onerror = () => reject(new Error('image failed: ' + url));
      img.src = url;
    }
  });
}

// Only a few files load at a time, so the page never stalls decoding 35 images at once
let activeLoads = 0;
const waitingLoads = [];
const acquireSlot = () => new Promise(res => {
  if (activeLoads < LOAD_CONCURRENCY) { activeLoads++; res(); } else waitingLoads.push(res);
});
const releaseSlot = () => {
  const next = waitingLoads.shift();
  if (next) next(); else activeLoads--;
};

// Remember which extension worked, so later posters try it first
let goodExt = null;

// Tries each candidate URL in order and returns the first one that loads
async function loadFirst(urls) {
  await acquireSlot();
  try {
    const ordered = goodExt
      ? [...urls].sort((a, b) => (b.endsWith('.' + goodExt) ? 1 : 0) - (a.endsWith('.' + goodExt) ? 1 : 0))
      : urls;
    for (const url of ordered) {
      try {
        const media = await loadMedia(url);
        const m = url.match(/\.([^./]+)$/);
        if (m && !isVideoUrl(url)) goodExt = m[1];   // only remember image extensions
        return media;
      } catch (e) { /* try the next one */ }
    }
    return null;
  } finally {
    releaseSlot();
  }
}

function candidatesFor(entry) {
  if (entry.src) return [entry.src];
  const n = entry.auto;
  if (POSTER_OVERRIDES[n]) return [POSTER_FOLDER + POSTER_OVERRIDES[n]];
  return [...POSTER_EXTENSIONS.map(ext => POSTER_FOLDER + n + '.' + ext), POSTER_FOLDER + n];
}

const posterMeshes = [];
const missingPosters = [];
let postersPending = 0;

function addPoster(index, total, entry) {
  // Spread the posters evenly from the left edge to the right edge, then
  // scatter them so it still looks messy. The two end posters are pinned to
  // exactly the same distance from the center, so the margins match.
  const t = total > 1 ? index / (total - 1) : 0.5;
  const u = (t - 0.5) * 2;                          // -1 (left end) ... 1 (right end)
  const isEnd = index === 0 || index === total - 1;
  const step = total > 1 ? SPREAD_WIDTH / (total - 1) : 0;
  const x = u * (SPREAD_WIDTH / 2) + (isEnd ? 0 : (Math.random() - 0.5) * step * 2.2);
  const y = BASE_HEIGHT + (1 - u * u) * ARCH_HEIGHT + (Math.random() - 0.5) * (isEnd ? MESSINESS_Y * 0.4 : MESSINESS_Y);
  const z = (Math.random() - 0.5) * MESSINESS_Z;

  // Start with a placeholder so the layout works instantly; the real file swaps in when it loads
  const canvas = makePlaceholder(index);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  // End posters use the middle size so both sides reach the same width
  const s = isEnd ? (SIZE_MIN + SIZE_MAX) / 2 : SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75 * s, 1.0 * s),
    new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide })
  );
  mesh.position.set(x, y, z);
  mesh.visible = false;   // hidden until the animation is done
  mesh.userData = {
    full: canvas.toDataURL('image/png'),
    type: 'image',
    caption: entry.caption || ('posters / ' + (entry.auto || index + 1)),
    hover: 1,                       // hover scale, eased
    reveal: 0,                      // 0 -> 1 sprout progress
    home: new THREE.Vector3(x, y, z),   // final resting position
    // Posters nearest the model sprout first, farthest last (an outward wave)
    delay: Math.hypot(x, y, z) * 0.09 + Math.random() * 0.25
  };
  group.add(mesh);
  posterMeshes.push(mesh);

  // Load the real file (if this entry points at one)
  if (entry.auto || entry.src) {
    postersPending++;
    loadFirst(candidatesFor(entry)).then(media => {
      if (!media) {
        missingPosters.push(entry.auto || entry.src);
      } else {
        applyMedia(mesh, media, s, isEnd, entry);
      }
    }).finally(() => {
      if (--postersPending === 0) {
        const ok = posterMeshes.length - missingPosters.length;
        console.log('Posters loaded: ' + ok + '/' + posterMeshes.length);
        if (missingPosters.length) {
          console.warn('Could not load these posters (check the file names in "' + POSTER_FOLDER + '"):', missingPosters.join(', '));
        }
      }
    });
  }
}

// Swap the placeholder for the real image/video and size the plane to its shape
function applyMedia(mesh, media, s, isEnd, entry) {
  const aspect = (media.w && media.h) ? media.w / media.h : 0.75;

  let w, h;
  if (isEnd) {            // ends keep a fixed width so left/right margins stay equal
    w = 0.75 * s;
    h = w / aspect;
  } else {                // everyone else keeps roughly the same visual area
    h = s * Math.sqrt(0.75 / aspect);
    w = h * aspect;
  }
  mesh.geometry.dispose();
  mesh.geometry = new THREE.PlaneGeometry(w, h);

  let tex;
  if (media.type === 'video') {
    const r = Math.min(1, VIDEO_TEXTURE_SIZE / Math.max(media.w, media.h));
    const vc = document.createElement('canvas');
    vc.width = Math.max(1, Math.round(media.w * r));
    vc.height = Math.max(1, Math.round(media.h * r));
    const ctx = vc.getContext('2d');
    ctx.drawImage(media.el, 0, 0, vc.width, vc.height);
    tex = new THREE.CanvasTexture(vc);
    mesh.userData.vc = { canvas: vc, ctx, tex, video: media.el, last: 0 };
  } else {
    tex = new THREE.CanvasTexture(media.el);
  }
  tex.colorSpace = THREE.SRGBColorSpace;
  renderer.initTexture(tex);   // upload to the GPU now (while loading), not at the moment the poster pops in
  mesh.material.map.dispose();
  mesh.material.map = tex;
  // PNG / WebP / GIF can have transparent areas: honor them instead of drawing a solid background.
  // (JPGs and videos stay opaque, which is cheaper to draw.)
  const hasAlpha = /\.(png|webp|gif)$/i.test(media.url);
  mesh.material.transparent = hasAlpha;
  mesh.material.alphaTest = hasAlpha ? 0.02 : 0;   // drop fully transparent pixels so overlaps look clean
  mesh.material.needsUpdate = true;
  forceRender = true;

  mesh.userData.full = media.url;
  mesh.userData.type = media.type;
  if (media.type === 'video') {
    mesh.userData.video = media.el;
    if (postersRevealing) media.el.play().catch(() => {});
  }
  if (!entry.caption) mesh.userData.caption = 'posters / ' + media.url.split('/').pop();
}

const list = POSTERS.length
  ? POSTERS
  : POSTER_COUNT > 0
    ? Array.from({ length: POSTER_COUNT }, (_, i) => ({ auto: i + 1 }))
    : Array.from({ length: PLACEHOLDER_COUNT }, () => ({}));
list.forEach((entry, i) => addPoster(i, list.length, entry));

/* ---------------- Custom cursor ---------------- */
const cursorEl = document.getElementById('cursor');
addEventListener('pointermove', e => {
  cursorEl.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
  cursorEl.style.opacity = 1;
});
document.documentElement.addEventListener('mouseleave', () => { cursorEl.style.opacity = 0; });

/* ---------------- Mouse follow + drag ---------------- */
// Final rotation = (where the mouse is) + (how far you have dragged)
const follow = { x: 0, y: 0 };       // from the mouse position
const drag = { x: 0, y: 0 };         // from click-and-drag
const target = { x: 0, y: 0 };       // follow + drag, what the group eases toward
const mouse = new THREE.Vector2(10, 10);

const DRAG_SPEED = 0.006;            // radians per pixel dragged
const MAX_TILT = 1.3;                // limit on up/down tilt, so it can't flip over

let dragging = false;
let dragMoved = 0;                   // total pixels moved, used to tell a drag from a click
let lastX = 0, lastY = 0;
let frozenFollow = { x: 0, y: 0 };
let lastNx = 0, lastNy = 0;

renderer.domElement.style.touchAction = 'none';   // lets touch screens drag too

const followFrom = (nx, ny) => ({
  y: nx * FOLLOW_STRENGTH,
  x: ny * FOLLOW_STRENGTH * 0.5
});

renderer.domElement.addEventListener('pointerdown', e => {
  dragging = true;
  dragMoved = 0;
  lastX = e.clientX;
  lastY = e.clientY;
  frozenFollow = { x: follow.x, y: follow.y };   // mouse-follow pauses while dragging
});

addEventListener('pointermove', e => {
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = (e.clientY / innerHeight) * 2 - 1;
  lastNx = nx;
  lastNy = ny;
  mouse.set(nx, -ny);

  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    dragMoved += Math.abs(dx) + Math.abs(dy);
    drag.y += dx * DRAG_SPEED;
    drag.x += dy * DRAG_SPEED;
  } else {
    const f = followFrom(nx, ny);
    follow.x = f.x;
    follow.y = f.y;
  }
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  // Mouse-follow resumes from where the cursor is now. Shift the drag offset
  // by the difference so the scene doesn't jump when you let go.
  const f = followFrom(lastNx, lastNy);
  drag.x += frozenFollow.x - f.x;
  drag.y += frozenFollow.y - f.y;
  follow.x = f.x;
  follow.y = f.y;
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

// Double-click empty space to reset the drag
renderer.domElement.addEventListener('dblclick', () => {
  if (!pickPoster()) { drag.x = 0; drag.y = 0; }
});

addEventListener('wheel', e => {
  forceRender = true;
  camera.position.z = THREE.MathUtils.clamp(camera.position.z + e.deltaY * 0.01, 7, 22);
}, { passive: true });

/* ---------------- Hover + click ---------------- */
const raycaster = new THREE.Raycaster();
const viewer = document.getElementById('viewer');
const big = document.getElementById('big');
const bigVideo = document.getElementById('bigvideo');
const caption = document.getElementById('caption');

function pickPoster() {
  if (!postersRevealing) return null;
  raycaster.setFromCamera(mouse, camera);
  const candidates = posterMeshes.filter(m => m.visible && m.userData.reveal > 0.8);
  const hit = raycaster.intersectObjects(candidates, false)[0];
  return hit ? hit.object : null;
}

renderer.domElement.addEventListener('click', () => {
  if (dragMoved > 5) return;   // that was a drag, not a click
  const p = pickPoster();
  if (!p) return;
  if (p.userData.type === 'video') {
    big.style.display = 'none';
    bigVideo.style.display = 'block';
    bigVideo.src = p.userData.full;
    bigVideo.play().catch(() => {});
  } else {
    bigVideo.pause();
    bigVideo.style.display = 'none';
    big.style.display = 'block';
    big.src = p.userData.full;
  }
  caption.textContent = p.userData.caption;
  setVideosPlaying(false);
  viewer.classList.add('open');
});

const closeViewer = () => {
  viewer.classList.remove('open');
  bigVideo.pause();
  setVideosPlaying(true);
  forceRender = true;
};

function setVideosPlaying(on) {
  posterMeshes.forEach(m => {
    const v = m.userData.video;
    if (!v) return;
    if (on) { if (postersRevealing) v.play().catch(() => {}); } else v.pause();
  });
}
document.getElementById('close').addEventListener('click', closeViewer);
addEventListener('keydown', e => { if (e.key === 'Escape') closeViewer(); });

/* ---------------- Render loop ---------------- */
const inv = new THREE.Quaternion();
let frameCount = 0;
let hoveredCache = null;
const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
const easeOutBack = x => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);

let lastTime = performance.now();
let avgDt = 0.016;
let cooldown = 120;   // frames to wait before the first resolution check

renderer.setAnimationLoop(() => {
  const nowMs = performance.now();
  const dt = (nowMs - lastTime) / 1000;
  lastTime = nowMs;
  const now = nowMs / 1000;

  // Only redraw when something actually changed (saves a lot of work when the scene is at rest)
  let needsRender = forceRender;
  forceRender = false;

  if (mixer) {
    mixer.update(clock.getDelta());
    // Reveal the posters once any clip passes the reveal point
    if (!revealTriggered && actions.some(a => a.time >= a.getClip().duration * REVEAL_AT)) {
      triggerReveal();
    }
    if (actions.some(a => a.isRunning())) needsRender = true;   // model animation is playing
  }

  // Whole group eases toward mouse position + drag
  target.y = follow.y + drag.y;
  target.x = THREE.MathUtils.clamp(follow.x + drag.x, -MAX_TILT, MAX_TILT);
  if (Math.abs(target.y - group.rotation.y) + Math.abs(target.x - group.rotation.x) > 0.0003) needsRender = true;
  group.rotation.y += (target.y - group.rotation.y) * EASING;
  group.rotation.x += (target.x - group.rotation.x) * EASING;

  // Posters always face the camera
  inv.copy(group.quaternion).invert().multiply(camera.quaternion);

  const open = viewer.classList.contains('open');
  // Hover-checking every frame is wasteful; every 3rd frame feels identical
  frameCount++;
  if (open || dragging) hoveredCache = null;
  else if (frameCount % 3 === 0) hoveredCache = pickPoster();
  const hovered = hoveredCache;
  cursorEl.classList.toggle('drag', dragging);
  cursorEl.classList.toggle('hover', !dragging && !!hovered);

  posterMeshes.forEach(m => {
    m.quaternion.copy(inv);

    // Pop-in after the animation has finished
    if (postersRevealing) {
      const p = THREE.MathUtils.clamp((now - revealStartTime - m.userData.delay) / SPROUT_TIME, 0, 1);
      if (p !== m.userData.reveal) needsRender = true;
      m.userData.reveal = p;
      m.visible = p > 0;
      // Travel from the model's center out to the poster's spot
      m.position.copy(m.userData.home).multiplyScalar(easeOutCubic(p));
    }

    const goal = m === hovered ? 1.25 : 1;
    if (Math.abs(goal - m.userData.hover) > 0.002) needsRender = true;
    m.userData.hover += (goal - m.userData.hover) * 0.15;
    m.scale.setScalar(m.userData.hover * easeOutBack(m.userData.reveal));

    // Video posters: refresh a small canvas a few times a second instead of every frame
    const vc = m.userData.vc;
    if (vc && m.visible && !open && !vc.video.paused && now - vc.last > 1 / VIDEO_FPS) {
      vc.ctx.drawImage(vc.video, 0, 0, vc.canvas.width, vc.canvas.height);
      vc.tex.needsUpdate = true;
      vc.last = now;
      needsRender = true;
    }
  });

  if (open || !needsRender) return;   // nothing to draw
  renderer.render(scene, camera);

  // If frames are taking too long, quietly lower the render resolution a notch
  if (ADAPTIVE_RESOLUTION && dt < 0.2) {
    avgDt += (dt - avgDt) * 0.05;
    if (cooldown > 0) {
      cooldown--;
    } else if (avgDt > 0.03 && pixelRatio > MIN_PIXEL_RATIO) {
      pixelRatio = Math.max(MIN_PIXEL_RATIO, pixelRatio - 0.25);
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(innerWidth, innerHeight);
      avgDt = 0.016;
      cooldown = 90;
      forceRender = true;
      console.log('Frame rate dipped - render resolution lowered to', pixelRatio);
    }
  }
});

addEventListener('resize', () => {
  forceRender = true;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});