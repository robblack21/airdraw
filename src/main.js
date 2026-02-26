import * as THREE from 'three';
import { initScene, animateScene, updateCameraPose, scene, camera, renderer,
         createPeerDisc, removePeerDisc, updatePeerDiscPose, updatePeerDiscsBillboard } from './scene.js';
import { initVision, updateVision, trackingState } from './vision.js';
import { initUI } from './ui.js';
import { StrokeRecorder } from './drawing.js';
import { PhysicsWorld } from './physics.js';
import { DrawingSync } from './sync.js';
import { loadEnvironment, updateWebcamReflection } from './hdr.js';
import { ObjectControls } from './objectControls.js';
import { QuatBall } from './quatBall.js';
import { buildDemoScene } from './demoScene.js';
import { initVideo, getCallObject } from './video.js';

const loadingUi = document.getElementById('loading');
const loadingDetails = document.getElementById('loading-details');
const startBtn = document.getElementById('start-btn');
const drawIndicator = document.getElementById('draw-indicator');

// ---------- 3D Hand Cursor in scene (supports 2 hands) ----------
const MAX_HANDS = 2;
let handCursors = [];  // array of { group, sphere, line, glowRing }

function init3DHandCursor(sceneRef) {
  for (let i = 0; i < MAX_HANDS; i++) {
    const group = new THREE.Group();
    group.name = `_handCursor_${i}`;

    const sphereGeo = new THREE.SphereGeometry(0.015, 16, 16);
    const sphereMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    group.add(sphere);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0,0,0), new THREE.Vector3(0,0,0)
    ]);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.6,
      depthTest: false
    });
    const line = new THREE.Line(lineGeo, lineMat);
    group.add(line);

    const ringGeo = new THREE.RingGeometry(0.02, 0.028, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      depthTest: false
    });
    const glowRing = new THREE.Mesh(ringGeo, ringMat);
    glowRing.name = '_glowRing';
    group.add(glowRing);

    group.visible = false;
    sceneRef.add(group);
    handCursors.push({ group, sphere, line, glowRing });
  }
}

function update3DHandCursor(cameraRef, drawerRef) {
  const hands = trackingState.handLandmarks;

  for (let i = 0; i < MAX_HANDS; i++) {
    const cursor = handCursors[i];
    if (!cursor) continue;

    if (!hands || !hands[i] || hands[i].length < 21) {
      cursor.group.visible = false;
      continue;
    }

    cursor.group.visible = true;
    const hand = hands[i];
    const thumbTip = hand[4];
    const indexTip = hand[8];

    // Pinch midpoint — use Raw version to avoid polluting drawing EMA state
    const midX = (thumbTip.x + indexTip.x) / 2;
    const midY = (thumbTip.y + indexTip.y) / 2;
    const midWorld = drawerRef.screenToWorldRaw(midX, midY);
    cursor.sphere.position.copy(midWorld);

    // Thumb/index lines
    const thumbWorld = screenToWorld3D(thumbTip.x, thumbTip.y, cameraRef, drawerRef.drawDepth);
    const indexWorld = screenToWorld3D(indexTip.x, indexTip.y, cameraRef, drawerRef.drawDepth);
    const positions = cursor.line.geometry.attributes.position;
    positions.setXYZ(0, thumbWorld.x, thumbWorld.y, thumbWorld.z);
    positions.setXYZ(1, indexWorld.x, indexWorld.y, indexWorld.z);
    positions.needsUpdate = true;

    // Glow ring
    cursor.glowRing.position.copy(midWorld);
    cursor.glowRing.lookAt(cameraRef.position);

    // Pinch detection per hand
    const dx = thumbTip.x - indexTip.x;
    const dy = thumbTip.y - indexTip.y;
    const isPinched = Math.sqrt(dx*dx + dy*dy) < 0.05;
    const color = isPinched ? 0xff4444 : 0x00ff88;
    cursor.sphere.material.color.setHex(color);
    cursor.line.material.color.setHex(color);
    cursor.glowRing.material.color.setHex(color);
    cursor.sphere.scale.setScalar(isPinched ? 1.5 : 1.0);
  }
}

