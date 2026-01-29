import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { SplatLoader, SplatMesh } from '@sparkjsdev/spark'; 
// const SplatLoader = class {}; const SplatMesh = class {}; 
import { trackingState } from './vision.js'; 

export let scene, camera, renderer;
let clock;
let boardGroup = new THREE.Group();
let piecesGroup = new THREE.Group();
let interactables = []; 

let initialCameraPos = new THREE.Vector3(0, 1.2, 0.8); 
let initialCameraLookAt = new THREE.Vector3(0, 0.4, 0);

// Volumetric State
let volumetricSplats = null; 
let envSplat = null; // New global for tuning 
let cutoutTexture = null;

const loader = new GLTFLoader();
const splatLoader = new SplatLoader();

let currentRole = 'w'; 

// --- Interaction Visuals ---
const highlightGroup = new THREE.Group();
highlightGroup.renderOrder = 2000; // Debug: Ensure drawn on top
// Debug: disable depthTest to ensure visibility even if inside board/floor
const highlightMaterial = new THREE.MeshBasicMaterial({ 
    color: 0xffff00, 
    transparent: true, 
    opacity: 0.6, 
    side: THREE.DoubleSide,
    depthTest: false 
});
const highlightGeom = new THREE.PlaneGeometry(0.05, 0.05);
highlightGeom.rotateX(-Math.PI/2);

// Create Volumetric Video as Dynamic Gaussian Splats (Instanced Quads)
export function createCutout(videoElement) {
    if (volumetricSplats) {
        if (cutoutTexture.map.image !== videoElement) {
            cutoutTexture.map.image = videoElement;
            cutoutTexture.map.needsUpdate = true;
        }
        return;
    }
    
    // 1. Setup Instanced Geometry (Quads)
    const width = 252;
    const height = 252;
    const instanceCount = width * height;
    
    // Base geometry: Simple Quad centered at 0,0
    const baseGeometry = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = baseGeometry.index;
    geometry.attributes.position = baseGeometry.attributes.position;
    geometry.attributes.uv = baseGeometry.attributes.uv;
    geometry.instanceCount = instanceCount;

    // 2. Texture
    const texture = new THREE.VideoTexture(videoElement);
    texture.format = THREE.RGBAFormat;
    texture.colorSpace = THREE.SRGBColorSpace; 
    
    cutoutTexture = { map: texture }; 

    // 3. Gaussian Splat Shader
    const material = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: texture },
            depthScale: { value: 0.5 }, 
            minDepth: { value: 0.0 },
            maxDepth: { value: 0.5 },
            splatScale: { value: 0.015 }, 
            unprojectScale: { value: 1.15 },
            aspectRatio: { value: 1.0 }   
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
                
                // 1. Calculate specific pixel UV from Instance ID
                float gridX = mod(float(gl_InstanceID), width);
                float gridY = floor(float(gl_InstanceID) / width);
                
                // Image Y is flipped usually in Texture vs Geom
                vec2 gridUv = vec2((gridX + 0.5) / width, (gridY + 0.5) / height);
                vImgUv = gridUv;
                
                // 2. Sample Depth (Right Half)
                // Map Layout: [RGB | Depth]
                vec2 depthUv = vec2(gridUv.x * 0.5 + 0.5, gridUv.y);
                float d = texture2D(map, depthUv).r;
                vDepth = d;
                
                // 3. Unproject 
                // Center 0,0
                float x = ((gridX / width) - 0.5) * unprojectScale;
                float y = ((gridY / height) - 0.5) * unprojectScale;
                
                vec3 centerPos = vec3(x, y, 0.0);
                centerPos.z += d * depthScale;
                
                // 4. Billboarding & Scale
                vec4 mvPosition = modelViewMatrix * vec4(centerPos, 1.0);
                vec2 scale = vec2(splatScale);
                mvPosition.xy += position.xy * scale; // Instanced Billboard
                
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
                // 1. Culling
                if (vDepth < minDepth || vDepth > maxDepth) discard;
                
                // 2. Gaussian Shape (Soft Circle)
                vec2 center = vUv - 0.5;
                float distSq = dot(center, center);
                float alpha = exp(-distSq * 10.0); 
                
                if (alpha < 0.01) discard;
                
                // 3. Color (Left Half)
                vec2 colorUv = vec2(vImgUv.x * 0.5, vImgUv.y);
                vec4 color = texture2D(map, colorUv);
                
                gl_FragColor = vec4(color.rgb, alpha);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide
    });
    
    volumetricSplats = new THREE.InstancedMesh(geometry, material, instanceCount);
    volumetricSplats.frustumCulled = false;
    volumetricSplats.renderOrder = 999;
    
    scene.add(volumetricSplats);
    updateVolumetricPose();
}

