import * as THREE from 'three';

const DRAW_STATES = { IDLE: 0, DRAWING: 1 };

// Metallic palette — colors that pop with env reflections
export const PALETTE = [
  '#c0c0c0', // polished silver
  '#ffd700', // gold
  '#b87333', // copper
  '#e5e4e2', // platinum
  '#cd7f32', // bronze
  '#b76e79', // rose gold
  '#4682b4', // steel blue
  '#2f4f4f', // dark chrome
  '#8b0000', // deep red chrome
  '#1a1a2e', // gunmetal
  '#50c878', // emerald chrome
  '#ffffff', // mirror white
];

export const PALETTE_MATERIALS = {
  '#c0c0c0': { metalness: 0.95, roughness: 0.05 },
  '#ffd700': { metalness: 0.95, roughness: 0.08 },
  '#b87333': { metalness: 0.90, roughness: 0.15 },
  '#e5e4e2': { metalness: 0.98, roughness: 0.02 },
  '#cd7f32': { metalness: 0.85, roughness: 0.20 },
  '#b76e79': { metalness: 0.92, roughness: 0.10 },
  '#4682b4': { metalness: 0.88, roughness: 0.12 },
  '#2f4f4f': { metalness: 0.90, roughness: 0.08 },
  '#8b0000': { metalness: 0.85, roughness: 0.15 },
  '#1a1a2e': { metalness: 0.95, roughness: 0.05 },
  '#50c878': { metalness: 0.88, roughness: 0.12 },
  '#ffffff': { metalness: 1.00, roughness: 0.00 },
};

function _makeHandState() {
  return {
    state: DRAW_STATES.IDLE,
    activePoints: [],
    activeMesh: null,
    activeStrokeId: null,
    smoothPos: null,
    activeMaterial: null,
    pointsSinceRebuild: 0,
  };
}

export class StrokeRecorder {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    // Per-hand drawing state (supports 2 simultaneous hands)
    this._handState = [_makeHandState(), _makeHandState()];
    this.completedStrokes = [];
    this.remoteStrokes = new Map();
    this.drawDepth = 1.5;
    this.tubeRadius = 0.024;
    this.tubeSegments = 12;
    this.minPointDistance = 0.01;
    this.color = new THREE.Color(PALETTE[0]);
    this.colorHex = PALETTE[0];