function screenToWorld3D(nx, ny, cam, depth) {
  const ndc = new THREE.Vector3(
    (1 - nx) * 2 - 1,
    -(ny * 2 - 1),
    0.5
  );
  ndc.unproject(cam);
  const dir = ndc.sub(cam.position).normalize();
  return cam.position.clone().add(dir.multiplyScalar(depth));
}

// ---------- Physics mouse/touch drag interaction ----------
let raycaster, mouse;
let isDragging = false;
let dragBody = null;
let dragPlane = null;

function initDragInteraction(physicsWorld, sceneRef, cameraRef, rendererRef) {
  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  const dom = rendererRef.domElement;

  dom.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, cameraRef);

    const allMeshes = [];
    for (const [id, entry] of physicsWorld.bodies) {
      if (entry.meshRef) allMeshes.push(entry.meshRef);
    }
    if (allMeshes.length === 0) return;

    const intersects = raycaster.intersectObjects(allMeshes, true);
    if (intersects.length > 0) {
      isDragging = true;
      dom.style.cursor = 'grabbing';

      let hitObj = intersects[0].object;
      while (hitObj && !hitObj.userData._physId) hitObj = hitObj.parent;

      for (const [id, entry] of physicsWorld.bodies) {
        if (entry.meshRef === hitObj || entry.meshRef === intersects[0].object) {
          dragBody = { id, entry };
          break;
        }
      }

      if (!dragBody) { isDragging = false; return; }

      const hitPoint = intersects[0].point;
      const camDir = new THREE.Vector3();
      cameraRef.getWorldDirection(camDir);
      dragPlane.setFromNormalAndCoplanarPoint(camDir.negate(), hitPoint);
    }
  });

  dom.addEventListener('pointermove', (e) => {
    if (!isDragging || !dragBody) return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, cameraRef);

    const target = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, target);
    if (target && dragBody.entry.body) {
      const pos = dragBody.entry.body.translation();
      const dx = target.x - pos.x;
      const dy = target.y - pos.y;
      const dz = target.z - pos.z;
      dragBody.entry.body.applyImpulse({ x: dx * 2.0, y: dy * 2.0, z: dz * 2.0 }, true);
      dragBody.entry.body.wakeUp();
    }
  });

  const endDrag = () => { isDragging = false; dragBody = null; dom.style.cursor = ''; };
  dom.addEventListener('pointerup', endDrag);
  dom.addEventListener('pointerleave', endDrag);
}