const _volUp = new THREE.Vector3(0, 1, 0); // Optimization

function updateVolumetricPose() {
    if (!volumetricSplats) return;
    
    // Transform to sit on chair
    // Move closer (was 1.2) to be in front of chair backrest
    const dist = 0.55; 
    const height = 0.95;
    
    // Reduce scale (was 1.5) to avoid giant head
    volumetricSplats.scale.set(0.65, 0.65, 0.65); 
    
    if (currentRole === 'w') {
        volumetricSplats.position.set(0, height, -dist);
        volumetricSplats.lookAt(0, height, dist); 
    } else if (currentRole === 'b') {
        volumetricSplats.position.set(0, height, dist);
        volumetricSplats.lookAt(0, height, -dist); 
    }
    // Rotate 180 as requested
    volumetricSplats.rotation.y += Math.PI;
}

export function highlightSquares(squares) {
    highlightGroup.clear();
    if (!squares || squares.length === 0) return;
    
    // Board config
    const squareSize = 0.05996; // Same as updateBoard
    
    squares.forEach(sq => {
        // Parse 'e4'
        const file = sq.charCodeAt(0) - 97; // 'a'->0
        const rank = parseInt(sq[1]) - 1;   // '1'->0
        
        const mesh = new THREE.Mesh(highlightGeom, highlightMaterial);
        
        // updateBoard Logic:
        // rowIndex 0 (Rank 8) -> z = -3.5 * size.
        // rowIndex 7 (Rank 1) -> z = 3.5 * size.
        
        // Input: 'e4'. Rank 3.
        // rowIndex = 7 - 3 = 4.
        // z = (4 - 3.5) * size.
        
        const rowIndex = 7 - rank;
        const colIndex = file;
        
        const x = (colIndex - 3.5) * squareSize;
        const z = (rowIndex - 3.5) * squareSize;
        
        mesh.position.set(x, 0.002, z); 
        highlightGroup.add(mesh);
    });
}

export function setPieceGlow(mesh, active) {
    if (!mesh) return;
    mesh.traverse(c => {
        if (c.isMesh) {
            if (active) {
                if (c.userData.oldEmissive === undefined) {
                    c.userData.oldEmissive = c.material.emissive ? c.material.emissive.getHex() : 0;
                    c.userData.oldIntensity = c.material.emissiveIntensity || 0;
                }
                c.material.emissive = new THREE.Color(0xffaa00);
                c.material.emissiveIntensity = 0.5;
            } else {
                if (c.userData.oldEmissive !== undefined) {
                    c.material.emissive.setHex(c.userData.oldEmissive);
                    c.material.emissiveIntensity = c.userData.oldIntensity;
                } else {
                    c.material.emissive.setHex(0);
                    c.material.emissiveIntensity = 0;
                }
            }
        }
    });
}

export function setDepthThresholds(min, max) {
    if (volumetricSplats && volumetricSplats.material) {
        volumetricSplats.material.uniforms.minDepth.value = min;
        volumetricSplats.material.uniforms.maxDepth.value = max;
    }
}

