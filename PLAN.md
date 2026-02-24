# AirDraw: Multiplayer 3D Finger Painting with Physics

Transform the volumetric chess app into a multiplayer AirDraw experience inspired by Vision Pro's AirDraw app. Two players join a shared 3D space, see each other as volumetric video cutouts, and draw 3D shapes in the air with pinch gestures. Drawn rings have physics — the first floats, subsequent ones can hang from it like a chain.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Player A)                                      │
│                                                          │
│  MediaPipe Hand Tracking ──► Stroke Recorder             │
│       (pinch = draw)         (CatmullRomCurve3)          │
│              │                      │                    │
│              │                      ▼                    │
│              │              TubeGeometry + Physics Body   │
│              │                      │                    │
│              ▼                      ▼                    │
│  Daily.co ◄──── app-message sync ────► Three.js Scene    │
│  (video/audio)  { stroke points,       (HDR env map,     │
│                   physics state }       ACES tonemapping, │
│                                         Rapier physics)   │
│              │                                            │
│              ▼                                            │
│  Volumetric Video Cutout (existing RGBD splats)          │
└─────────────────────────────────────────────────────────┘
```

**Keep from chess project:**
- Daily.co video/audio + app-message protocol (video.js)
- MediaPipe hand tracking with pinch detection (vision.js)
- Depth processor for volumetric video (depth.js)
- Volumetric splat rendering (scene.js createCutout)
- UI framework (ui.js)
- Vite build system + HTTPS dev server
- Three.js polyfill + import maps

**Remove:**
- Chess logic (game.js, chess.js dependency)
- Chess board, pieces, piece loading
- Chess interaction (click-to-move, voice commands)
- Gaussian splat environment loading (white_view/black_view.splat)
- Lichess integration
- equine dependency

**Add:**
- `src/drawing.js` — Stroke recording, curve building, TubeGeometry rendering
- `src/physics.js` — Rapier WASM physics world, ring body creation, constraints
- `src/sync.js` — Drawing state serialization over Daily.co app-messages
- `src/hdr.js` — HDR environment loading, tone mapping, Display P3
- HDR environment map from Polyhaven (downloaded as static asset)
- @dimforge/rapier3d-compat dependency (WASM physics)

---

## Implementation Steps

### Step 1: Clean Foundation — Strip Chess, Update Config

**Files:** `package.json`, `vite.config.js`, `index.html`, `src/main.js`

- Rename project from "chess" to "airdraw"
- Change vite base from `/chess/` to `/`
- Remove chess.js, equine, @sparkjsdev/spark dependencies
- Add `@dimforge/rapier3d-compat` (Rapier physics, ~800KB WASM)
- Update import map in index.html (remove spark, update three polyfill path)
- Remove chess-specific HTML (depth controls can stay for debug)
- Update main.js to remove game.js, interaction.js chess imports
- Keep: Daily.co, MediaPipe, Three.js, depth processor, UI

### Step 2: Scene Overhaul — HDR Environment + Wide Color Gamut

**Files:** `src/scene.js`, new `src/hdr.js`

- Remove: board, pieces, pieceMap, loadPieces, updateBoard, highlight system
- Keep: camera, renderer, lights, volumetric cutout system, controls
- Add HDR environment setup:
  ```js
  import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

  // Load HDR environment map
  const hdrLoader = new RGBELoader();
  const hdrTexture = await hdrLoader.loadAsync('/assets/environment.hdr');
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;

  scene.environment = envMap;      // All PBR materials reflect this
  scene.background = envMap;       // Visible background
  ```
- Renderer upgrades:
  ```js
  renderer.outputColorSpace = THREE.SRGBColorSpace; // safe default
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  // Wide color gamut (Display P3) — opt-in for capable displays
  // Three.js r152+ supports this via WebGLRenderer options
  // We'll detect support and enable if available
  ```
- Widen camera FOV from 19 (chess zoom) to ~50 (drawing space)
- Move camera to a more open position for drawing: (0, 1.5, 2.5)
- Add a subtle ground plane with reflections (MeshPhysicalMaterial, metalness: 0, roughness: 0.1)

### Step 3: 3D Drawing System — Pinch-to-Draw Strokes

**New file:** `src/drawing.js`

Core drawing pipeline:
1. **Pinch Detection** → Start/continue/end stroke
2. **Screen-to-World** → Unproject finger position to 3D ray, place point at fixed depth
3. **Curve Building** → CatmullRomCurve3 from accumulated points
4. **Geometry** → TubeGeometry with configurable radius
5. **Material** → MeshPhysicalMaterial with metalness for env reflections

```js
// Stroke state machine
const DRAW_STATES = { IDLE: 0, DRAWING: 1 };

