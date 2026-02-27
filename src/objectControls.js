// objectControls.js — Mouse-based selection + keyboard manipulation + hand-based scale hotspots
import * as THREE from 'three';
import { keys, setObjectSelected, camera, scene } from './scene.js';

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// State
let hoveredMesh = null;
let selectedMesh = null;
let selectedStroke = null;  // reference to the stroke/primitive in completedStrokes
let _savedEmissives = new Map(); // mesh -> original emissive color

// Speeds
const ROT_SPEED = 1.5;   // radians/sec
const POS_SPEED = 1.0;   // metres/sec
const SCALE_SPEED = 0.8; // multiplier/sec

// Visible highlight colors for shiny metal
const HOVER_EMISSIVE = new THREE.Color(0x665500);    // warm gold hover
const SELECT_EMISSIVE = new THREE.Color(0xcc6600);   // bright orange selected

// Shared hotspot geometry (created once)
let _hotspotGeo = null;
function getHotspotGeo() {
  if (!_hotspotGeo) _hotspotGeo = new THREE.SphereGeometry(0.04, 12, 12);
  return _hotspotGeo;
}

export class ObjectControls {
  constructor(rendererDom, cameraRef, sceneRef, drawer, physics, sync) {
    this.dom = rendererDom;
    this.camera = cameraRef;
    this.scene = sceneRef;
    this.drawer = drawer;
    this.physics = physics;
    this.sync = sync;

    // Scale hotspot state
    this._hotspots = [];       // [meshMin, meshMax] or empty
    this._grabState = null;    // { hotspotIdx, initialDist, initialScale }
    this._grabRange = 0.12;    // how close pinch must be to grab (world units)

    // Throttle transform broadcasts (~30fps instead of every frame)
    this._lastBroadcastTime = 0;
    this._broadcastInterval = 33; // ms

    this.dom.addEventListener('mousemove', (e) => this._onMouseMove(e));
    this.dom.addEventListener('click', (e) => this._onClick(e));
  }

  // Collect all selectable meshes (strokes + primitives)
  _getSelectableMeshes() {
    const meshes = [];
    for (const s of this.drawer.completedStrokes) {
      if (s.mesh) meshes.push(s.mesh);
    }
    return meshes;
  }

  _setEmissive(mesh, color) {
    if (!mesh) return;
    const mat = mesh.material;
    if (!mat || !mat.emissive) return;

    if (!_savedEmissives.has(mesh)) {
      _savedEmissives.set(mesh, mat.emissive.clone());
    }
    mat.emissive.copy(color);
  }

  _restoreEmissive(mesh) {
    if (!mesh) return;
    const saved = _savedEmissives.get(mesh);
    if (saved && mesh.material && mesh.material.emissive) {
      mesh.material.emissive.copy(saved);
    }
    _savedEmissives.delete(mesh);
  }

  _onMouseMove(e) {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, this.camera);
    const meshes = this._getSelectableMeshes();
    if (meshes.length === 0) {
      if (hoveredMesh && hoveredMesh !== selectedMesh) {
        this._restoreEmissive(hoveredMesh);
        hoveredMesh = null;
        this.dom.style.cursor = '';
      }
      return;
    }

    const intersects = raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      const hitMesh = intersects[0].object;