// Control State
const keys = { 
    w:false, a:false, s:false, d:false, q:false, e:false,
    i:false, j:false, k:false, l:false 
};
const moveSpeed = 2.0; 
const rotSpeed = 1.5; // Radians per second
let isRightClicking = false;
let lastMouseX = 0;
let lastMouseY = 0;

export function setupControls(dom) {
    if (!dom) return;
    // Keyboard
    window.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if (keys.hasOwnProperty(k)) keys[k] = true;
    });
    window.addEventListener('keyup', (e) => {
        const k = e.key.toLowerCase();
        if (keys.hasOwnProperty(k)) keys[k] = false;
    });
    
    // Zoom (Wheel) -> Splat Scale
    dom.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (activeSplat) {
            const scaleSpeed = 0.001;
            const delta = -e.deltaY * scaleSpeed;
            const newScale = Math.max(0.01, activeSplat.scale.x + delta);
            activeSplat.scale.set(newScale, newScale, newScale);
            console.log("Splat Scale:", newScale.toFixed(4));
        }
    }, { passive: false });
    
    // Toggle Active Splat (T key)
    window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 't') {
            if (activeSplat === splatWhite) {
                activeSplat = splatBlack;
                console.log("Tuning: BLACK Splat");
            } else {
                activeSplat = splatWhite;
                console.log("Tuning: WHITE Splat");
            }
        }
    });

    dom.addEventListener('contextmenu', e => e.preventDefault());
}

export function animateScene(time) {
    const dt = clock.getDelta();

    if (activeSplat) {
        // 1. WASD + QE -> Splat Position
        const moveSpeed = 0.5; 
        const move = new THREE.Vector3();
        
        if (keys.w) move.z -= 1; 
        if (keys.s) move.z += 1;
        if (keys.a) move.x -= 1;
        if (keys.d) move.x += 1;
        if (keys.q) move.y -= 1; 
        if (keys.e) move.y += 1; 
        
        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(moveSpeed * dt);
            activeSplat.position.add(move);
            console.log(`Splat Pos (${activeSplat === splatWhite ? 'W' : 'B'}): ${activeSplat.position.x.toFixed(3)}, ${activeSplat.position.y.toFixed(3)}, ${activeSplat.position.z.toFixed(3)}`);
        }

        // 2. IJKL -> Splat Rotation
        const rotSpeed = 1.0;
        if (keys.j) activeSplat.rotation.y += rotSpeed * dt;
        if (keys.l) activeSplat.rotation.y -= rotSpeed * dt;
        if (keys.i) activeSplat.rotation.x += rotSpeed * dt;
        if (keys.k) activeSplat.rotation.x -= rotSpeed * dt;
        
        if (keys.j || keys.l || keys.i || keys.k) {
             console.log(`Splat Rot (${activeSplat === splatWhite ? 'W' : 'B'}): X=${(activeSplat.rotation.x * 180/Math.PI).toFixed(1)}, Y=${(activeSplat.rotation.y * 180/Math.PI).toFixed(1)}`);
        }
    }

    renderer.render(scene, camera);
}

export function updateCameraPose(role) {
    currentRole = role;
    updateVolumetricPose();

    // Camera: Up and Forward
    if (role === 'w') {
        initialCameraPos.set(0, 1.8, 2.0); 
        initialCameraLookAt.set(0, 0.9, -0.4); // Look higher to push board down
    } else if (role === 'b') {
        initialCameraPos.set(0, 1.8, -2.0); 
        initialCameraLookAt.set(0, 0.9, 0.4);
    } else {
        initialCameraPos.set(3.0, 3.0, 0);
        initialCameraLookAt.set(0, 0.8, 0);
    }
    
    camera.position.copy(initialCameraPos);
    camera.lookAt(initialCameraLookAt);
}

