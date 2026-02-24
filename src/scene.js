import * as THREE from "three";
import { trackingState } from "./vision.js";

export let scene, camera, renderer;
let clock;

// Volumetric Video State
let volumetricSplats = null;
let cutoutTexture = null;

let currentRole = "w";

// Camera state
let cameraBasePos = new THREE.Vector3();
let isOverhead = false;
let savedCameraPos = new THREE.Vector3();
let savedCameraQuat = new THREE.Quaternion();

// Controls
export const keys = {
  w: false,
  a: false,
  s: false,
  d: false,
  q: false,
  e: false,
  i: false,
  j: false,
  k: false,
  l: false,
  // Object manipulation
  r: false,
  y: false,
  o: false,
  p: false,
  t: false,
  f: false,
  g: false,
  h: false,
  v: false,
  b: false,
  ",": false,
  ".": false,
  // Zoom
  "[": false,
  "]": false,
  // Deselect
  escape: false,
};
const moveSpeed = 2.0;
const rotSpeed = 1.5;
const zoomKeySpeed = 15.0; // FOV degrees per second for bracket zoom

// Track whether an object is currently selected (set by objectControls)
export let objectSelected = false;
export function setObjectSelected(val) {
  objectSelected = val;
}

let headTrackingEnabled = false;

export function setHeadTrackingEnabled(enabled) {
  headTrackingEnabled = enabled;
}

export function setDepthThresholds(min, max) {
  if (volumetricSplats && volumetricSplats.material) {
    volumetricSplats.material.uniforms.minDepth.value = min;
    volumetricSplats.material.uniforms.maxDepth.value = max;
  }
}