class StrokeRecorder {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.state = DRAW_STATES.IDLE;
    this.activePoints = [];      // Vector3[]
    this.activeMesh = null;
    this.completedStrokes = [];  // { mesh, curve, points }[]
    this.drawDepth = 1.5;        // Distance from camera to draw at
    this.tubeRadius = 0.008;
    this.tubeSegments = 8;       // Radial segments (performance)
    this.minPointDistance = 0.005; // Min distance between points
    this.color = new THREE.Color().setHSL(Math.random(), 0.8, 0.5);
  }

  // Called each frame with hand tracking data
  update(handInteraction) {
    if (!handInteraction) {
      if (this.state === DRAW_STATES.DRAWING) this.endStroke();
      return;
    }

    if (handInteraction.isPinched) {
      const worldPos = this.screenToWorld(handInteraction.x, handInteraction.y);

      if (this.state === DRAW_STATES.IDLE) {
        this.startStroke(worldPos);
      } else {
        this.continueStroke(worldPos);
      }
    } else {
      if (this.state === DRAW_STATES.DRAWING) this.endStroke();
    }
  }

  screenToWorld(nx, ny) {
    // nx, ny are 0-1 normalized from MediaPipe (top-left origin)
    // Convert to NDC (-1 to 1, bottom-left origin)
    const ndc = new THREE.Vector3(
      (1 - nx) * 2 - 1,  // mirror X (webcam is mirrored)
      -(ny * 2 - 1),      // flip Y
      0.5                  // mid-frustum
    );
    ndc.unproject(this.camera);

    // Ray from camera through ndc point
    const dir = ndc.sub(this.camera.position).normalize();
    return this.camera.position.clone().add(dir.multiplyScalar(this.drawDepth));
  }

  startStroke(point) {
    this.state = DRAW_STATES.DRAWING;
    this.activePoints = [point.clone()];
    this.color = new THREE.Color().setHSL(Math.random(), 0.8, 0.5);
  }

  continueStroke(point) {
    const last = this.activePoints[this.activePoints.length - 1];
    if (point.distanceTo(last) < this.minPointDistance) return;

    this.activePoints.push(point.clone());
    this.rebuildActiveMesh();
  }

  endStroke() {
    this.state = DRAW_STATES.IDLE;
    if (this.activePoints.length < 3) {
      // Too short, discard
      if (this.activeMesh) this.scene.remove(this.activeMesh);
      this.activeMesh = null;
      this.activePoints = [];
      return;
    }

    // Finalize: convert to static geometry
    const stroke = {
      mesh: this.activeMesh,
      points: [...this.activePoints],
      color: this.color.clone(),
      id: crypto.randomUUID()
    };
    this.completedStrokes.push(stroke);
    this.activeMesh = null;
    this.activePoints = [];

    return stroke; // For sync
  }

  rebuildActiveMesh() {
    if (this.activePoints.length < 2) return;

    if (this.activeMesh) this.scene.remove(this.activeMesh);

    const curve = new THREE.CatmullRomCurve3(this.activePoints);
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.max(this.activePoints.length * 2, 8), // tubular segments
      this.tubeRadius,
      this.tubeSegments,
      false // not closed
    );

    const material = new THREE.MeshPhysicalMaterial({
      color: this.color,
      metalness: 0.3,
      roughness: 0.2,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.5
    });

    this.activeMesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.activeMesh);
  }
}
```

**Ring detection:** After stroke ends, check if start and end points are close (< threshold). If so, close the curve and mark it as a "ring" for physics.

### Step 4: Physics — Rapier WASM for Ring Chains

**New file:** `src/physics.js`

```js
import RAPIER from '@dimforge/rapier3d-compat';

