// Multiplayer drawing sync over Daily.co app-messages
// High-frequency sync with lerped physics interpolation

import * as THREE from 'three';

let callObject = null;
let isHost = true;  // All clients are host by default; auto-demote on receiving physics:sync
let physicsSyncRAF = null;

// Peer camera poses for spatial presence
const peerPoses = new Map(); // peerId -> { pos: [x,y,z], rot: [x,y,z,w] }
let lastPoseBroadcast = 0;
const POSE_BROADCAST_INTERVAL = 100; // ms, ~10fps

export class DrawingSync {
  constructor() {
    // Remote physics lerp targets (for smooth interpolation)
    this._lerpTargets = new Map(); // id -> { pos: Vector3, rot: Quaternion }
    this._lerpAlpha = 0.25; // Interpolation speed (0-1, higher = snappier)
  }

  setCallObject(co) {
    callObject = co;
  }

  setHost(host) {
    isHost = host;
    console.log(`[Sync] Host role: ${host}`);
  }

  getIsHost() {
    return isHost;
  }

  // Send a drawing event to remote players
  broadcast(eventData) {
    if (!callObject) return;
    try {
      callObject.sendAppMessage(eventData);
    } catch (e) {
      // Silently fail — Daily.co rate limits at ~60 msg/s
    }
  }

  // Broadcast stroke start — includes color and radius so remote can preview correctly
  broadcastStrokeStart(strokeId, color, radius) {
    this.broadcast({
      type: 'stroke:start',
      id: strokeId,
      color,
      radius
    });
  }

  // Broadcast a new stroke point — includes color + depth (draw distance) per point
  broadcastStrokePoint(strokeId, point, color, radius) {
    this.broadcast({
      type: 'stroke:point',
      id: strokeId,
      point,
      color,
      radius
    });
  }

  // Broadcast completed stroke with full data
  broadcastStrokeComplete(strokeData) {
    this.broadcast({
      type: 'stroke:complete',
      ...strokeData
    });
  }

  broadcastStrokeCancel(strokeId) {
    this.broadcast({ type: 'stroke:cancel', id: strokeId });
  }

  broadcastUndo(strokeId) {
    this.broadcast({ type: 'stroke:undo', id: strokeId });
  }

  broadcastClear() {
    this.broadcast({ type: 'stroke:clear' });
  }

  // Broadcast local camera position + rotation (~10fps throttled)
  broadcastUserPose(position, rotation) {
    const now = performance.now();
    if (now - lastPoseBroadcast < POSE_BROADCAST_INTERVAL) return;
    lastPoseBroadcast = now;
    this.broadcast({
      type: 'user:pose',
      pos: [position.x, position.y, position.z],
      rot: [rotation.x, rotation.y, rotation.z, rotation.w]
    });
  }

  getPeerPoses() {
    return peerPoses;
  }

  removePeer(peerId) {
    peerPoses.delete(peerId);
  }

  // Broadcast a toggle state change (physics, gravity, etc.)
  broadcastToggle(toggleType, enabled) {
    this.broadcast({ type: `toggle:${toggleType}`, enabled });
  }

  // High-frequency physics sync using rAF (aims for 60fps)
  startPhysicsSync(physicsWorld) {
    this.stopPhysicsSync();

    let lastSyncTime = 0;
    const SYNC_INTERVAL = 33; // ~30fps for network efficiency

    const syncLoop = (time) => {
      physicsSyncRAF = requestAnimationFrame(syncLoop);

      if (time - lastSyncTime < SYNC_INTERVAL) return;
      lastSyncTime = time;

      if (!isHost || !physicsWorld.enabled) return;
      const state = physicsWorld.getState();
      if (state.length === 0) return;

      this.broadcast({
        type: 'physics:sync',
        bodies: state,
        t: time // timestamp for potential extrapolation
      });
    };

    physicsSyncRAF = requestAnimationFrame(syncLoop);
  }

  stopPhysicsSync() {
    if (physicsSyncRAF) {
      cancelAnimationFrame(physicsSyncRAF);
      physicsSyncRAF = null;
    }
  }