export async function initScene() {
    clock = new THREE.Clock();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x202020);
    scene.fog = new THREE.FogExp2(0x202020, 0.1);

    // Zolly: Half FOV (38 -> 19)
    camera = new THREE.PerspectiveCamera(19, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 2.4, 1.6); 
    camera.lookAt(0, 0, -0.5);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; 
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.getElementById('app').appendChild(renderer.domElement);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
    dirLight.position.set(2, 4, 3);
    scene.add(dirLight);
    
    // Warm Spot
    const spotLight = new THREE.SpotLight(0xffd6aa, 15); 
    spotLight.position.set(0, 3, 0);
    spotLight.angle = Math.PI / 3;
    spotLight.penumbra = 0.5; 
    spotLight.distance = 10;
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.width = 1024;
    spotLight.shadow.mapSize.height = 1024;
    spotLight.shadow.radius = 4; 
    spotLight.shadow.bias = -0.0001; 
    
    spotLight.target.position.set(0, 0, 0); 
    scene.add(spotLight.target);
    scene.add(spotLight);

    // Load Assets
    await loadModels();

    window.addEventListener('resize', onWindowResize, false);

    // Load Assets
    await loadModels();

    window.addEventListener('resize', onWindowResize, false);

    // Call new Controls
    setupControls(renderer.domElement);

    scene.add(highlightGroup); // Add interaction layer

    return {
        scene,
        camera,
        renderer,
        boardGroup,
        piecesGroup,
        interactables,
        createCutout,
        updateBoard
    };
}

// Global splats for tuning
let splatWhite = null;
let splatBlack = null;
let activeSplat = null; // The one currently being tuned