class PhysicsWorld {
  constructor() {
    this.world = null;
    this.bodies = new Map();  // strokeId -> { rigidBody, collider }
    this.joints = [];
  }

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  }

  // Add a ring as a physics body
  addRing(strokeId, center, radius, isFirstRing) {
    const bodyDesc = isFirstRing
      ? RAPIER.RigidBodyDesc.kinematicPositionBased()  // First ring: fixed in air
        .setTranslation(center.x, center.y, center.z)
      : RAPIER.RigidBodyDesc.dynamic()                  // Subsequent: affected by gravity
        .setTranslation(center.x, center.y, center.z);

    const body = this.world.createRigidBody(bodyDesc);

    // Torus collider approximated as ball (Rapier doesn't have native torus)
    // Use multiple small ball colliders arranged in a circle for better approximation
    const segments = 8;
    const tubeRadius = 0.01;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const colliderDesc = RAPIER.ColliderDesc.ball(tubeRadius)
        .setTranslation(x, 0, z);
      this.world.createCollider(colliderDesc, body);
    }

    this.bodies.set(strokeId, { body, center, radius });
    return body;
  }

  // Create a ball-socket joint between two rings (chain link)
  linkRings(parentId, childId) {
    const parent = this.bodies.get(parentId);
    const child = this.bodies.get(childId);
    if (!parent || !child) return;

    // Anchor at bottom of parent ring
    const jointData = RAPIER.JointData.spherical(
      { x: 0, y: -parent.radius, z: 0 },  // anchor on parent
      { x: 0, y: child.radius, z: 0 }       // anchor on child
    );

    const joint = this.world.createImpulseJoint(
      jointData, parent.body, child.body, true
    );
    this.joints.push(joint);
  }

  step(dt) {
    if (!this.world) return;
    this.world.timestep = Math.min(dt, 1/30);
    this.world.step();
  }

  // Sync physics transforms back to Three.js meshes
  syncToMeshes(strokes) {
    for (const stroke of strokes) {
      const phys = this.bodies.get(stroke.id);
      if (!phys) continue;

      const pos = phys.body.translation();
      const rot = phys.body.rotation();

      stroke.mesh.position.set(pos.x, pos.y, pos.z);
      stroke.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }
}
```

**Ring chain logic:**
1. When a stroke is completed, check if it's a ring (start ≈ end)
2. First ring in scene → kinematic (floats in space)
3. Subsequent rings → check proximity to existing rings
4. If new ring overlaps/intersects existing → create joint constraint
5. New ring becomes dynamic → gravity pulls it, joint holds it → chain!

### Step 5: Multiplayer Sync over Daily.co App Messages

**New file:** `src/sync.js`

Reuse the existing Daily.co `sendAppMessage` / `onAppMessage` infrastructure. No new server needed for 2 players.

**Message protocol:**
```js
// During drawing (throttled to ~15fps)
{
  type: 'stroke:progress',
  strokeId: 'uuid',
  points: [[x,y,z], ...],  // Accumulated points
  color: '#ff3366'
}

// On stroke complete
{
  type: 'stroke:complete',
  strokeId: 'uuid',
  points: [[x,y,z], ...],
  color: '#ff3366',
  isRing: true,
  center: [x, y, z],
  radius: 0.05
}

// Physics state (from "host" player, ~10fps)
{
  type: 'physics:sync',
  bodies: [
    { id: 'uuid', pos: [x,y,z], rot: [x,y,z,w] },
    ...
  ]
}

// Undo last stroke
{ type: 'stroke:undo', strokeId: 'uuid' }
```

**Sync strategy:**
- Drawing state: broadcast stroke points as they're drawn (live preview for remote)
- Physics authority: first player to join is "host", runs physics simulation
- Host broadcasts physics transforms at 10fps
- Remote player receives and applies transforms (no local physics sim)
- When host draws a ring, they also create the physics body and broadcast

### Step 6: HDR Environment Map

**File:** `src/hdr.js` + static asset

- Download a high-quality HDR from Polyhaven (e.g., "studio_small_09" or "autumn_field_puresky")
- Store in `public/assets/environment.hdr` (1k resolution, ~2MB)
- Load with RGBELoader, process with PMREMGenerator
- Set as both `scene.environment` (reflections) and `scene.background`
- All MeshPhysicalMaterial strokes will automatically reflect the environment

**Display P3 / Wide Gamut:**
```js
// Check browser support
const supportsP3 = window.matchMedia('(color-gamut: p3)').matches;