  // Interpolate remote physics bodies toward their target transforms (call every frame)
  lerpPhysicsBodies(physicsWorld) {
    if (isHost || this._lerpTargets.size === 0) return;

    for (const [id, target] of this._lerpTargets) {
      const entry = physicsWorld.bodies.get(id);
      if (!entry || !entry.meshRef) continue;

      // Lerp position
      entry.meshRef.position.lerp(target.pos, this._lerpAlpha);
      // Slerp rotation
      entry.meshRef.quaternion.slerp(target.rot, this._lerpAlpha);
    }
  }

  // Handle incoming app-message from Daily.co
  handleMessage(data, drawer, physics, fromId) {
    if (!data || !data.type) return;

    switch (data.type) {
      case 'stroke:start':
        // Nothing visual yet — just marks that remote started
        break;

      case 'stroke:point':
        if (drawer) {
          drawer.updateRemoteActiveStroke(data.id, data.point, data.color, data.radius);
        }
        break;

      case 'stroke:complete':
        if (drawer) {
          drawer.cancelRemoteActiveStroke(data.id);
          const stroke = drawer.addRemoteStroke(data);

          if (data.isRing && physics && stroke) {
            if (stroke.mesh) stroke.mesh.userData._physId = data.id;
            physics.addRing(data.id, data.center, data.radius, stroke.mesh);
          }
        }
        break;

      case 'stroke:cancel':
        if (drawer) {
          drawer.cancelRemoteActiveStroke(data.id);
        }
        break;

      case 'stroke:undo':
        if (drawer && data.id) {
          drawer.removeStrokeById(data.id);
          if (physics) physics.removeRing(data.id);
        }
        break;

      case 'stroke:clear':
        if (drawer) drawer.clearAll();
        if (physics) physics.clear();
        this._lerpTargets.clear();
        break;

      case 'physics:sync':
        // First time receiving physics:sync from another client = we're not host
        if (isHost && data.bodies) {
          console.log('[Sync] Received physics from another host — deferring. Stopping local physics broadcast.');
          isHost = false;
        }
        if (!isHost && data.bodies) {
          // Store lerp targets instead of snapping
          for (const body of data.bodies) {
            let target = this._lerpTargets.get(body.id);
            if (!target) {
              target = {
                pos: new THREE.Vector3(body.pos[0], body.pos[1], body.pos[2]),
                rot: new THREE.Quaternion(body.rot[0], body.rot[1], body.rot[2], body.rot[3])
              };
              this._lerpTargets.set(body.id, target);
            } else {
              target.pos.set(body.pos[0], body.pos[1], body.pos[2]);
              target.rot.set(body.rot[0], body.rot[1], body.rot[2], body.rot[3]);
            }
          }
        }
        break;

      case 'primitive:create':
        if (drawer) {
          const prim = drawer.addPrimitive(data.primitiveType, new THREE.Vector3(data.position[0], data.position[1], data.position[2]), data.scale);
          if (prim && physics) {
            physics.addPrimitive(prim.id, data.primitiveType, data.position, data.scale, prim.mesh);
          }
        }
        break;

      case 'object:transform':
        if (drawer && data.id) {
          const stroke = drawer.completedStrokes.find(s => s.id === data.id);
          if (stroke && stroke.mesh) {
            stroke.mesh.position.set(data.pos[0], data.pos[1], data.pos[2]);
            stroke.mesh.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
            if (data.scale) stroke.mesh.scale.set(data.scale[0], data.scale[1], data.scale[2]);
          }
        }
        break;
      case 'toggle:physics':
        if (physics) physics.setEnabled(data.enabled);
        break;

      case 'toggle:gravity':
        if (physics) physics.setGravityEnabled(data.enabled);
        break;

      case 'user:pose':
        if (data.pos && data.rot && fromId) {
          peerPoses.set(fromId, { pos: data.pos, rot: data.rot });
        }
        break;
    }
  }
}
