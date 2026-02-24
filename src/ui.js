import { toggleAudio, toggleVideo, getDevices, setInputDevice } from './video.js';
import { setHeadTrackingEnabled } from './scene.js';
import { setVisionHeadTracking, setVisionHandTracking } from './vision.js';
import { PALETTE, PALETTE_MATERIALS } from './drawing.js';

let drawerRef = null;
let physicsRef = null;
let syncRef = null;
let objControlsRef = null;
let quatBallRef = null;

export class CallUI {
  constructor(drawer, physics, sync, objControls, quatBall) {
    drawerRef = drawer;
    physicsRef = physics;
    syncRef = sync;
    objControlsRef = objControls || null;
    quatBallRef = quatBall || null;

    this.micBtn = document.getElementById('btn-mic');
    this.camBtn = document.getElementById('btn-cam');
    this.headBtn = document.getElementById('btn-head');
  this.handBtn = document.getElementById('btn-hand');
    this.settingsBtn = document.getElementById('btn-settings');
    this.settingsMenu = document.getElementById('settings-menu');
    this.audioSelect = document.getElementById('audio-select');
    this.videoSelect = document.getElementById('video-select');
    this.colorBtn = document.getElementById('btn-color');
    this.colorPreview = document.getElementById('color-preview');
    this.colorPalette = document.getElementById('color-palette');
    this.undoBtn = document.getElementById('btn-undo');
    this.clearBtn = document.getElementById('btn-clear');
    this.physicsBtn = document.getElementById('btn-physics');
    this.brushSizeInput = document.getElementById('brush-size');
    this.brushSizeVal = document.getElementById('brush-size-val');
    this.drawDepthInput = document.getElementById('draw-depth');
    this.drawDepthVal = document.getElementById('draw-depth-val');

    // New buttons
    this.gravityBtn = document.getElementById('btn-gravity');
    this.cubeBtn = document.getElementById('btn-cube');
    this.sphereBtn = document.getElementById('btn-sphere');
    this.cylinderBtn = document.getElementById('btn-cylinder');
    this.torusBtn = document.getElementById('btn-torus');
    this.sceneTreeBtn = document.getElementById('btn-scene-tree');
    this.sceneTreePanel = document.getElementById('scene-tree-panel');
    this.sceneTreeList = document.getElementById('scene-tree-list');
    this.quatBallBtn = document.getElementById('btn-quat-ball');

    this.isMicOn = true;
    this.isCamOn = true;
    this.isHeadTracking = false;
  this.isHandTracking = true;  // hand tracking on by default
    this.isSettingsOpen = false;
    this.isColorOpen = false;
    this.isPhysicsOn = true;
    this.isGravityOn = true;
    this.isSceneTreeOpen = false;
    this.selectedColor = PALETTE[0];

    this.buildColorPalette();
    this.setupListeners();

    // Head tracking off by default — dim the button
    if (this.headBtn) this.headBtn.style.opacity = '0.4';
  // Hand tracking on by default — bright

    // Refresh scene tree periodically
    this._sceneTreeInterval = null;
  }

