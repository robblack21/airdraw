// quatBall.js — Disco-ball style precision rotation/scale/position widget
import * as THREE from 'three';

const BALL_RADIUS = 0.18;
const FACET_COLORS = [
  0x334455, 0x3a3a5c, 0x2b3d4f, 0x404060,
  0x354050, 0x3c3a58, 0x2e4055, 0x383865
];

const HOVER_COLOR = new THREE.Color(0x66aaff);
const ANCHOR_COLOR = new THREE.Color(0xff6644);
const SECOND_COLOR = new THREE.Color(0x44ff88);

export class QuatBall {
  constructor(rendererDom, camera, scene) {
    this.dom = rendererDom;
    this.camera = camera;
    this.scene = scene;

    this.group = new THREE.Group();
    this.group.visible = false;
    this.scene.add(this.group);

    this.facets = [];          // Array of { mesh, normal, center }
    this.anchorFacet = null;   // First selected facet
    this.secondFacet = null;   // Second selected facet
    this.rotationAxis = null;  // Computed axis from two facets
    this.targetMesh = null;    // The mesh being manipulated
    this.isDragging = false;
    this.lastDragAngle = 0;
    this.active = false;

    this._raycaster = new THREE.Raycaster();
    this._mouse = new THREE.Vector2();
    this._hoveredFacet = null;

    this._buildBall();
    this._setupEvents();
  }

  _buildBall() {
    // Create icosphere and separate each face into an individual mesh
    const icoGeo = new THREE.IcosahedronGeometry(BALL_RADIUS, 2);
    const posAttr = icoGeo.getAttribute('position');
    const index = icoGeo.getIndex();

    const faceCount = index ? index.count / 3 : posAttr.count / 3;

    for (let i = 0; i < faceCount; i++) {
      const a = index ? index.getX(i * 3) : i * 3;
      const b = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      const c = index ? index.getX(i * 3 + 2) : i * 3 + 2;

      const va = new THREE.Vector3(posAttr.getX(a), posAttr.getY(a), posAttr.getZ(a));
      const vb = new THREE.Vector3(posAttr.getX(b), posAttr.getY(b), posAttr.getZ(b));
      const vc = new THREE.Vector3(posAttr.getX(c), posAttr.getY(c), posAttr.getZ(c));

      // Face center
      const center = new THREE.Vector3().addVectors(va, vb).add(vc).divideScalar(3);
      const normal = center.clone().normalize();

      // Build individual triangle geometry
      const triGeo = new THREE.BufferGeometry();
      const verts = new Float32Array([
        va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z
      ]);
      triGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      triGeo.computeVertexNormals();

      const colorIdx = i % FACET_COLORS.length;
      const mat = new THREE.MeshPhysicalMaterial({
        color: FACET_COLORS[colorIdx],
        metalness: 0.85,
        roughness: 0.12,
        clearcoat: 0.8,
        clearcoatRoughness: 0.05,
        envMapIntensity: 2.0,
        side: THREE.DoubleSide
      });

      const mesh = new THREE.Mesh(triGeo, mat);
      mesh.userData._facetIndex = i;
      this.group.add(mesh);

      this.facets.push({ mesh, normal, center, originalColor: new THREE.Color(FACET_COLORS[colorIdx]) });
    }

    icoGeo.dispose();

    // Add wireframe overlay for disco-ball look
    const wireGeo = new THREE.IcosahedronGeometry(BALL_RADIUS * 1.001, 2);
    const wireMat = new THREE.MeshBasicMaterial({
      color: 0x888899,
      wireframe: true,
      transparent: true,
      opacity: 0.15
    });
    this.group.add(new THREE.Mesh(wireGeo, wireMat));
  }