    // Smoothing: exponential moving average
    this._smoothAlpha = 0.5; // lower = smoother, higher = more responsive
    this._activeRadialSegments = 4; // minimal cross-section during drawing (perf)
    this._rebuildEveryN = 4; // only rebuild geometry every Nth point
  }

  /**
   * Convert screen coords to world WITHOUT updating the EMA smooth state.
   * Used by 3D cursor so it doesn't pollute drawing smoothing.
   */
  screenToWorldRaw(nx, ny) {
    const ndc = new THREE.Vector3(
      (1 - nx) * 2 - 1,
      -(ny * 2 - 1),
      0.5
    );
    ndc.unproject(this.camera);
    const dir = ndc.sub(this.camera.position).normalize();
    return this.camera.position.clone().add(dir.multiplyScalar(this.drawDepth));
  }

  setColor(hex) {
    this.color = new THREE.Color(hex);
    this.colorHex = hex;
  }

  setBrushSize(size) {
    this.tubeRadius = size / 1000;
  }

  _getMaterialProps() {
    return PALETTE_MATERIALS[this.colorHex] || { metalness: 0.9, roughness: 0.1 };
  }

  _makeMaterial() {
    const props = this._getMaterialProps();
    return new THREE.MeshPhysicalMaterial({
      color: this.color.clone(),
      metalness: props.metalness,
      roughness: props.roughness,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      envMapIntensity: 3.0,
      reflectivity: 1.0,
      iridescence: 0.4,
      iridescenceIOR: 1.6,
      sheen: 0.2,
      sheenColor: new THREE.Color(0xffffff),
      sheenRoughness: 0.15
    });
  }

  setDrawDepth(depth) {
    this.drawDepth = depth;
  }

  // ── Public update: call once per hand per frame ──
  update(handInteraction, handIndex = 0) {
    const hs = this._handState[handIndex];
    if (!handInteraction) {
      if (hs.state === DRAW_STATES.DRAWING) {
        return this._endStroke(hs);
      }
      return null;
    }

    if (handInteraction.isPinched) {
      const worldPos = this._screenToWorldSmoothed(handInteraction.x, handInteraction.y, hs);

      if (hs.state === DRAW_STATES.IDLE) {
        this._startStroke(worldPos, hs);
        return { type: 'stroke:start', data: { id: hs.activeStrokeId, color: '#' + this.color.getHexString(), radius: this.tubeRadius } };
      } else {
        const added = this._continueStroke(worldPos, hs);
        if (added) {
          return { type: 'stroke:point', data: { id: hs.activeStrokeId, point: [worldPos.x, worldPos.y, worldPos.z] } };
        }
      }
    } else {
      if (hs.state === DRAW_STATES.DRAWING) {
        return this._endStroke(hs);
      }
    }

    return null;
  }

  // ── Backward-compat wrapper for UI (primitive spawning) ──
  screenToWorld(nx, ny) {
    return this._screenToWorldSmoothed(nx, ny, this._handState[0]);
  }

  _screenToWorldSmoothed(nx, ny, hs) {
    const ndc = new THREE.Vector3(
      (1 - nx) * 2 - 1,
      -(ny * 2 - 1),
      0.5
    );
    ndc.unproject(this.camera);

    const dir = ndc.sub(this.camera.position).normalize();
    const raw = this.camera.position.clone().add(dir.multiplyScalar(this.drawDepth));

    if (!hs.smoothPos) {
      hs.smoothPos = raw.clone();
    } else {
      hs.smoothPos.lerp(raw, this._smoothAlpha);
    }

    return hs.smoothPos.clone();
  }

  _startStroke(point, hs) {
    hs.state = DRAW_STATES.DRAWING;
    hs.activePoints = [point.clone()];
    hs.activeStrokeId = crypto.randomUUID();
    hs.smoothPos = point.clone();
    hs.activeMaterial = null;
    hs.pointsSinceRebuild = 0;
  }

  _continueStroke(point, hs) {
    const last = hs.activePoints[hs.activePoints.length - 1];
    if (point.distanceTo(last) < this.minPointDistance) return false;

    hs.activePoints.push(point.clone());
    hs.pointsSinceRebuild++;

    if (hs.pointsSinceRebuild >= this._rebuildEveryN || hs.activePoints.length <= 4) {
      hs.pointsSinceRebuild = 0;
      this._rebuildActiveMesh(hs);
    }
    return true;
  }

  _endStroke(hs) {
    hs.state = DRAW_STATES.IDLE;
    hs.smoothPos = null;

    if (hs.activePoints.length < 3) {
      if (hs.activeMesh) {
        this.scene.remove(hs.activeMesh);
        hs.activeMesh.geometry.dispose();
        hs.activeMesh.material.dispose();
      }
      hs.activeMesh = null;
      hs.activePoints = [];
      const id = hs.activeStrokeId;
      hs.activeStrokeId = null;
      return { type: 'stroke:cancel', data: { id } };
    }

    // Check if ring: start close to end
    const start = hs.activePoints[0];
    const end = hs.activePoints[hs.activePoints.length - 1];
    const ringThreshold = 0.10;
    const isRing = start.distanceTo(end) < ringThreshold && hs.activePoints.length >= 6;

    let center = null;
    let radius = 0;

    if (isRing) {
      center = new THREE.Vector3();
      for (const p of hs.activePoints) center.add(p);
      center.divideScalar(hs.activePoints.length);

      for (const p of hs.activePoints) {
        radius += p.distanceTo(center);
      }
      radius /= hs.activePoints.length;

      const normal = new THREE.Vector3();
      for (let i = 0; i < hs.activePoints.length - 1; i++) {
        const a = hs.activePoints[i].clone().sub(center);
        const b = hs.activePoints[i + 1].clone().sub(center);
        normal.add(new THREE.Vector3().crossVectors(a, b));
      }
      normal.normalize();
      if (normal.lengthSq() < 0.001) normal.set(0, 0, 1);

      const up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(normal.dot(up)) > 0.99) up.set(1, 0, 0);
      const tangent = new THREE.Vector3().crossVectors(normal, up).normalize();
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();

      const circlePoints = [];
      const circleSegments = 48;
      for (let i = 0; i <= circleSegments; i++) {
        const angle = (i / circleSegments) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        const pt = center.clone()
          .add(tangent.clone().multiplyScalar(x))
          .add(bitangent.clone().multiplyScalar(y));
        circlePoints.push(pt);
      }

      hs.activePoints = circlePoints;

      const curve = new THREE.CatmullRomCurve3(hs.activePoints, true);
      const ringGeo = new THREE.TubeGeometry(curve, 64, this.tubeRadius, this.tubeSegments, true);
      if (hs.activeMesh) {
        const oldGeo = hs.activeMesh.geometry;
        hs.activeMesh.geometry = ringGeo;
        oldGeo.dispose();
        if (hs.activeMaterial) {
          hs.activeMaterial.dispose();
          hs.activeMesh.material = this._makeMaterial();
          hs.activeMaterial = null;
        }
      } else {
        hs.activeMesh = new THREE.Mesh(ringGeo, this._makeMaterial());
        this.scene.add(hs.activeMesh);
      }
    }

    // Full-quality rebuild for non-ring strokes
    if (!isRing && hs.activeMesh && hs.activePoints.length >= 2) {
      const oldGeo = hs.activeMesh.geometry;
      const curve = new THREE.CatmullRomCurve3(hs.activePoints);
      curve.curveType = 'catmullrom';
      curve.tension = 0.5;
      const segs = Math.min(Math.max(hs.activePoints.length * 3, 16), 96);
      const finalGeo = new THREE.TubeGeometry(
        curve, segs, this.tubeRadius, this.tubeSegments, false
      );
      hs.activeMesh.geometry = finalGeo;
      oldGeo.dispose();
    }

    // Upgrade material
    if (hs.activeMesh && hs.activeMaterial) {
      hs.activeMaterial.dispose();
      hs.activeMesh.material = this._makeMaterial();
    }

    const stroke = {
      mesh: hs.activeMesh,
      points: hs.activePoints.map(p => [p.x, p.y, p.z]),
      color: '#' + this.color.getHexString(),
      tubeRadius: this.tubeRadius,
      id: hs.activeStrokeId,
      isRing,
      center: center ? [center.x, center.y, center.z] : null,
      radius
    };

    this.completedStrokes.push(stroke);
    hs.activeMesh = null;
    hs.activePoints = [];
    hs.activeMaterial = null;
    const id = hs.activeStrokeId;
    hs.activeStrokeId = null;

    return { type: 'stroke:complete', data: stroke };
  }

  /**
   * Lightweight material for active drawing — no lighting = huge GPU savings.
   * Swapped to full MeshPhysicalMaterial on endStroke.
   */
  _makeActiveMaterial() {
    return new THREE.MeshStandardMaterial({
      color: this.color.clone(),
      metalness: 0.6,
      roughness: 0.3,
      envMapIntensity: 1.0,
    });
  }

  _rebuildActiveMesh(hs) {
    if (hs.activePoints.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(hs.activePoints);
    curve.curveType = 'catmullrom';
    curve.tension = 0.5;
    const segments = Math.min(Math.max(hs.activePoints.length * 2, 8), 64);
    const geometry = new THREE.TubeGeometry(
      curve, segments, this.tubeRadius, this._activeRadialSegments, false
    );

    if (!hs.activeMesh) {
      if (!hs.activeMaterial) {
        hs.activeMaterial = this._makeActiveMaterial();
      }
      hs.activeMesh = new THREE.Mesh(geometry, hs.activeMaterial);
      this.scene.add(hs.activeMesh);
    } else {
      const oldGeo = hs.activeMesh.geometry;
      hs.activeMesh.geometry = geometry;
      oldGeo.dispose();
    }
  }

  // Remote stroke from network
  addRemoteStroke(strokeData) {
    const points = strokeData.points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    if (points.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(points, strokeData.isRing || false);
    const segments = Math.max(points.length * 3, 16);
    // Use the original sender's tubeRadius, not local brush size
    const tubR = strokeData.tubeRadius || this.tubeRadius;
    const geometry = new THREE.TubeGeometry(curve, segments, tubR, this.tubeSegments, strokeData.isRing || false);

    // Match local material quality — use PALETTE_MATERIALS for correct metalness/roughness
    const colorHex = strokeData.color || '#ffffff';
    const matProps = PALETTE_MATERIALS[colorHex] || { metalness: 0.9, roughness: 0.1 };
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(colorHex),
      metalness: matProps.metalness,
      roughness: matProps.roughness,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      envMapIntensity: 3.0,
      reflectivity: 1.0,
      iridescence: 0.4,
      iridescenceIOR: 1.6,
      sheen: 0.2,
      sheenColor: new THREE.Color(0xffffff),
      sheenRoughness: 0.15
    });

    const mesh = new THREE.Mesh(geometry, material);
    this.scene.add(mesh);

    const stroke = { ...strokeData, mesh };
    this.completedStrokes.push(stroke);
    this.remoteStrokes.set(strokeData.id, stroke);

    return stroke;
  }

  updateRemoteActiveStroke(strokeId, point, color, radius) {
    let remote = this.remoteStrokes.get(strokeId);

    if (!remote) {
      remote = { points: [], mesh: null, id: strokeId, color, radius: radius || this.tubeRadius };
      this.remoteStrokes.set(strokeId, remote);
    }

    remote.points.push(new THREE.Vector3(point[0], point[1], point[2]));
    if (remote.points.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(remote.points);
    curve.curveType = 'catmullrom';
    curve.tension = 0.5;
    const segments = Math.min(Math.max(remote.points.length * 2, 16), 120);
    const geometry = new THREE.TubeGeometry(curve, segments, remote.radius || this.tubeRadius, this._activeRadialSegments, false);

    if (!remote.mesh) {
      const material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(color || '#ffffff'),
        metalness: 0.3,
        roughness: 0.15,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        envMapIntensity: 2.0,
        transparent: true,
        opacity: 0.7
      });
      remote.mesh = new THREE.Mesh(geometry, material);
      this.scene.add(remote.mesh); // add to scene only once
    } else {
      // Swap geometry in place — no flicker
      const oldGeo = remote.mesh.geometry;
      remote.mesh.geometry = geometry;
      oldGeo.dispose();
    }
  }

  cancelRemoteActiveStroke(strokeId) {
    const remote = this.remoteStrokes.get(strokeId);
    if (remote && remote.mesh) {
      this.scene.remove(remote.mesh);
      remote.mesh.geometry.dispose();
      remote.mesh.material.dispose();
    }
    this.remoteStrokes.delete(strokeId);
  }

  undoLastStroke() {
    const stroke = this.completedStrokes.pop();
    if (!stroke) return null;

    if (stroke.mesh) {
      this.scene.remove(stroke.mesh);
      stroke.mesh.geometry.dispose();
      stroke.mesh.material.dispose();
    }

    return stroke.id;
  }

  clearAll() {
    // Clean up active strokes on both hands
    for (const hs of this._handState) {
      if (hs.activeMesh) {
        this.scene.remove(hs.activeMesh);
        hs.activeMesh.geometry.dispose();
        if (hs.activeMaterial) hs.activeMaterial.dispose();
      }
      Object.assign(hs, _makeHandState());
    }

    for (const stroke of this.completedStrokes) {
      if (stroke.mesh) {
        this.scene.remove(stroke.mesh);
        stroke.mesh.geometry.dispose();
        stroke.mesh.material.dispose();
      }
    }
    this.completedStrokes = [];

    for (const [id, remote] of this.remoteStrokes) {
      if (remote.mesh) {
        this.scene.remove(remote.mesh);
        remote.mesh.geometry.dispose();
        if (remote.mesh.material) remote.mesh.material.dispose();
      }
    }
    this.remoteStrokes.clear();
  }

  addPrimitive(type, position, scale = 1.5, colorHex = null) {
    let geometry;
    switch (type) {
      case 'cube':
        geometry = new THREE.BoxGeometry(scale, scale, scale);
        break;
      case 'sphere':
        geometry = new THREE.SphereGeometry(scale / 2, 32, 32);
        break;
      case 'cylinder':
        geometry = new THREE.CylinderGeometry(scale / 3, scale / 3, scale, 32);
        break;
      case 'torus':
        geometry = new THREE.TorusGeometry(scale / 2, scale / 6, 16, 48);
        break;
      default:
        geometry = new THREE.BoxGeometry(scale, scale, scale);
    }

    // Use provided color (from remote) or current local color
    const useColorHex = colorHex || ('#' + this.color.getHexString());
    const savedColor = this.color.clone();
    const savedHex = this.colorHex;
    if (colorHex) {
      this.color = new THREE.Color(colorHex);
      this.colorHex = colorHex;
    }
    const material = this._makeMaterial();
    // Restore local color if we temporarily changed it
    if (colorHex) {
      this.color = savedColor;
      this.colorHex = savedHex;
    }

    const mesh = new THREE.Mesh(geometry, material);
    const pos = position || new THREE.Vector3(0, 1.0, 0);
    mesh.position.copy(pos);
    this.scene.add(mesh);

    const id = crypto.randomUUID();
    mesh.userData._physId = id;

    const stroke = {
      mesh,
      id,
      isPrimitive: true,
      primitiveType: type,
      color: useColorHex,
      position: [pos.x, pos.y, pos.z],
      scale,
      points: [],
      isRing: false,
      center: [pos.x, pos.y, pos.z],
      radius: scale / 2
    };

    this.completedStrokes.push(stroke);
    return stroke;
  }

  removeStrokeById(strokeId) {
    const idx = this.completedStrokes.findIndex(s => s.id === strokeId);
    if (idx !== -1) {
      const stroke = this.completedStrokes[idx];
      if (stroke.mesh) {
        this.scene.remove(stroke.mesh);
        stroke.mesh.geometry.dispose();
        stroke.mesh.material.dispose();
      }
      this.completedStrokes.splice(idx, 1);
    }
  }
}
