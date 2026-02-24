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

export class StrokeRecorder {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.state = DRAW_STATES.IDLE;
    this.activePoints = [];
    this.activeMesh = null;
    this.completedStrokes = [];
    this.remoteStrokes = new Map();
    this.drawDepth = 1.5;
    this.tubeRadius = 0.024;
    this.tubeSegments = 12;
    this.minPointDistance = 0.012;
    this.color = new THREE.Color(PALETTE[0]);
    this.colorHex = PALETTE[0];
    this.activeStrokeId = null;

    // Smoothing: exponential moving average
    this._smoothPos = null;
    this._smoothAlpha = 0.35; // lower = smoother, higher = more responsive
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

  update(handInteraction) {
    if (!handInteraction) {
      if (this.state === DRAW_STATES.DRAWING) {
        return this.endStroke();
      }
      return null;
    }

    if (handInteraction.isPinched) {
      const worldPos = this.screenToWorld(handInteraction.x, handInteraction.y);

      if (this.state === DRAW_STATES.IDLE) {
        this.startStroke(worldPos);
        return { type: 'stroke:start', data: { id: this.activeStrokeId, color: '#' + this.color.getHexString(), radius: this.tubeRadius } };
      } else {
        const added = this.continueStroke(worldPos);
        if (added) {
          return { type: 'stroke:point', data: { id: this.activeStrokeId, point: [worldPos.x, worldPos.y, worldPos.z] } };
        }
      }
    } else {
      if (this.state === DRAW_STATES.DRAWING) {
        return this.endStroke();
      }
    }

    return null;
  }

  screenToWorld(nx, ny) {
    const ndc = new THREE.Vector3(
      (1 - nx) * 2 - 1,
      -(ny * 2 - 1),
      0.5
    );
    ndc.unproject(this.camera);

    const dir = ndc.sub(this.camera.position).normalize();
    const raw = this.camera.position.clone().add(dir.multiplyScalar(this.drawDepth));

    // Exponential moving average smoothing — much smoother than buffer averaging
    if (!this._smoothPos) {
      this._smoothPos = raw.clone();
    } else {
      this._smoothPos.lerp(raw, this._smoothAlpha);
    }

    return this._smoothPos.clone();
  }

  startStroke(point) {
    this.state = DRAW_STATES.DRAWING;
    this.activePoints = [point.clone()];
    this.activeStrokeId = crypto.randomUUID();
    this._smoothPos = point.clone();
  }

  continueStroke(point) {
    const last = this.activePoints[this.activePoints.length - 1];
    if (point.distanceTo(last) < this.minPointDistance) return false;

    this.activePoints.push(point.clone());
    this.rebuildActiveMesh();
    return true;
  }