// Create Volumetric Video as Dynamic Gaussian Splats (Instanced Quads)
export function createCutout(videoElement) {
  if (volumetricSplats) {
    if (cutoutTexture.map.image !== videoElement) {
      cutoutTexture.map.image = videoElement;
      cutoutTexture.map.needsUpdate = true;
    }
    return;
  }

  const width = 252;
  const height = 252;
  const instanceCount = width * height;

  const baseGeometry = new THREE.PlaneGeometry(1, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = baseGeometry.index;
  geometry.attributes.position = baseGeometry.attributes.position;
  geometry.attributes.uv = baseGeometry.attributes.uv;
  geometry.instanceCount = instanceCount;

  const texture = new THREE.VideoTexture(videoElement);
  texture.format = THREE.RGBAFormat;
  texture.colorSpace = THREE.SRGBColorSpace;

  cutoutTexture = { map: texture };

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      depthScale: { value: 1.0 },
      minDepth: { value: 0.0 },
      maxDepth: { value: 0.5 },
      splatScale: { value: 0.015 },
      unprojectScale: { value: 1.15 },
      aspectRatio: { value: 1.0 },
    },
    vertexShader: `
      uniform sampler2D map;
      uniform float depthScale;
      uniform float splatScale;
      uniform float unprojectScale;

      varying vec2 vUv;
      varying vec2 vImgUv;
      varying float vDepth;

      const float width = 252.0;
      const float height = 252.0;

      void main() {
        vUv = uv;

        float gridX = mod(float(gl_InstanceID), width);
        float gridY = floor(float(gl_InstanceID) / width);

        vec2 gridUv = vec2((gridX + 0.5) / width, (gridY + 0.5) / height);
        vImgUv = gridUv;

        vec2 depthUv = vec2(gridUv.x * 0.5 + 0.5, gridUv.y);
        float d = texture2D(map, depthUv).r;
        vDepth = d;

        float x = ((gridX / width) - 0.5) * unprojectScale;
        float y = ((gridY / height) - 0.5) * unprojectScale;

        vec3 centerPos = vec3(x, y, 0.0);
        centerPos.z += d * depthScale;

        vec4 mvPosition = modelViewMatrix * vec4(centerPos, 1.0);
        vec2 scale = vec2(splatScale);
        mvPosition.xy += position.xy * scale;

        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float minDepth;
      uniform float maxDepth;

      varying vec2 vUv;
      varying vec2 vImgUv;
      varying float vDepth;

      void main() {
        if (vDepth < minDepth || vDepth > maxDepth) discard;

        vec2 center = vUv - 0.5;
        float distSq = dot(center, center);
        float alpha = exp(-distSq * 10.0);

        if (alpha < 0.01) discard;

        vec2 colorUv = vec2(vImgUv.x * 0.5, vImgUv.y);
        vec4 color = texture2D(map, colorUv);

        gl_FragColor = vec4(color.rgb, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });

  volumetricSplats = new THREE.InstancedMesh(geometry, material, instanceCount);
  volumetricSplats.frustumCulled = false;
  volumetricSplats.renderOrder = 999;

  scene.add(volumetricSplats);
  updateVolumetricPose();
}

function updateVolumetricPose() {
  if (!volumetricSplats) return;

  const dist = 0.55;
  const height = 0.95;

  volumetricSplats.scale.set(0.65, 0.65, 0.65);

  if (currentRole === "w") {
    volumetricSplats.position.set(0, height, -dist);
    volumetricSplats.lookAt(0, height, dist);
  } else if (currentRole === "b") {
    volumetricSplats.position.set(0, height, dist);
    volumetricSplats.lookAt(0, height, -dist);
  }
  volumetricSplats.rotation.y += Math.PI;
}

export function setupControls(dom) {
  if (!dom) return;

  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (keys.hasOwnProperty(k)) keys[k] = true;
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (keys.hasOwnProperty(k)) keys[k] = false;
  });

  // Zoom (Wheel) -> Camera FOV
  dom.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const zoomSpeed = 0.05;
      camera.fov += e.deltaY * zoomSpeed;
      camera.fov = Math.max(5, Math.min(100, camera.fov));
      camera.updateProjectionMatrix();
    },
    { passive: false },
  );

  dom.addEventListener("contextmenu", (e) => e.preventDefault());
}

export function animateScene(time) {
  const dt = clock.getDelta();

  // 1. WASD + QE -> Camera movement (only when no object selected, or always for WASD)
  const move = new THREE.Vector3();
  if (keys.w) move.z -= 1;
  if (keys.s) move.z += 1;
  if (keys.a) move.x -= 1;
  if (keys.d) move.x += 1;
  if (keys.q) move.y -= 1;
  if (keys.e) move.y += 1;

  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(moveSpeed * dt);
    move.applyQuaternion(camera.quaternion);
    cameraBasePos.add(move);
  }

  // Bracket zoom: [ = zoom out (increase FOV), ] = zoom in (decrease FOV)
  if (keys["["]) {
    camera.fov = Math.min(100, camera.fov + zoomKeySpeed * dt);
    camera.updateProjectionMatrix();
  }
  if (keys["]"]) {
    camera.fov = Math.max(5, camera.fov - zoomKeySpeed * dt);
    camera.updateProjectionMatrix();
  }

  // 2. IJKL -> Camera rotation
  if (keys.j) camera.rotation.y += rotSpeed * dt;
  if (keys.l) camera.rotation.y -= rotSpeed * dt;
  if (keys.i) camera.rotation.x += rotSpeed * dt;
  if (keys.k) camera.rotation.x -= rotSpeed * dt;

  // Reset camera to base before applying parallax
  camera.position.copy(cameraBasePos);

  // 3. Head Tracking Parallax
  if (
    headTrackingEnabled &&
    trackingState &&
    trackingState.headPose &&
    trackingState.headPose.faceLandmarks &&
    trackingState.headPose.faceLandmarks.length > 0
  ) {
    const face = trackingState.headPose.faceLandmarks[0];
    const nose = face[1];

    const dx = (nose.x - 0.5) * 2.0;
    const dy = (nose.y - 0.5) * 2.0;

    const rangeX = 0.1;
    const rangeY = 0.1;

    const offsetX = -dx * rangeX;
    const offsetY = -dy * rangeY;

    const parallax = new THREE.Vector3(offsetX, offsetY, 0);
    parallax.applyQuaternion(camera.quaternion);
    camera.position.add(parallax);
  }

  renderer.render(scene, camera);
}

export function toggleOverheadView() {
  isOverhead = !isOverhead;

  if (isOverhead) {
    savedCameraPos.copy(cameraBasePos);
    savedCameraQuat.copy(camera.quaternion);

    camera.position.set(0, 4, 0.01);
    camera.lookAt(0, 0, 0);
    cameraBasePos.copy(camera.position);
  } else {
    cameraBasePos.copy(savedCameraPos);
    camera.position.copy(savedCameraPos);
    camera.quaternion.copy(savedCameraQuat);
  }

  return isOverhead;
}

// Random spawn offset for multi-user (seeded once per session)
const spawnOffsetX = (Math.random() - 0.5) * 3.0;
const spawnOffsetZ = (Math.random() - 0.5) * 1.0;

export function updateCameraPose(role) {
  currentRole = role;
  updateVolumetricPose();

  if (isOverhead) return;

  camera.fov = 50;
  camera.updateProjectionMatrix();

  if (role === "w") {
    camera.position.set(spawnOffsetX, 1.5, 2.5 + spawnOffsetZ);
    camera.lookAt(0, 1.0, 0);
  } else if (role === "b") {
    camera.position.set(spawnOffsetX, 1.5, -2.5 + spawnOffsetZ);
    camera.lookAt(0, 1.0, 0);
  } else {
    camera.position.set(2.5 + spawnOffsetX, 2.5, spawnOffsetZ);
    camera.lookAt(0, 1.0, 0);
  }

  cameraBasePos.copy(camera.position);
}

export async function initScene() {
  clock = new THREE.Clock();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111118);

  camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.05,
    200,
  );
  camera.position.set(0, 1.5, 2.5);
  camera.lookAt(0, 1.0, 0);
  cameraBasePos.copy(camera.position);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));  // cap for perf
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;  // cheapest shadow type
  // NOTE: tone mapping and color space are set by hdr.js loadEnvironment()
  document.getElementById("app").appendChild(renderer.domElement);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6);
  dirLight.position.set(3, 5, 2);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.width = 512;
  dirLight.shadow.mapSize.height = 512;
  scene.add(dirLight);

  // Subtle warm spot from above
  const spotLight = new THREE.SpotLight(0xffd6aa, 8);
  spotLight.position.set(0, 4, 0);
  spotLight.angle = Math.PI / 2.5;
  spotLight.penumbra = 0.8;
  spotLight.distance = 12;
  spotLight.castShadow = true;
  spotLight.shadow.radius = 4;
  spotLight.shadow.bias = -0.0001;
  spotLight.target.position.set(0, 0, 0);
  scene.add(spotLight.target);
  scene.add(spotLight);

  // Ground plane with subtle reflections — aligned with physics ground at y=0
  const groundGeo = new THREE.PlaneGeometry(40, 40);
  const groundMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a1a22,
    metalness: 0.1,
    roughness: 0.12,
    envMapIntensity: 0.6,
    transparent: true,
    opacity: 0.85,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  ground.receiveShadow = true;
  ground.name = '_ground';
  scene.add(ground);

  // Grid helper for spatial reference
  const grid = new THREE.GridHelper(10, 40, 0x333344, 0x222233);
  grid.position.y = 0.001;
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  scene.add(grid);

  window.addEventListener("resize", onWindowResize, false);
  setupControls(renderer.domElement);

  return {
    scene,
    camera,
    renderer,
    createCutout,
  };
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