// ---------- Main ----------
async function main() {
  try {
    loadingDetails.textContent = 'Initializing Scene...';

    // 1. Scene
    const sceneCtx = await initScene();
    const urlParams = new URLSearchParams(window.location.search);
    const role = urlParams.get('role') || 'w';
    updateCameraPose(role);

    // 2. HDR Environment
    loadingDetails.textContent = 'Loading Environment...';
    await loadEnvironment(sceneCtx.scene, sceneCtx.renderer);

    // 3. Physics
    loadingDetails.textContent = 'Initializing Physics...';
    const physics = new PhysicsWorld();
    await physics.init();

    // 4. Drawing System
    const drawer = new StrokeRecorder(sceneCtx.scene, sceneCtx.camera);

    // 5. Sync (local-only)
    const sync = new DrawingSync();

    // 6. Object Controls
    const objControls = new ObjectControls(
      sceneCtx.renderer.domElement, sceneCtx.camera, sceneCtx.scene, drawer, physics, sync
    );

    // 7. Quaternion Ball
    const quatBall = new QuatBall(
      sceneCtx.renderer.domElement, sceneCtx.camera, sceneCtx.scene
    );

    // 8. UI
    initUI(drawer, physics, sync, objControls, quatBall);

    // 9. Build demo scene — 3 interlocked rings
    loadingDetails.textContent = 'Building demo scene...';
    buildDemoScene(sceneCtx.scene, physics, drawer);

    // Start physics sync broadcast (host will broadcast, non-host will receive)
    sync.startPhysicsSync(physics);

    // 10. 3D Hand cursor
    init3DHandCursor(sceneCtx.scene);

    // Ready
    loadingDetails.textContent = 'Ready!';
    startBtn.classList.add('hidden');

    window.app = {
      scene: sceneCtx.scene, camera: sceneCtx.camera,
      drawer, physics, sync, objControls, quatBall
    };

    const autoJoin = async () => {
      loadingDetails.textContent = 'Loading hand tracking...';

      try {
        // Start webcam
        const videoEl = document.getElementById('video');
        if (videoEl && !videoEl.srcObject) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
              audio: false
            });
            videoEl.srcObject = stream;
            await videoEl.play();
          } catch (e) { console.warn('Could not start webcam:', e); }
        }

        // Init Vision (hand tracking only — face deferred)
        try {
          await initVision(sceneCtx);
        } catch (e) { console.error('Vision init failed:', e); }

        // Init drag interaction
        initDragInteraction(physics, sceneCtx.scene, sceneCtx.camera, sceneCtx.renderer);

        // Initialize Daily.co video call for multiplayer
        try {
          await initVideo({
            onRemoteVideo: (videoEl, peerId) => {
              createPeerDisc(videoEl, peerId);
            },
            onAppMessage: (data, fromId) => {
              sync.handleMessage(data, drawer, physics, fromId);
            },
            onParticipantLeft: (peerId) => {
              removePeerDisc(peerId);
              sync.removePeer(peerId);
            }
          });

          // Connect sync to Daily call object
          const co = getCallObject();
          if (co) sync.setCallObject(co);
        } catch (e) {
          console.warn('Video call init failed (running in local mode):', e);
        }

        loadingUi.classList.add('hidden');

        // Cache DOM lookups + reuse objects for zero-alloc render loop
        const cachedVideoEl = document.getElementById('video');
        const _tmpQuat = new THREE.Quaternion();
        const _tmpFwd = new THREE.Vector3();

        // Main loop
        let lastTime = 0;
        let frameCount = 0;
        function loop(time) {
          const dt = lastTime > 0 ? (time - lastTime) / 1000 : 1/60;
          lastTime = time;
          frameCount++;

          // Vision
          updateVision();

          // 3D hand cursor
          update3DHandCursor(sceneCtx.camera, drawer);

          // --- Open palm detection + ring highlight + push ---
          if (trackingState.handLandmarks && trackingState.handLandmarks.length > 0) {
            const hand = trackingState.handLandmarks[0];

            // Detect open palm: all 4 fingers extended (tips above MCPs in screen y)
            // Note: don't require !isPinched — thumb position varies with open palm
            const isOpenPalm = hand.length >= 21 &&
              hand[8].y < hand[6].y &&   // index extended
              hand[12].y < hand[10].y &&  // middle extended
              hand[16].y < hand[14].y &&  // ring extended
              hand[20].y < hand[18].y;    // pinky extended

            // Palm center: midpoint between wrist (0) and middle finger MCP (9)
            const palmCenterX = (hand[0].x + hand[9].x) / 2;
            const palmCenterY = (hand[0].y + hand[9].y) / 2;
            const handWorldPos = drawer.screenToWorldRaw(palmCenterX, palmCenterY);

            // Palm scale: distance from wrist (0) to middle fingertip (12) in NDC
            const palmDx = hand[12].x - hand[0].x;
            const palmDy = hand[12].y - hand[0].y;
            const palmScale = Math.sqrt(palmDx * palmDx + palmDy * palmDy);

            // Find nearest ring/object to hand
            let nearestStroke = null;
            let nearestDist = Infinity;
            if (handWorldPos) {
              for (const stroke of drawer.completedStrokes) {
                if (!stroke.mesh) continue;
                const d = stroke.mesh.position.distanceTo(handWorldPos);
                if (d < nearestDist) {
                  nearestDist = d;
                  nearestStroke = stroke;
                }
              }
            }

            // Debug gesture state (throttled — every 5 seconds)
            if (frameCount % 300 === 0) {
              console.log(`[Gesture] open=${isOpenPalm} scale=${palmScale.toFixed(3)} nearest=${nearestDist.toFixed(2)}m`);
            }

            // Highlight nearest ring within range
            const highlightRange = 1.5;
            for (const stroke of drawer.completedStrokes) {
              if (!stroke.mesh || !stroke.mesh.material) continue;
              if (stroke === nearestStroke && nearestDist < highlightRange) {
                stroke.mesh.material.emissive = stroke.mesh.material.emissive || new THREE.Color();
                stroke.mesh.material.emissive.setHex(0xffaa00);
                stroke.mesh.material.emissiveIntensity = 0.4;
              } else {
                if (stroke.mesh.material.emissive) {
                  stroke.mesh.material.emissive.setHex(0x000000);
                  stroke.mesh.material.emissiveIntensity = 0;
                }
              }
            }

            // Apply push force with open palm — magnitude scales with palm size
            if (isOpenPalm && handWorldPos) {
              const pushMagnitude = Math.max(2.0, palmScale * 80);
              physics.applyPalmForce(handWorldPos, pushMagnitude);
              if (drawIndicator) {
                drawIndicator.classList.add('active');
                drawIndicator.textContent = '🖐 Push';
              }
            }
          } else {
            // No hand — clear all highlights
            for (const stroke of drawer.completedStrokes) {
              if (stroke.mesh && stroke.mesh.material && stroke.mesh.material.emissive) {
                stroke.mesh.material.emissive.setHex(0x000000);
                stroke.mesh.material.emissiveIntensity = 0;
              }
            }
          }

          // Drawing from hand tracking
          const drawEvent = drawer.update(trackingState.handInteraction);

          // Handle drawing events
          if (drawEvent && sync) {
            switch (drawEvent.type) {
              case 'stroke:start':
                sync.broadcastStrokeStart(drawEvent.data.id, drawEvent.data.color, drawEvent.data.radius);
                break;
              case 'stroke:point':
                sync.broadcastStrokePoint(drawEvent.data.id, drawEvent.data.point, drawer.colorHex, drawer.tubeRadius);
                break;
              case 'stroke:complete':
                sync.broadcastStrokeComplete(drawEvent.data);
                if (drawEvent.data.isRing) {
                  const strokeMesh = drawer.completedStrokes.find(s => s.id === drawEvent.data.id)?.mesh;
                  if (strokeMesh) strokeMesh.userData._physId = drawEvent.data.id;
                  physics.addRing(drawEvent.data.id, drawEvent.data.center, drawEvent.data.radius, strokeMesh);
                }
                break;
              case 'stroke:cancel':
                sync.broadcastStrokeCancel(drawEvent.data.id);
                break;
            }
          }

          // Object controls
          objControls.update(dt);
          quatBall.update(dt);

          // Physics step — host runs simulation, non-host lerps from host state
          if (sync.getIsHost()) {
            physics.step(dt);
            physics.syncToMeshes(drawer.completedStrokes);
          } else {
            // Non-host: interpolate meshes to positions received from host
            sync.lerpPhysicsBodies(physics);
          }

          // Broadcast local camera pose to peers (~10fps, throttled in sync)
          sync.broadcastUserPose(sceneCtx.camera.position, sceneCtx.camera.quaternion);

          // Update peer disc positions from synced poses (reuse objects)
          const peerPoses = sync.getPeerPoses();
          for (const [peerId, pose] of peerPoses) {
            _tmpQuat.set(pose.rot[0], pose.rot[1], pose.rot[2], pose.rot[3]);
            _tmpFwd.set(0, 0, -1).applyQuaternion(_tmpQuat);
            const discPos = [
              pose.pos[0] + _tmpFwd.x * 0.5,
              pose.pos[1] - 0.3 + _tmpFwd.y * 0.5,
              pose.pos[2] + _tmpFwd.z * 0.5
            ];
            updatePeerDiscPose(peerId, discPos, pose.rot);
          }

          // Billboard peer discs to always face local camera
          updatePeerDiscsBillboard();

          // Webcam reflections (throttled internally)
          if (cachedVideoEl) updateWebcamReflection(cachedVideoEl, sceneCtx.renderer, sceneCtx.scene);

          // Render
          animateScene(time);
          requestAnimationFrame(loop);
        }

        requestAnimationFrame(loop);

      } catch (e) {
        console.error('Setup failed:', e);
        loadingDetails.textContent = 'Error: ' + e.message;
        startBtn.classList.remove('hidden');
        startBtn.textContent = 'Retry';
        startBtn.onclick = autoJoin;
      }
    };

    autoJoin();

  } catch (err) {
    loadingDetails.textContent = 'Fatal Error: ' + err.message;
    console.error(err);
  }
}

main();