  _setupEvents() {
    this.dom.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this._onMouseMove(e);
    });

    this.dom.addEventListener('click', (e) => {
      if (!this.active) return;
      this._onClick(e);
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.active || !this.rotationAxis) return;
      if (e.button === 0) {
        this.isDragging = true;
        this.lastDragAngle = this._getDragAngle(e);
      }
    });

    this.dom.addEventListener('mousemove', (e) => {
      if (!this.isDragging || !this.rotationAxis || !this.targetMesh) return;
      const angle = this._getDragAngle(e);
      const delta = angle - this.lastDragAngle;
      this.lastDragAngle = angle;

      // Rotate target around axis
      const quat = new THREE.Quaternion().setFromAxisAngle(this.rotationAxis, delta * 3.0);
      this.targetMesh.quaternion.premultiply(quat);
    });

    this.dom.addEventListener('mouseup', () => {
      this.isDragging = false;
    });

    // Right-click to reset facet selection
    this.dom.addEventListener('contextmenu', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this._resetSelection();
    });
  }

  _getDragAngle(e) {
    return Math.atan2(
      e.clientY - window.innerHeight / 2,
      e.clientX - window.innerWidth / 2
    );
  }

  _onMouseMove(e) {
    this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    this._raycaster.setFromCamera(this._mouse, this.camera);
    const facetMeshes = this.facets.map(f => f.mesh);
    const intersects = this._raycaster.intersectObjects(facetMeshes, false);

    // Un-hover previous
    if (this._hoveredFacet && this._hoveredFacet !== this.anchorFacet && this._hoveredFacet !== this.secondFacet) {
      const idx = this._hoveredFacet.userData._facetIndex;
      this._hoveredFacet.material.emissive.set(0x000000);
      this._hoveredFacet = null;
    }

    if (intersects.length > 0) {
      const hit = intersects[0].object;
      if (hit !== this.anchorFacet?.mesh && hit !== this.secondFacet?.mesh) {
        hit.material.emissive.copy(HOVER_COLOR).multiplyScalar(0.3);
        this._hoveredFacet = hit;
      }
      this.dom.style.cursor = 'crosshair';
    } else {
      this.dom.style.cursor = '';
    }
  }

  _onClick(e) {
    if (!this._hoveredFacet && !this.anchorFacet) return;

    this._mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    this._mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this._raycaster.setFromCamera(this._mouse, this.camera);
    const facetMeshes = this.facets.map(f => f.mesh);
    const intersects = this._raycaster.intersectObjects(facetMeshes, false);

    if (intersects.length === 0) return;
    const hitMesh = intersects[0].object;
    const facetData = this.facets.find(f => f.mesh === hitMesh);
    if (!facetData) return;

    if (!this.anchorFacet) {
      // First click: set anchor
      this.anchorFacet = facetData;
      facetData.mesh.material.emissive.copy(ANCHOR_COLOR).multiplyScalar(0.5);
      facetData.mesh.material.color.copy(ANCHOR_COLOR);
    } else if (!this.secondFacet && facetData !== this.anchorFacet) {
      // Second click: define axis
      this.secondFacet = facetData;
      facetData.mesh.material.emissive.copy(SECOND_COLOR).multiplyScalar(0.5);
      facetData.mesh.material.color.copy(SECOND_COLOR);

      // Compute rotation axis from two face normals
      this.rotationAxis = new THREE.Vector3()
        .crossVectors(this.anchorFacet.normal, this.secondFacet.normal)
        .normalize();

      // If normals are parallel, fall back to the anchor normal itself
      if (this.rotationAxis.lengthSq() < 0.001) {
        this.rotationAxis.copy(this.anchorFacet.normal);
      }
    }
  }

  _resetSelection() {
    if (this.anchorFacet) {
      this.anchorFacet.mesh.material.emissive.set(0x000000);
      this.anchorFacet.mesh.material.color.copy(this.anchorFacet.originalColor);
    }
    if (this.secondFacet) {
      this.secondFacet.mesh.material.emissive.set(0x000000);
      this.secondFacet.mesh.material.color.copy(this.secondFacet.originalColor);
    }
    this.anchorFacet = null;
    this.secondFacet = null;
    this.rotationAxis = null;
    this.isDragging = false;
  }

  // Show the quat ball positioned near the target object
  show(targetMesh) {
    if (!targetMesh) return;
    this.targetMesh = targetMesh;
    this.active = true;
    this.group.visible = true;

    // Position next to target
    const box = new THREE.Box3().setFromObject(targetMesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);

    const center = new THREE.Vector3();
    box.getCenter(center);

    this.group.position.set(
      center.x + maxDim * 0.8 + BALL_RADIUS * 1.5,
      center.y,
      center.z
    );

    this._resetSelection();
  }

  hide() {
    this.active = false;
    this.group.visible = false;
    this.targetMesh = null;
    this._resetSelection();
    this.dom.style.cursor = '';
  }

  toggle(targetMesh) {
    if (this.active) {
      this.hide();
    } else {
      this.show(targetMesh);
    }
  }

  // Called each frame — keeps the ball slowly spinning for visual flair
  update(dt) {
    if (!this.active) return;
    this.group.rotation.y += 0.1 * dt;
  }
}