      if (hitMesh !== hoveredMesh) {
        // Un-hover previous
        if (hoveredMesh && hoveredMesh !== selectedMesh) {
          this._restoreEmissive(hoveredMesh);
        }
        hoveredMesh = hitMesh;
        if (hoveredMesh !== selectedMesh) {
          this._setEmissive(hoveredMesh, HOVER_EMISSIVE);
        }
        this.dom.style.cursor = 'pointer';
      }
    } else {
      if (hoveredMesh && hoveredMesh !== selectedMesh) {
        this._restoreEmissive(hoveredMesh);
      }
      hoveredMesh = null;
      this.dom.style.cursor = '';
    }
  }

  _onClick(e) {
    // If clicking on hovered mesh, select it
    if (hoveredMesh) {
      this.select(hoveredMesh);
    }
  }

  select(mesh) {
    // Deselect previous
    if (selectedMesh && selectedMesh !== mesh) {
      this._restoreEmissive(selectedMesh);
      this._removeHotspots();
    }

    selectedMesh = mesh;
    selectedStroke = this.drawer.completedStrokes.find(s => s.mesh === mesh) || null;
    this._setEmissive(selectedMesh, SELECT_EMISSIVE);
    setObjectSelected(true);
    this._createHotspots(mesh);
  }

  deselect() {
    if (selectedMesh) {
      this._restoreEmissive(selectedMesh);
    }
    this._removeHotspots();
    selectedMesh = null;
    selectedStroke = null;
    setObjectSelected(false);
  }

  getSelectedMesh() {
    return selectedMesh;
  }

  getSelectedStroke() {
    return selectedStroke;
  }

  // ── Scale Hotspots ──────────────────────────────────────

  _createHotspots(mesh) {
    this._removeHotspots();

    mesh.updateMatrixWorld(true);
    mesh.geometry.computeBoundingBox();
    const bbox = mesh.geometry.boundingBox.clone();
    bbox.applyMatrix4(mesh.matrixWorld);

    const positions = [bbox.min.clone(), bbox.max.clone()];
    const geo = getHotspotGeo();

    for (const pos of positions) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00aaff,
        transparent: true,
        opacity: 0.35,
        depthTest: false
      });
      const sphere = new THREE.Mesh(geo, mat);
      sphere.position.copy(pos);
      sphere.name = '_scaleHotspot';
      sphere.renderOrder = 999;
      this.scene.add(sphere);
      this._hotspots.push(sphere);
    }
  }

  _removeHotspots() {
    for (const hs of this._hotspots) {
      this.scene.remove(hs);
      hs.material.dispose();
    }
    this._hotspots = [];
    this._grabState = null;
  }

  _updateHandScale(handInteractions) {
    if (!selectedMesh || this._hotspots.length !== 2 || !handInteractions || handInteractions.length === 0) {
      if (this._grabState) {
        this._releaseGrab();
      }
      return;
    }

    // Recompute hotspot positions each frame (object may have moved)
    selectedMesh.updateMatrixWorld(true);
    selectedMesh.geometry.computeBoundingBox();
    const bbox = selectedMesh.geometry.boundingBox.clone();
    bbox.applyMatrix4(selectedMesh.matrixWorld);
    this._hotspots[0].position.copy(bbox.min);
    this._hotspots[1].position.copy(bbox.max);

    const center = new THREE.Vector3();
    bbox.getCenter(center);

    // Check if any pinching hand is near a hotspot
    let anyPinchNearHotspot = false;

    for (const interaction of handInteractions) {
      if (!interaction || !interaction.isPinched) continue;

      const handWorld = this.drawer.screenToWorldRaw(interaction.x, interaction.y);

      if (!this._grabState) {
        // Try to grab a hotspot
        for (let i = 0; i < 2; i++) {
          const dist = handWorld.distanceTo(this._hotspots[i].position);
          if (dist < this._grabRange) {
            this._grabState = {
              hotspotIdx: i,
              initialDist: this._hotspots[i].position.distanceTo(center),
              initialScale: selectedMesh.scale.clone()
            };
            // Visual feedback
            this._hotspots[i].material.opacity = 0.7;
            this._hotspots[i].material.color.setHex(0xff8800);
            break;
          }
        }
      }

      if (this._grabState) {
        anyPinchNearHotspot = true;
        // Compute new scale from drag distance
        const currentDist = handWorld.distanceTo(center);
        const ratio = currentDist / Math.max(this._grabState.initialDist, 0.01);
        const clamped = Math.max(0.1, Math.min(10, ratio));
        selectedMesh.scale.copy(this._grabState.initialScale).multiplyScalar(clamped);

        // Stream transform during drag (throttled) so remote peers see scaling in real-time
        const now = performance.now();
        if (this.sync && selectedStroke && now - this._lastBroadcastTime >= this._broadcastInterval) {
          this._lastBroadcastTime = now;
          this.sync.broadcast({
            type: 'object:transform',
            id: selectedStroke.id,
            pos: [selectedMesh.position.x, selectedMesh.position.y, selectedMesh.position.z],
            rot: [selectedMesh.rotation.x, selectedMesh.rotation.y, selectedMesh.rotation.z],
            scale: [selectedMesh.scale.x, selectedMesh.scale.y, selectedMesh.scale.z]
          });
        }
        break; // only one grab at a time
      }
    }

    // If no hand is pinching, release grab
    if (this._grabState && !anyPinchNearHotspot) {
      this._releaseGrab();
    }
  }

  _releaseGrab() {
    if (!this._grabState) return;
    // Reset hotspot appearance
    const idx = this._grabState.hotspotIdx;
    if (this._hotspots[idx]) {
      this._hotspots[idx].material.opacity = 0.35;
      this._hotspots[idx].material.color.setHex(0x00aaff);
    }

    // Broadcast final transform
    if (this.sync && selectedStroke && selectedMesh) {
      this.sync.broadcast({
        type: 'object:transform',
        id: selectedStroke.id,
        pos: [selectedMesh.position.x, selectedMesh.position.y, selectedMesh.position.z],
        rot: [selectedMesh.rotation.x, selectedMesh.rotation.y, selectedMesh.rotation.z],
        scale: [selectedMesh.scale.x, selectedMesh.scale.y, selectedMesh.scale.z]
      });
    }

    this._grabState = null;
  }

  // ── Main update (called each frame) ──────────────────────

  update(dt, handInteractions) {
    // Escape to deselect
    if (keys.escape) {
      this.deselect();
      keys.escape = false; // consume
      return;
    }

    // Hand-based scaling (always runs, even without keyboard)
    this._updateHandScale(handInteractions || []);

    if (!selectedMesh) return;

    // --- Rotation ---
    if (keys.r) selectedMesh.rotation.x += ROT_SPEED * dt;
    if (keys.y) selectedMesh.rotation.x -= ROT_SPEED * dt;
    if (keys.o) selectedMesh.rotation.y += ROT_SPEED * dt;
    if (keys.p) selectedMesh.rotation.y -= ROT_SPEED * dt;

    // --- Position ---
    if (keys.t) selectedMesh.position.y += POS_SPEED * dt;
    if (keys.b) selectedMesh.position.y -= POS_SPEED * dt;
    if (keys.g) selectedMesh.position.x -= POS_SPEED * dt;
    if (keys.h) selectedMesh.position.x += POS_SPEED * dt;
    if (keys.f) selectedMesh.position.z -= POS_SPEED * dt;
    if (keys.v) selectedMesh.position.z += POS_SPEED * dt;

    // --- Scale (keyboard, skip when hand-grabbing) ---
    if (!this._grabState) {
      if (keys[',']) {
        const s = 1 - SCALE_SPEED * dt;
        selectedMesh.scale.multiplyScalar(Math.max(s, 0.1));
      }
      if (keys['.']) {
        const s = 1 + SCALE_SPEED * dt;
        selectedMesh.scale.multiplyScalar(Math.min(s, 10));
      }
    }

    // Broadcast transform if changed (throttled to ~30fps to avoid flooding network)
    const anyKey = keys.r || keys.y || keys.o || keys.p ||
      keys.t || keys.b || keys.g || keys.h || keys.f || keys.v ||
      keys[','] || keys['.'];
    if (this.sync && selectedStroke && anyKey) {
      const now = performance.now();
      if (now - this._lastBroadcastTime >= this._broadcastInterval) {
        this._lastBroadcastTime = now;
        this.sync.broadcast({
          type: 'object:transform',
          id: selectedStroke.id,
          pos: [selectedMesh.position.x, selectedMesh.position.y, selectedMesh.position.z],
          rot: [selectedMesh.rotation.x, selectedMesh.rotation.y, selectedMesh.rotation.z],
          scale: [selectedMesh.scale.x, selectedMesh.scale.y, selectedMesh.scale.z]
        });
      }
    }
  }
}
