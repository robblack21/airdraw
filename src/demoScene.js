// demoScene.js — 3 chain-linked vertical rings
import * as THREE from 'three';

/**
 * Procedural normal map for organic hammered metal.
 * Creates subtle dents for a forged/organic look while staying shiny.
 */
function createMetalNormalMap(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Neutral normal base
  ctx.fillStyle = 'rgb(128, 128, 255)';
  ctx.fillRect(0, 0, size, size);

  // Subtle hammered dents — small normal perturbations
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1.5 + Math.random() * 4;
    const nx = 128 + (Math.random() - 0.5) * 16;  // subtle
    const ny = 128 + (Math.random() - 0.5) * 16;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgb(${Math.floor(nx)}, ${Math.floor(ny)}, 248)`);
    grad.addColorStop(1, 'rgb(128, 128, 255)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fine hairline scratches
  ctx.strokeStyle = 'rgba(134, 124, 252, 0.15)';
  ctx.lineWidth = 0.3;
  for (let i = 0; i < 25; i++) {
    ctx.beginPath();
    const sx = Math.random() * size, sy = Math.random() * size;
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + (Math.random() - 0.5) * 20, sy + (Math.random() - 0.5) * 20);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  return texture;
}

export function buildDemoScene(scene, physics, drawer) {
  const ringRadius = 0.55;
  const tubeRadius = 0.055;
  // CRITICAL: spacing must match joint constraint distance exactly
  // Joint anchors are at (radius - tubeRadius) from each ring's center
  // So center-to-center distance = 2 * (radius - tubeRadius)
  const spacing = 2 * (ringRadius - tubeRadius);  // = 0.99m

  const normalMap = createMetalNormalMap();

  // Shiny but organic metals — high metalness, LOW roughness, subtle normal map
  const ringMaterials = [
    // Gold — gleaming warm gold with subtle forged texture
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#d4a017'),
      metalness: 0.95,
      roughness: 0.08,
      normalMap,
      normalScale: new THREE.Vector2(0.15, 0.15),
      clearcoat: 0.4,
      clearcoatRoughness: 0.1,
      envMapIntensity: 3.0,
      reflectivity: 0.95,
      sheen: 0.2,
      sheenColor: new THREE.Color('#ffee88'),
      sheenRoughness: 0.2,
    }),
    // Silver — cool polished silver, very reflective
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#d0d0d8'),
      metalness: 0.98,
      roughness: 0.06,
      normalMap,
      normalScale: new THREE.Vector2(0.12, 0.12),
      clearcoat: 0.3,
      clearcoatRoughness: 0.05,
      envMapIntensity: 3.0,
      reflectivity: 1.0,
      sheen: 0.1,
      sheenColor: new THREE.Color('#c0c8e0'),
      sheenRoughness: 0.15,
    }),
    // Copper — warm gleaming copper
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color('#b87333'),
      metalness: 0.92,
      roughness: 0.1,
      normalMap,
      normalScale: new THREE.Vector2(0.18, 0.18),
      clearcoat: 0.35,
      clearcoatRoughness: 0.08,
      envMapIntensity: 2.8,
      reflectivity: 0.9,
      iridescence: 0.15,
      iridescenceIOR: 1.5,
      sheen: 0.25,
      sheenColor: new THREE.Color('#ff9955'),
      sheenRoughness: 0.2,
    }),
  ];

  const yRotDeg = [0, 90, 0];
  const topY = 3.0;
  const strokes = [];

  // Two columns side by side
  const columnOffsets = [-0.8, 0.8];  // x positions for left and right columns

  for (let col = 0; col < columnOffsets.length; col++) {
    const xOffset = columnOffsets[col];

    for (let idx = 0; idx < 3; idx++) {
      const geometry = new THREE.TorusGeometry(ringRadius, tubeRadius, 16, 48);
      const center = new THREE.Vector3(xOffset, topY - spacing * idx, -1.0);
      const matIdx = idx % ringMaterials.length;
      const mesh = new THREE.Mesh(geometry, ringMaterials[matIdx].clone());
      mesh.position.copy(center);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);

      const id = `demo-ring-${col}-${idx}`;
      mesh.userData._physId = id;

      const qYaw = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(yRotDeg[idx])
      );

      const stroke = {
        mesh, id,
        isRing: true,
        isDemoTorus: true,
        isPrimitive: false,
        color: ringMaterials[matIdx].color.getHexString(),
        center: [center.x, center.y, center.z],
        radius: ringRadius,
        points: [],
      };

      drawer.completedStrokes.push(stroke);
      strokes.push(stroke);

      const isTopRing = (idx === 0);
      physics.addRing(id, stroke.center, ringRadius, mesh, {
        x: qYaw.x, y: qYaw.y, z: qYaw.z, w: qYaw.w
      }, tubeRadius, isTopRing);
    }
  }

  console.log(`Demo scene: ${strokes.length} chain-linked rings (${columnOffsets.length} columns)`);
  return strokes;
}