// Three.js r160+ supports Display P3
if (supportsP3) {
  renderer.outputColorSpace = THREE.DisplayP3ColorSpace;
  // Materials created with Display P3 colors
}

// ACES filmic tone mapping for HDR-like dynamic range
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
```

### Step 7: Updated UI + Controls

**Files:** `src/ui.js`, `index.html`

New toolbar buttons:
- Color picker (HSL wheel or preset palette)
- Brush size slider
- Undo last stroke
- Clear all strokes
- Physics toggle (pause/resume gravity)

Keep existing:
- Mic/cam/head-tracking/settings toggles

### Step 8: Updated Main Loop

**File:** `src/main.js`

```js
import { initScene, animateScene } from './scene.js';
import { initVision, updateVision } from './vision.js';
import { initVideo } from './video.js';
import { initDepthProcessor } from './depth.js';
import { initUI } from './ui.js';
import { StrokeRecorder } from './drawing.js';
import { PhysicsWorld } from './physics.js';
import { DrawingSync } from './sync.js';
import { loadEnvironment } from './hdr.js';
import { trackingState } from './vision.js';

async function main() {
  const sceneCtx = await initScene();
  await loadEnvironment(sceneCtx);

  const physics = new PhysicsWorld();
  await physics.init();

  const drawer = new StrokeRecorder(sceneCtx.scene, sceneCtx.camera);

  // Depth + Vision + Video (same as before)
  const compositeStream = await initDepthProcessor();
  await initVision(sceneCtx);

  const sync = new DrawingSync();

  await initVideo({
    videoSource: compositeStream.getVideoTracks()[0],
    onRemoteVideo: (el) => sceneCtx.createCutout(el),
    onAppMessage: (data) => sync.handleMessage(data, drawer, physics)
  });

  initUI(drawer, physics);

  // Main loop
  let lastTime = 0;
  function loop(time) {
    const dt = (time - lastTime) / 1000;
    lastTime = time;

    updateVision();

    // Drawing from hand tracking
    const completed = drawer.update(trackingState.handInteraction);
    if (completed) {
      sync.broadcastStroke(completed);
      if (completed.isRing) {
        physics.addRing(completed.id, completed.center, completed.radius);
      }
    }

    // Physics step
    physics.step(dt);
    physics.syncToMeshes(drawer.completedStrokes);

    animateScene(time);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main();
```

---

## File Structure (Final)

```
src/
├── main.js        — App entry, init sequence, main loop
├── scene.js       — Three.js scene, camera, renderer, HDR, volumetric cutout
├── drawing.js     — NEW: Stroke recording, TubeGeometry, ring detection
├── physics.js     — NEW: Rapier world, ring bodies, chain joints
├── sync.js        — NEW: Drawing state sync over Daily.co app-messages
├── hdr.js         — NEW: HDR environment loading, tone mapping config
├── vision.js      — MediaPipe hand/face tracking (mostly unchanged)
├── video.js       — Daily.co WebRTC (unchanged, reuse app-message)
├── depth.js       — Depth processor for volumetric video (unchanged)
└── ui.js          — Controls (updated: add color/brush/undo/clear)

public/
└── assets/
    └── environment.hdr   — Polyhaven HDR map
```

---

## Dependencies (Final)

```json
{
  "dependencies": {
    "@daily-co/daily-js": "^0.86.0",
    "@dimforge/rapier3d-compat": "^0.14.0",
    "@mediapipe/tasks-vision": "^0.10.32",
    "three": "^0.182.0",
    "vite": "^5.4.21"
  }
}
```

---

## Implementation Order

1. **Step 1** — Clean foundation (strip chess, update config)
2. **Step 2** — Scene overhaul (HDR, tone mapping, ground plane)
3. **Step 3** — Drawing system (pinch-to-draw, TubeGeometry)
4. **Step 4** — Physics (Rapier, ring detection, chain joints)
5. **Step 5** — Multiplayer sync (broadcast strokes + physics over Daily.co)
6. **Step 6** — HDR environment asset + wide color gamut
7. **Step 7** — Updated UI (color picker, brush size, undo)
8. **Step 8** — Wire up main loop, test end-to-end