  endStroke() {
    this.state = DRAW_STATES.IDLE;
    this._smoothPos = null;

    if (this.activePoints.length < 3) {
      if (this.activeMesh) {
        this.scene.remove(this.activeMesh);
        this.activeMesh.geometry.dispose();
        this.activeMesh.material.dispose();
      }
      this.activeMesh = null;
      this.activePoints = [];
      const id = this.activeStrokeId;
      this.activeStrokeId = null;
      return { type: 'stroke:cancel', data: { id } };
    }

    // Check if ring: start close to end
    const start = this.activePoints[0];
    const end = this.activePoints[this.activePoints.length - 1];
    const ringThreshold = 0.10; // 10cm — generous threshold
    const isRing = start.distanceTo(end) < ringThreshold && this.activePoints.length >= 6;

    let center = null;
    let radius = 0;

    if (isRing) {
      // *** RING AUTOCOMPLETION ***
      // Fit an ellipse/circle to the drawn points and replace with a clean ring

      // 1. Compute center
      center = new THREE.Vector3();
      for (const p of this.activePoints) center.add(p);
      center.divideScalar(this.activePoints.length);

      // 2. Compute average radius
      for (const p of this.activePoints) {
        radius += p.distanceTo(center);
      }
      radius /= this.activePoints.length;

      // 3. Compute the ring plane normal (best-fit plane via cross products)
      const normal = new THREE.Vector3();
      for (let i = 0; i < this.activePoints.length - 1; i++) {
        const a = this.activePoints[i].clone().sub(center);
        const b = this.activePoints[i + 1].clone().sub(center);
        normal.add(new THREE.Vector3().crossVectors(a, b));
      }
      normal.normalize();
      if (normal.lengthSq() < 0.001) normal.set(0, 0, 1); // fallback

      // 4. Build orthonormal basis on the ring plane
      const up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(normal.dot(up)) > 0.99) up.set(1, 0, 0);
      const tangent = new THREE.Vector3().crossVectors(normal, up).normalize();
      const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();

      // 5. Generate clean circle points
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

      // Replace drawn points with clean circle
      this.activePoints = circlePoints;

      // Rebuild mesh with clean ring
      if (this.activeMesh) {
        this.scene.remove(this.activeMesh);
        this.activeMesh.geometry.dispose();
      }

      const curve = new THREE.CatmullRomCurve3(this.activePoints, true); // closed
      const geometry = new THREE.TubeGeometry(curve, circleSegments * 2, this.tubeRadius, this.tubeSegments, true);
      if (this.activeMesh) {
        this.activeMesh.geometry = geometry;
      } else {
        this.activeMesh = new THREE.Mesh(geometry, this._makeMaterial());
      }
      this.scene.add(this.activeMesh);
    }

    const stroke = {
      mesh: this.activeMesh,
      points: this.activePoints.map(p => [p.x, p.y, p.z]),
      color: '#' + this.color.getHexString(),
      id: this.activeStrokeId,
      isRing,
      center: center ? [center.x, center.y, center.z] : null,
      radius
    };

    this.completedStrokes.push(stroke);
    this.activeMesh = null;
    this.activePoints = [];
    const id = this.activeStrokeId;
    this.activeStrokeId = null;

    return { type: 'stroke:complete', data: stroke };
  }

  rebuildActiveMesh() {
    if (this.activePoints.length < 2) return;

    if (this.activeMesh) {
      this.scene.remove(this.activeMesh);
      this.activeMesh.geometry.dispose();
    }

    const curve = new THREE.CatmullRomCurve3(this.activePoints);
    curve.curveType = 'catmullrom';
    curve.tension = 0.5;
    const segments = Math.max(this.activePoints.length * 3, 16);
    const geometry = new THREE.TubeGeometry(
      curve,
      segments,
      this.tubeRadius,
      this.tubeSegments,
      false
    );

    if (!this.activeMesh) {
      this.activeMesh = new THREE.Mesh(geometry, this._makeMaterial());
    } else {
      this.activeMesh.geometry = geometry;
    }

    this.scene.add(this.activeMesh);
  }

  // Remote stroke from network
  addRemoteStroke(strokeData) {
    const points = strokeData.points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    if (points.length < 2) return;

    const curve = new THREE.CatmullRomCurve3(points, strokeData.isRing || false);
    const segments = Math.max(points.length * 3, 16);
    const radius = strokeData.radius || this.tubeRadius;
    const geometry = new THREE.TubeGeometry(curve, segments, radius, this.tubeSegments, strokeData.isRing || false);

    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(strokeData.color || '#ffffff'),
      metalness: 0.9,
      roughness: 0.1,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 2.5,
      reflectivity: 1.0
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

    if (remote.mesh) {
      this.scene.remove(remote.mesh);
      remote.mesh.geometry.dispose();
    }

    const curve = new THREE.CatmullRomCurve3(remote.points);
    const segments = Math.max(remote.points.length * 3, 16);
    const geometry = new THREE.TubeGeometry(curve, segments, remote.radius || this.tubeRadius, this.tubeSegments, false);

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
    } else {
      remote.mesh.geometry = geometry;
    }

    this.scene.add(remote.mesh);
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

  addPrimitive(type, position, scale = 0.15) {
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

    const material = this._makeMaterial();
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
      color: '#' + this.color.getHexString(),
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