async function loadModels() {
    console.log("Loading Environments (Splats)...");
    
    const loadSplat = async (filename, isWhite) => {
        const path = `${import.meta.env.BASE_URL}assets/${filename}`;
        try {
            const splatData = await splatLoader.loadAsync(path);
            const splat = new SplatMesh({ packedSplats: splatData });
             if (splat && splat.isObject3D) {
                scene.add(splat);
                splat.rotation.order = 'YXZ'; 
                
                // User Tuned Values for White
                // Rot: X=163.3, Y=198.9 -> Rads
                // Pos: -0.415, 0.948, 2.115
                
                const d2r = Math.PI / 180;
                const scale = 0.375;
                splat.scale.set(scale, scale, scale);

                if (isWhite) {
                    splat.rotation.x = 163.3 * d2r;
                    splat.rotation.y = 198.9 * d2r;
                    splat.rotation.z = 0;
                    
                    splat.position.set(-0.415, 0.948, 2.115);
                    splatWhite = splat;
                    activeSplat = splat; // Default to white for tuning
                } else {
                    // Mirror for Black
                    // Flip Z position. Flip X position?
                    // Rotate Y by 180 (198.9 - 180 = 18.9)
                    
                    splat.rotation.x = 163.3 * d2r;
                    splat.rotation.y = (198.9 - 180) * d2r;
                    splat.rotation.z = 0;
                    
                    // Mirror Position (Assuming symmetry around 0,0)
                    splat.position.set(0.415, 0.948, -2.115);
                    splatBlack = splat;
                }
                
                console.log(`Splat ${isWhite?'White':'Black'} Loaded`, splat.position);
             }
        } catch(e) {
            console.error(`Failed to load ${filename}:`, e);
        }
    };

    await loadSplat('white_view.splat', true);
    await loadSplat('black_view.splat', false);
    
    // Assign envSplat to active for compatibility with existing loop if needed
    // But better to update animateScene to use activeSplat
    envSplat = activeSplat; 

    
    // --- FURNITURE ---
    try {
        const table = await new Promise((resolve, reject) => loader.load('/assets/table_with_chairs.glb', resolve, undefined, reject));
        table.scene.traverse(c => { 
            if(c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
            // Push chairs back
            if (c.name.toLowerCase().includes('chair')) {
                // Determine direction based on Z
                if (c.position.z > 0.1) c.position.z += 0.4;
                else if (c.position.z < -0.1) c.position.z -= 0.4;
            }
        });
        scene.add(table.scene);
        console.log("Table Loaded");
    } catch(e) { console.warn("Failed to load table:", e); }

    // --- BOARD ---
    boardGroup.clear();
    const boardY = 0.776; 
    
    boardGroup.position.set(0, boardY, 0);
    scene.add(boardGroup);
    
    const squareSize = 0.05996;
    const boardGeo = new THREE.BoxGeometry(squareSize, 0.01, squareSize);
    const whiteMat = new THREE.MeshPhysicalMaterial({ color: 0xeecd9c, roughness: 0.5 });
    const blackMat = new THREE.MeshPhysicalMaterial({ color: 0x8b5a2b, roughness: 0.5 });
    
    for (let x = 0; x < 8; x++) {
        for (let z = 0; z < 8; z++) {
            const isWhite = (x + z) % 2 === 0;
            const square = new THREE.Mesh(boardGeo, isWhite ? whiteMat : blackMat);
            square.position.set((x - 3.5) * squareSize, 0, (z - 3.5) * squareSize);
            boardGroup.add(square);
        }
    }
    
    piecesGroup.position.y = boardY + 0.01;
    scene.add(piecesGroup);
}

// Map piece names
const pieceMap = {
    'p': 'Pawn_black', 'n': 'Knight_black', 'b': 'Bishop_black', 'r': 'Castle_black', 'q': 'Queen_black', 'k': 'King_black',
    'P': 'Pawn_white', 'N': 'Knight_white', 'B': 'Bishop_white', 'R': 'Castle_white', 'Q': 'Queen_white', 'K': 'King_white'
};

const pieceMeshes = {}; 

async function loadPieces() {
    const variants = [
        'Bishop_black', 'Bishop_white', 'Castle_black', 'Castle_white',
        'King_black', 'King_white', 'Knight_black', 'Knight_white',
        'Pawn_black', 'Pawn_white', 'Queen_black', 'Queen_white'
    ];
    
    for (const name of variants) {
        try {
            const gltf = await new Promise((resolve, reject) => loader.load(`${import.meta.env.BASE_URL}assets/${name}.glb`, resolve, undefined, reject));
            gltf.scene.traverse(c => {
                if(c.isMesh) {
                    c.castShadow = true;
                    c.receiveShadow = true;
                    // Ensure material is PBR
                     if (c.material) {
                        const old = c.material;
                        c.material = new THREE.MeshPhysicalMaterial({
                            map: old.map, color: old.color, roughness: 0.5, metalness: 0.1
                        });
                     }
                }
            });
            pieceMeshes[name] = gltf.scene;
        } catch(e) {
            console.error(`Failed piece: ${name}`, e);
        }
    }
}

export async function updateBoard(fen) {
    piecesGroup.clear();
    
    if (Object.keys(pieceMeshes).length === 0) {
        await loadPieces();
    }
    
    const rows = fen.split(' ')[0].split('/');
    const squareSize = 0.05996; 

    rows.forEach((row, rowIndex) => {
        let colIndex = 0;
        for (const char of row) {
            if (!isNaN(char)) {
                colIndex += parseInt(char);
            } else {
                const pieceName = pieceMap[char];
                if (pieceName && pieceMeshes[pieceName]) {
                    const instance = pieceMeshes[pieceName].clone();
                    
                    const x = (colIndex - 3.5) * squareSize;
                    const z = (rowIndex - 3.5) * squareSize;
                    
                    instance.position.set(x, 0, z);

                    if (char === char.toUpperCase()) {
                        instance.rotation.y = Math.PI;
                    }
                    
                    instance.userData = { 
                        tile: String.fromCharCode(97 + colIndex) + (8 - rowIndex),
                        color: (char === char.toUpperCase()) ? 'w' : 'b'
                    };
                    
                    piecesGroup.add(instance);
                    interactables.push(instance);
                }
                colIndex++;
            }
        }
    });
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
