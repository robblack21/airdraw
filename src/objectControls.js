// objectControls.js — Mouse-based selection + keyboard manipulation of scene objects
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

export class ObjectControls {
  constructor(rendererDom, cameraRef, sceneRef, drawer, physics, sync) {
    this.dom = rendererDom;
    this.camera = cameraRef;
    this.scene = sceneRef;
    this.drawer = drawer;
    this.physics = physics;
    this.sync = sync;

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
    }

    selectedMesh = mesh;
    selectedStroke = this.drawer.completedStrokes.find(s => s.mesh === mesh) || null;
    this._setEmissive(selectedMesh, SELECT_EMISSIVE);
    setObjectSelected(true);
  }

  deselect() {
    if (selectedMesh) {
      this._restoreEmissive(selectedMesh);
    }
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

  // Called each frame from main loop
  update(dt) {
    // Escape to deselect
    if (keys.escape) {
      this.deselect();
      keys.escape = false; // consume
      return;
    }

    if (!selectedMesh) return;

    // --- Rotation ---
    // R/Y = pitch (X-axis rotation)
    if (keys.r) selectedMesh.rotation.x += ROT_SPEED * dt;
    if (keys.y) selectedMesh.rotation.x -= ROT_SPEED * dt;
    // O/P = yaw (Y-axis rotation)
    if (keys.o) selectedMesh.rotation.y += ROT_SPEED * dt;
    if (keys.p) selectedMesh.rotation.y -= ROT_SPEED * dt;

    // --- Position ---
    // T/B = up/down (Y)
    if (keys.t) selectedMesh.position.y += POS_SPEED * dt;
    if (keys.b) selectedMesh.position.y -= POS_SPEED * dt;
    // G/H = left/right (X)
    if (keys.g) selectedMesh.position.x -= POS_SPEED * dt;
    if (keys.h) selectedMesh.position.x += POS_SPEED * dt;
    // F/V = forward/back (Z)
    if (keys.f) selectedMesh.position.z -= POS_SPEED * dt;
    if (keys.v) selectedMesh.position.z += POS_SPEED * dt;

    // --- Scale ---
    // , = scale down, . = scale up
    if (keys[',']) {
      const s = 1 - SCALE_SPEED * dt;
      selectedMesh.scale.multiplyScalar(Math.max(s, 0.1));
    }
    if (keys['.']) {
      const s = 1 + SCALE_SPEED * dt;
      selectedMesh.scale.multiplyScalar(Math.min(s, 10));
    }

    // Broadcast transform if changed
    if (this.sync && selectedStroke && (
      keys.r || keys.y || keys.o || keys.p ||
      keys.t || keys.b || keys.g || keys.h || keys.f || keys.v ||
      keys[','] || keys['.']
    )) {
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