  buildColorPalette() {
    if (!this.colorPalette) return;
    this.colorPalette.innerHTML = '';

    PALETTE.forEach((color, idx) => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch' + (idx === 0 ? ' selected' : '');
      swatch.style.background = color;
      swatch.dataset.color = color;

      swatch.addEventListener('click', () => {
        this.selectColor(color);
        this.colorPalette.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
      });

      this.colorPalette.appendChild(swatch);
    });
  }

  selectColor(hex) {
    this.selectedColor = hex;
    if (this.colorPreview) this.colorPreview.style.background = hex;
    if (drawerRef) drawerRef.setColor(hex);
  }

  _spawnPrimitive(type) {
    if (!drawerRef) return;
    // Spawn at camera look position (draw depth)
    const pos = drawerRef.screenToWorld(0.5, 0.5); // center of view
    const prim = drawerRef.addPrimitive(type, pos);
    if (prim && physicsRef) {
      physicsRef.addPrimitive(prim.id, type, prim.position, prim.scale, prim.mesh);
    }
    if (prim && syncRef) {
      syncRef.broadcast({
        type: 'primitive:create',
        primitiveType: type,
        position: prim.position,
        scale: prim.scale,
        color: prim.color
      });
    }
    // Select the new primitive
    if (objControlsRef && prim) {
      objControlsRef.select(prim.mesh);
    }
    this.refreshSceneTree();
  }

  refreshSceneTree() {
    if (!this.sceneTreeList || !drawerRef) return;
    this.sceneTreeList.innerHTML = '';

    const selected = objControlsRef ? objControlsRef.getSelectedStroke() : null;

    drawerRef.completedStrokes.forEach((stroke, idx) => {
      const item = document.createElement('div');
      item.className = 'scene-tree-item' + (selected && selected.id === stroke.id ? ' selected' : '');

      let icon = '✏️';
      let label = `Stroke ${idx + 1}`;
      if (stroke.isPrimitive) {
        const icons = { cube: '🔲', sphere: '🔵', cylinder: '🔷', torus: '🍩' };
        icon = icons[stroke.primitiveType] || '📦';
        label = stroke.primitiveType.charAt(0).toUpperCase() + stroke.primitiveType.slice(1) + ` ${idx + 1}`;
      } else if (stroke.isRing) {
        icon = '⭕';
        label = `Ring ${idx + 1}`;
      }

      // Get live transform from mesh
      const m = stroke.mesh;
      const p = m ? m.position : { x: 0, y: 0, z: 0 };
      const r = m ? m.rotation : { x: 0, y: 0, z: 0 };
      const s = m ? m.scale : { x: 1, y: 1, z: 1 };
      const fmt = (v) => v.toFixed(2);

      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="scene-tree-icon">${icon}</span>
          <span>${label}</span>
        </div>
        <div style="font-size:10px;color:#666;margin-left:22px;line-height:1.4;">
          P ${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)}<br>
          R ${fmt(r.x * 57.3)}° ${fmt(r.y * 57.3)}° ${fmt(r.z * 57.3)}°<br>
          S ${fmt(s.x)}
        </div>`;
      item.style.borderLeft = `3px solid ${stroke.color || '#888'}`;

      item.addEventListener('click', () => {
        if (objControlsRef && stroke.mesh) {
          objControlsRef.select(stroke.mesh);
          this.refreshSceneTree();
        }
      });

      this.sceneTreeList.appendChild(item);
    });

    if (drawerRef.completedStrokes.length === 0) {
      this.sceneTreeList.innerHTML = '<div style="font-size:11px;color:#666;padding:8px;">No objects yet</div>';
    }
  }

  setupListeners() {
    // Mic
    if (this.micBtn) {
      this.micBtn.addEventListener('click', () => {
        this.isMicOn = !this.isMicOn;
        toggleAudio(this.isMicOn);
        this.micBtn.style.opacity = this.isMicOn ? '1' : '0.4';
      });
    }

    // Cam
    if (this.camBtn) {
      this.camBtn.addEventListener('click', () => {
        this.isCamOn = !this.isCamOn;
        toggleVideo(this.isCamOn);
        this.camBtn.style.opacity = this.isCamOn ? '1' : '0.4';
      });
    }

    // Head Tracking
    if (this.headBtn) {
      this.headBtn.addEventListener('click', () => {
        this.isHeadTracking = !this.isHeadTracking;
        setHeadTrackingEnabled(this.isHeadTracking);
        setVisionHeadTracking(this.isHeadTracking);
        this.headBtn.style.opacity = this.isHeadTracking ? '1' : '0.4';
      });
    }

    // Hand Tracking
    if (this.handBtn) {
      this.handBtn.addEventListener('click', () => {
        this.isHandTracking = !this.isHandTracking;
        setVisionHandTracking(this.isHandTracking);
        this.handBtn.style.opacity = this.isHandTracking ? '1' : '0.4';
      });
    }

    // Color palette toggle
    if (this.colorBtn) {
      this.colorBtn.addEventListener('click', () => {
        this.isColorOpen = !this.isColorOpen;
        if (this.isColorOpen) {
          this.colorPalette.classList.remove('hidden');
          this.settingsMenu.classList.add('hidden');
          this.isSettingsOpen = false;
        } else {
          this.colorPalette.classList.add('hidden');
        }
      });
    }

    // Undo
    if (this.undoBtn) {
      this.undoBtn.addEventListener('click', () => {
        if (drawerRef) {
          const undoneId = drawerRef.undoLastStroke();
          if (undoneId && syncRef) {
            syncRef.broadcastUndo(undoneId);
            if (physicsRef) physicsRef.removeRing(undoneId);
          }
          this.refreshSceneTree();
        }
      });
    }

    // Clear
    if (this.clearBtn) {
      this.clearBtn.addEventListener('click', () => {
        if (drawerRef) drawerRef.clearAll();
        if (physicsRef) physicsRef.clear();
        if (syncRef) syncRef.broadcastClear();
        if (objControlsRef) objControlsRef.deselect();
        this.refreshSceneTree();
      });
    }

    // Physics toggle
    if (this.physicsBtn) {
      this.physicsBtn.addEventListener('click', () => {
        this.isPhysicsOn = !this.isPhysicsOn;
        if (physicsRef) physicsRef.setEnabled(this.isPhysicsOn);
        this.physicsBtn.style.opacity = this.isPhysicsOn ? '1' : '0.4';
      });
    }

    // Gravity toggle
    if (this.gravityBtn) {
      this.gravityBtn.addEventListener('click', () => {
        this.isGravityOn = !this.isGravityOn;
        if (physicsRef) physicsRef.setGravityEnabled(this.isGravityOn);
        this.gravityBtn.style.opacity = this.isGravityOn ? '1' : '0.4';
      });
    }

    // Primitive buttons
    if (this.cubeBtn) this.cubeBtn.addEventListener('click', () => this._spawnPrimitive('cube'));
    if (this.sphereBtn) this.sphereBtn.addEventListener('click', () => this._spawnPrimitive('sphere'));
    if (this.cylinderBtn) this.cylinderBtn.addEventListener('click', () => this._spawnPrimitive('cylinder'));
    if (this.torusBtn) this.torusBtn.addEventListener('click', () => this._spawnPrimitive('torus'));

    // Scene tree
    if (this.sceneTreeBtn) {
      this.sceneTreeBtn.addEventListener('click', () => {
        this.isSceneTreeOpen = !this.isSceneTreeOpen;
        if (this.isSceneTreeOpen) {
          this.sceneTreePanel.classList.remove('hidden');
          this.refreshSceneTree();
          // Auto-refresh while open
          this._sceneTreeInterval = setInterval(() => this.refreshSceneTree(), 1000);
        } else {
          this.sceneTreePanel.classList.add('hidden');
          if (this._sceneTreeInterval) {
            clearInterval(this._sceneTreeInterval);
            this._sceneTreeInterval = null;
          }
        }
      });
    }

    // Quat ball toggle
    if (this.quatBallBtn) {
      this.quatBallBtn.addEventListener('click', () => {
        if (!quatBallRef || !objControlsRef) return;
        const selected = objControlsRef.getSelectedMesh();
        if (!selected) {
          // No object selected — flash the button briefly
          this.quatBallBtn.style.background = 'rgba(255,80,80,0.3)';
          setTimeout(() => { this.quatBallBtn.style.background = ''; }, 400);
          return;
        }
        quatBallRef.toggle(selected);
      });
    }

    // Settings
    if (this.settingsBtn) {
      this.settingsBtn.addEventListener('click', async () => {
        this.isSettingsOpen = !this.isSettingsOpen;
        if (this.isSettingsOpen) {
          this.settingsMenu.classList.remove('hidden');
          this.colorPalette.classList.add('hidden');
          this.isColorOpen = false;
          await this.populateDevices();
        } else {
          this.settingsMenu.classList.add('hidden');
        }
      });
    }

    // Device Selection
    if (this.audioSelect) {
      this.audioSelect.addEventListener('change', (e) => {
        setInputDevice('audio', e.target.value);
      });
    }
    if (this.videoSelect) {
      this.videoSelect.addEventListener('change', (e) => {
        setInputDevice('video', e.target.value);
      });
    }

    // Brush size
    if (this.brushSizeInput) {
      this.brushSizeInput.addEventListener('input', () => {
        const val = parseInt(this.brushSizeInput.value);
        if (this.brushSizeVal) this.brushSizeVal.textContent = val;
        if (drawerRef) drawerRef.setBrushSize(val);
      });
    }

    // Draw depth
    if (this.drawDepthInput) {
      this.drawDepthInput.addEventListener('input', () => {
        const val = parseFloat(this.drawDepthInput.value);
        if (this.drawDepthVal) this.drawDepthVal.textContent = val.toFixed(1) + 'm';
        if (drawerRef) drawerRef.setDrawDepth(val);
      });
    }

    // Close menus on outside click
    document.addEventListener('click', (e) => {
      if (this.isColorOpen && this.colorPalette && !this.colorPalette.contains(e.target) && !this.colorBtn.contains(e.target)) {
        this.colorPalette.classList.add('hidden');
        this.isColorOpen = false;
      }
      if (this.isSettingsOpen && this.settingsMenu && !this.settingsMenu.contains(e.target) && !this.settingsBtn.contains(e.target)) {
        this.settingsMenu.classList.add('hidden');
        this.isSettingsOpen = false;
      }
    });
  }

  async populateDevices() {
    const devices = await getDevices();

    if (this.audioSelect) this.audioSelect.innerHTML = '';
    if (this.videoSelect) this.videoSelect.innerHTML = '';

    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.text = d.label || `${d.kind} (${d.deviceId.slice(0,5)}...)`;

      if (d.kind === 'audioinput' && this.audioSelect) {
        this.audioSelect.appendChild(opt);
      } else if (d.kind === 'videoinput' && this.videoSelect) {
        this.videoSelect.appendChild(opt);
      }
    });
  }
}

export function initUI(drawer, physics, sync, objControls, quatBall) {
  return new CallUI(drawer, physics, sync, objControls, quatBall);
}
