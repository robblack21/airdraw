import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

let baseEnvMap = null;
let webcamCanvas = null;
let webcamCtx = null;
let webcamTexture = null;
let webcamPlane = null;
let webcamPlaneBack = null;
let cubeCamera = null;
let cubeRenderTarget = null;
let reflectionScene = null;
let frameCounter = 0;
let webcamReflectionEnabled = false;

export function setWebcamReflectionEnabled(val) {
  webcamReflectionEnabled = val;
}

export async function loadEnvironment(scene, renderer) {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  // ── Colour pipeline ──────────────────────────────────────
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.8;

  const supportsP3 = window.matchMedia && window.matchMedia('(color-gamut: p3)').matches;
  if (supportsP3 && THREE.DisplayP3ColorSpace) {
    renderer.outputColorSpace = THREE.DisplayP3ColorSpace;
    console.log('Display-P3 wide gamut enabled');
  } else {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }

  try {
    const hdrLoader = new RGBELoader();
    const hdrTexture = await hdrLoader.loadAsync('/assets/environment.hdr');
    hdrTexture.mapping = THREE.EquirectangularReflectionMapping;

    const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;

    scene.environment = envMap;
    scene.background = envMap;
    scene.backgroundBlurriness = 0.04;
    scene.backgroundIntensity = 0.6;
    baseEnvMap = envMap;

    hdrTexture.dispose();
    pmremGenerator.dispose();

    console.log('HDR environment loaded (AgX tone mapping, exposure 1.8)');
  } catch (e) {
    console.warn('HDR env not found, using fallback:', e.message);

    const fallbackScene = new THREE.Scene();
    fallbackScene.add(new THREE.HemisphereLight(0x87ceeb, 0x362d1e, 1.0));
    const envMap = pmremGenerator.fromScene(fallbackScene).texture;
    scene.environment = envMap;
    scene.background = new THREE.Color(0x111118);
    baseEnvMap = envMap;
    pmremGenerator.dispose();
  }

  setupWebcamReflection();
}

/**
 * CubeCamera that composites webcam face into environment reflections.
 * Uses a CanvasTexture so we can paint from ANY video element at runtime.
 */
function setupWebcamReflection() {
  cubeRenderTarget = new THREE.WebGLCubeRenderTarget(128, {
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  cubeCamera = new THREE.CubeCamera(0.1, 100, cubeRenderTarget);

  // Build a small reflection scene: HDR background + webcam planes
  reflectionScene = new THREE.Scene();
  reflectionScene.background = baseEnvMap;

  // Canvas-based texture — paint from video each update
  webcamCanvas = document.createElement('canvas');
  webcamCanvas.width = 320;
  webcamCanvas.height = 240;
  webcamCtx = webcamCanvas.getContext('2d');
  // Fill black initially
  webcamCtx.fillStyle = '#000';
  webcamCtx.fillRect(0, 0, 320, 240);

  webcamTexture = new THREE.CanvasTexture(webcamCanvas);
  webcamTexture.minFilter = THREE.LinearFilter;
  webcamTexture.magFilter = THREE.LinearFilter;
  webcamTexture.colorSpace = THREE.SRGBColorSpace;

  const planeGeo = new THREE.PlaneGeometry(6, 4.5);
  const planeMat = new THREE.MeshBasicMaterial({
    map: webcamTexture,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,  // slightly more visible
  });

  // Front plane (facing camera)
  webcamPlane = new THREE.Mesh(planeGeo, planeMat);
  webcamPlane.position.set(0, 1.5, -6);
  reflectionScene.add(webcamPlane);

  // Back plane (behind camera)
  webcamPlaneBack = new THREE.Mesh(planeGeo, planeMat.clone());
  webcamPlaneBack.position.set(0, 1.5, 6);
  webcamPlaneBack.rotation.y = Math.PI;
  reflectionScene.add(webcamPlaneBack);

  // Side planes for wider reflection coverage
  const sidePlaneL = new THREE.Mesh(planeGeo.clone(), planeMat.clone());
  sidePlaneL.position.set(-6, 1.5, 0);
  sidePlaneL.rotation.y = Math.PI / 2;
  reflectionScene.add(sidePlaneL);

  const sidePlaneR = new THREE.Mesh(planeGeo.clone(), planeMat.clone());
  sidePlaneR.position.set(6, 1.5, 0);
  sidePlaneR.rotation.y = -Math.PI / 2;
  reflectionScene.add(sidePlaneR);

  reflectionScene.add(new THREE.AmbientLight(0xffffff, 1.0));
  console.log('Webcam reflection system ready (canvas-based, 4 planes)');
}

/**
 * Paint the webcam video frame onto the canvas texture then
 * render the CubeCamera to composite into environment.
 * Throttled to every 6th frame (~10fps at 60fps).
 */
export function updateWebcamReflection(videoEl, renderer, scene) {
  if (!cubeCamera || !cubeRenderTarget || !reflectionScene) return;

  // When disabled, restore the base HDR environment and skip
  if (!webcamReflectionEnabled) {
    if (baseEnvMap && scene.environment !== baseEnvMap) {
      scene.environment = baseEnvMap;
    }
    return;
  }

  frameCounter++;
  if (frameCounter % 6 !== 0) return;

  // Paint video onto canvas
  if (videoEl && videoEl.videoWidth > 0 && webcamCtx) {
    webcamCtx.drawImage(videoEl, 0, 0, webcamCanvas.width, webcamCanvas.height);
    webcamTexture.needsUpdate = true;
  }

  // Position CubeCamera at roughly the chain ring area
  cubeCamera.position.set(0, 1.5, -1.0);
  cubeCamera.update(renderer, reflectionScene);

  // Swap the scene environment to include webcam
  scene.environment = cubeRenderTarget.texture;
}
