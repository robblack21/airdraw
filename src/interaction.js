import * as THREE from 'three';
import { scene, camera, highlightSquares, setPieceGlow } from "./scene.js";

let raycaster;
let mouse;
let selectedSquare = null;
let selectedMesh = null;

export async function initInteraction(sceneCtx, gameCtx) {
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    window.addEventListener('click', (e) => onClick(e, gameCtx));
    
    // Voice Control hook
    if ('webkitSpeechRecognition' in window) {
        initVoice(gameCtx);
    }
}

function onClick(event, gameCtx) {
    if (!gameCtx) return;

    mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    if (intersects.length > 0) {
        // Debug first hit
        // console.log("Hit:", intersects[0].object.name, intersects[0].object.userData);
        
        // Find visible target: Piece, Board, or Highlight
        let target = intersects.find(i => i.object.visible && (i.object.userData.tile || i.object.name.includes("Board") || i.object.geometry.type === 'PlaneGeometry' || i.object.geometry.type === 'BoxGeometry')); 
        
        if (target) {
             console.log("Interact Target:", target.object.name || target.object.type, target.point);
        } else {
             console.log("No valid target found in " + intersects.length + " intersections");
        }
        
        if (!target) { deselect(); return; }
        
        const obj = target.object;
        
        // 1. Clicked a Piece? (Has userData.tile)
        // Traverse up to find the group that holds the userData
        let pieceObj = obj;
        while (pieceObj) {
            if (pieceObj.userData && pieceObj.userData.tile) {
                break;
            }
            pieceObj = pieceObj.parent;
            // Stop if we hit scene root
            if (pieceObj && pieceObj.type === 'Scene') {
                pieceObj = null;
                break;
            }
        }

        if (pieceObj && pieceObj.userData.tile) {
            const sq = pieceObj.userData.tile;
            console.log("Passed Tile Check:", sq); // Debug Logic
            
            const piece = gameCtx.get(sq);
            
            // If own piece -> Select
            if (piece && piece.color === gameCtx.turn()) {
                if (selectedMesh) setPieceGlow(selectedMesh, false);
                
                selectedSquare = sq;
                selectedMesh = pieceObj;
                setPieceGlow(selectedMesh, true);
                
                const moves = gameCtx.moves({ square: sq, verbose: true });
                highlightSquares(moves.map(m => m.to));
                return;
            }
            
            // If enemy piece -> Capture
            if (selectedSquare) {
                 attemptMove(gameCtx, selectedSquare, sq);
                 return;
            }
        }
        
        // 2. Clicked Board/Ground?
        if (selectedSquare) {
            const point = target.point;
            // Map 3D to Square
            // Same vars as scene.js
            const squareSize = 0.05996;
            
            // x = (col - 3.5) * size
            // col = x/size + 3.5
            const colIndex = Math.round((point.x / squareSize) + 3.5);
            // z = (row - 3.5) * size
            // row = z/size + 3.5
            // row 0 is Rank 8.
            const rowIndex = Math.round((point.z / squareSize) + 3.5);
            
            if (colIndex >= 0 && colIndex < 8 && rowIndex >= 0 && rowIndex < 8) {
                const files = 'abcdefgh';
                const rank = 8 - rowIndex;
                const dest = files[colIndex] + rank;
                
                attemptMove(gameCtx, selectedSquare, dest);
            } else {
                deselect();
            }
        }
    } else {
        deselect();
    }
}

function attemptMove(gameCtx, from, to) {
    if (from === to) return;
    try {
        const result = gameCtx.move({ from, to, promotion: 'q' });
        if (result) {
            if (window.app && window.app.updateBoard) {
                 window.app.updateBoard(gameCtx.fen());
            }
            deselect();
        } else {
            console.log("Invalid Move");
            deselect();
        }
    } catch (e) { console.warn("Move Error", e); deselect(); }
}

function deselect() {
    if (selectedMesh) setPieceGlow(selectedMesh, false);
    selectedMesh = null;
    selectedSquare = null;
    highlightSquares([]);
}

function initVoice(gameCtx) {
    try {
        const recognition = new window.webkitSpeechRecognition();
        recognition.continuous = true;
        recognition.lang = 'en-US';
        recognition.onresult = (event) => {
            const last = event.results.length - 1;
            const text = event.results[last][0].transcript.trim().toLowerCase();
            console.log("Voice Command:", text);
            const squares = text.match(/[a-h][1-8]/g);
            if (squares && squares.length >= 2) {
                 attemptMove(gameCtx, squares[0], squares[1]);
            }
        };
        recognition.start();
    } catch(e) { console.warn("Voice Error", e); }
}

export function updateInteraction(time) {}
