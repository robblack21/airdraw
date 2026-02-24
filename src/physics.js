import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

// Collision groups:
// Rings (group 1, bit 0x0001) only collide with GROUND (group 2, bit 0x0002)
// NOT with each other — they are threaded through each other's holes
const RING_MEMBER = 0x0001;
const RING_FILTER = 0x0002;   // only collide with ground
const GROUND_MEMBER = 0x0002;
const GROUND_FILTER = 0xFFFF; // collide with everything

export class PhysicsWorld {
  constructor() {
    this.world = null;
    this.bodies = new Map();
    this.joints = [];
    this.enabled = true;
    this.ringCount = 0;
    this.initialized = false;
  }

  async init() {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0.0, y: -9.81, z: 0.0 });
    this.initialized = true;

    const groundBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(50, 0.05, 50)
        .setRestitution(0.3)
        .setFriction(0.9)
        .setCollisionGroups((GROUND_MEMBER << 16) | GROUND_FILTER),
      groundBody
    );

    console.log('Rapier physics initialized');
  }

  setEnabled(e) { this.enabled = e; }

  setGravityEnabled(e) {
    if (!this.world) return;
    this.world.gravity = e ? { x: 0, y: -9.81, z: 0 } : { x: 0, y: 0, z: 0 };
  }

  addRing(strokeId, center, radius, meshRef, rotation, tubeRadius = 0.08, isFixed = false) {
    if (!this.initialized || !this.world) return null;

    const shouldFix = isFixed || this.ringCount === 0;
    this.ringCount++;

    const bodyDesc = shouldFix
      ? RAPIER.RigidBodyDesc.fixed()
          .setTranslation(center[0], center[1], center[2])
      : RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(center[0], center[1], center[2])
          .setLinearDamping(1.5)
          .setAngularDamping(1.5)
          .setCcdEnabled(true);

    if (rotation) {
      bodyDesc.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
    }

    const body = this.world.createRigidBody(bodyDesc);

    // Colliders in XY plane (matching TorusGeometry default)
    // Rings don't collide with each other — they thread through holes
    const ringGroup = (RING_MEMBER << 16) | RING_FILTER;
    const segments = 12;
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      this.world.createCollider(
        RAPIER.ColliderDesc.ball(tubeRadius)
          .setTranslation(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
          .setRestitution(0.0)
          .setFriction(0.3)
          .setDensity(5.0)
          .setCollisionGroups(ringGroup),
        body
      );
    }

    const entry = { body, center, radius, tubeRadius, meshRef, isFirst: shouldFix, isDemoTorus: !!rotation };
    this.bodies.set(strokeId, entry);

    if (!shouldFix) {
      this.tryLinkToNearest(strokeId, center, radius);
    }

    return body;
  }

  addPrimitive(strokeId, type, position, size, meshRef) {
    if (!this.initialized || !this.world) return null;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position[0], position[1], position[2])
      .setLinearDamping(0.5)
      .setAngularDamping(0.5);
    const body = this.world.createRigidBody(bodyDesc);

    let colliderDesc;
    const h = size / 2;
    switch (type) {
      case 'cube': colliderDesc = RAPIER.ColliderDesc.cuboid(h, h, h); break;
      case 'sphere': colliderDesc = RAPIER.ColliderDesc.ball(h); break;
      case 'cylinder': colliderDesc = RAPIER.ColliderDesc.cylinder(h, size/3); break;
      case 'torus': {
        for (let i = 0; i < 12; i++) {
          const a = (i/12)*Math.PI*2;
          this.world.createCollider(
            RAPIER.ColliderDesc.ball(size/6).setTranslation(Math.cos(a)*h, Math.sin(a)*h, 0)
              .setRestitution(0.3).setFriction(0.8),
            body
          );
        }
        colliderDesc = null;
        break;
      }
      default: colliderDesc = RAPIER.ColliderDesc.cuboid(h, h, h);
    }

    if (colliderDesc) {
      colliderDesc.setRestitution(0.3).setFriction(0.8).setDensity(2.0);
      this.world.createCollider(colliderDesc, body);
    }

    this.bodies.set(strokeId, { body, center: position, radius: h, tubeRadius: 0, meshRef, isFirst: false, isPrimitive: true });
    return body;
  }

  tryLinkToNearest(childId, childCenter, childRadius) {
    let nearestId = null, nearestDist = Infinity;

    // For demo rings, only link within same column (e.g. demo-ring-0-* links to demo-ring-0-*)
    const childColMatch = childId.match(/^demo-ring-(\d+)-/);
    const childCol = childColMatch ? childColMatch[1] : null;

    for (const [id, entry] of this.bodies) {
      if (id === childId || entry.isPrimitive) continue;

      // Column filtering: if child is a demo ring, only link to same column
      if (childCol) {
        const entryColMatch = id.match(/^demo-ring-(\d+)-/);
        if (entryColMatch && entryColMatch[1] !== childCol) continue;
      }

      const dx = entry.center[0]-childCenter[0], dy = entry.center[1]-childCenter[1], dz = entry.center[2]-childCenter[2];
      const dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (dist < (entry.radius+childRadius)*5 && dist < nearestDist) {
        nearestDist = dist;
        nearestId = id;
      }
    }

    if (nearestId) this.linkRings(nearestId, childId);
  }

  /**
   * Chain-link joint: constrains child ring within parent ring's hole.
   * The child hangs from a point on the INNER circle of the parent ring
   * (the bottom of the parent), and connects at the TOP of the child ring.
   * This simulates one ring threaded through another's hole.
   */
  linkRings(parentId, childId) {
    const parent = this.bodies.get(parentId);
    const child = this.bodies.get(childId);
    if (!parent || !child) return;

    try {
      // Parent anchor: bottom of ring's inner circle
      // In local XY space, bottom = (0, -radius, 0)
      // Use inner edge (subtract tubeRadius) for more realistic constraint
      const pAnchorY = -(parent.radius - parent.tubeRadius);
      // Child anchor: top of ring's inner circle
      const cAnchorY = (child.radius - child.tubeRadius);

      const jointData = RAPIER.JointData.spherical(
        { x: 0, y: pAnchorY, z: 0 },
        { x: 0, y: cAnchorY, z: 0 }
      );

      this.world.createImpulseJoint(jointData, parent.body, child.body, true);
      this.joints.push(jointData);
      console.log(`Chain-linked ${childId} through ${parentId}`);
    } catch (e) {
      console.warn('Joint failed:', e);
    }
  }

  step(dt) {
    if (!this.world || !this.enabled) return;
    this.world.timestep = Math.min(dt, 1/30);
    this.world.step();
  }

  // Sync ALL bodies to meshes (including fixed anchor)
  syncToMeshes(strokes) {
    if (!this.world || !this.enabled) return;

    for (const stroke of strokes) {
      if (!stroke.isRing && !stroke.isPrimitive) continue;
      const entry = this.bodies.get(stroke.id);
      if (!entry || !stroke.mesh) continue;

      const pos = entry.body.translation();
      const rot = entry.body.rotation();
      stroke.mesh.position.set(pos.x, pos.y, pos.z);
      stroke.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);

      if (stroke.isRing && stroke.center && !stroke.isDemoTorus && !stroke._geometryCentered) {
        const [cx, cy, cz] = stroke.center;
        stroke.mesh.geometry.translate(-cx, -cy, -cz);
        stroke._geometryCentered = true;
      }
    }
  }

  getState() {
    const state = [];
    for (const [id, entry] of this.bodies) {
      if (entry.isFirst) continue;
      const p = entry.body.translation(), r = entry.body.rotation();
      state.push({ id, pos: [p.x, p.y, p.z], rot: [r.x, r.y, r.z, r.w] });
    }
    return state;
  }

  applyState(stateArray) {
    for (const { id, pos, rot } of stateArray) {
      const entry = this.bodies.get(id);
      if (!entry || !entry.meshRef) continue;
      entry.meshRef.position.set(pos[0], pos[1], pos[2]);
      entry.meshRef.quaternion.set(rot[0], rot[1], rot[2], rot[3]);
    }
  }

  applyPalmForce(palmWorldPos, magnitude = 15.0) {
    if (!this.world || !this.enabled) return;
    for (const [, entry] of this.bodies) {
      if (entry.isFirst) continue;
      const p = entry.body.translation();
      const dx = p.x-palmWorldPos.x, dy = p.y-palmWorldPos.y, dz = p.z-palmWorldPos.z;
      const dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
      if (dist < 2.5 && dist > 0.01) {
        const f = magnitude * (1-dist/2.5) * (1-dist/2.5);
        entry.body.applyImpulse({ x: dx/dist*f, y: dy/dist*f, z: dz/dist*f }, true);
        entry.body.wakeUp();
      }
    }
  }

  removeRing(id) {
    const e = this.bodies.get(id);
    if (!e) return;
    this.world.removeRigidBody(e.body);
    this.bodies.delete(id);
  }

  clear() {
    for (const [, e] of this.bodies) this.world.removeRigidBody(e.body);
    this.bodies.clear();
    this.joints = [];
    this.ringCount = 0;
  }
}
