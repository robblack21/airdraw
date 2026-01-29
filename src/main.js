import { initScene, animateScene, updateCameraPose, setDepthThresholds } from "./scene.js";
import { initGame } from "./game.js";
import { initVision, updateVision } from "./vision.js";
import { initVideo, getRemoteVideoElement } from "./video.js";
import { initInteraction, updateInteraction } from "./interaction.js";
import { initDepthProcessor } from "./depth.js";
import { initUI } from "./ui.js"; // New UI Module

const loadingUi = document.getElementById("loading");
const loadingDetails = document.getElementById("loading-details");
const startBtn = document.getElementById("start-btn");

const minDepthInput = document.getElementById("min-depth");
const maxDepthInput = document.getElementById("max-depth");
const minDepthVal = document.getElementById("min-depth-val");
const maxDepthVal = document.getElementById("max-depth-val");

if (minDepthInput && maxDepthInput) {
    const updateThresholds = () => {
        const min = parseFloat(minDepthInput.value);
        const max = parseFloat(maxDepthInput.value);
        minDepthVal.textContent = min.toFixed(2);
        maxDepthVal.textContent = max.toFixed(2);
        // Delay init or check if safe? It's safe if function exists.
        setDepthThresholds(min, max);
    };
    minDepthInput.addEventListener("input", updateThresholds);
    maxDepthInput.addEventListener("input", updateThresholds);
}

// Helper to trigger depth library updates
async function runDepthSequencer() {
    console.log("Running Depth Resolution Sequencer...");
    const sizeInput = document.getElementById('size');
    const scaleInput = document.getElementById('scale');
    
    if (!sizeInput) return;

    const setSize = (val) => {
        sizeInput.value = val;
        sizeInput.dispatchEvent(new Event('input', { bubbles: true }));
        sizeInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log("Set Depth Resolution to:", val);
    };

    // Sequence: 252 -> Wait -> 224
    // Initial wait to let model load?
    await new Promise(r => setTimeout(r, 10000)); 
    
    setSize(252);
    
    await new Promise(r => setTimeout(r, 1500));
    
    setSize(224);
    console.log("Depth Sequencer Complete: Quality set to 224px. Framerate should stabilize.");
}

async function main() {
  let sceneContext; // Hoisted for scope visibility
  
  try {
    loadingDetails.textContent = "Initializing Scene...";
    initUI(); // Initialize UI Listeners
    sceneContext = await initScene();

    // Check for Role in URL
    const urlParams = new URLSearchParams(window.location.search);
    const role = urlParams.get('role') || 'w'; // Default to White
    console.log("Setting Role:", role);
    updateCameraPose(role);

    loadingDetails.textContent = "Initializing Game Logic...";
    const gameContext = await initGame();
    
    loadingDetails.textContent = 'Generating Pieces...';
    const { updateBoard } = await import('./scene.js');
    await updateBoard(gameContext.getFen());

    loadingDetails.textContent = "Initializing Interaction...";
    const interactionContext = await initInteraction(sceneContext, gameContext);

    // ready to start
    loadingDetails.textContent = "Ready!";
    
    // Debug Access
    window.app = {
        scene: sceneContext.scene,
        camera: sceneContext.camera,
        createCutout: sceneContext.createCutout,
        updateBoard: sceneContext.updateBoard,
        gameCtx: gameContext
    };
    
    startBtn.classList.add("hidden"); // Auto-joining, so hide button

    const autoJoin = async () => {
      loadingDetails.textContent = "Auto-Connecting camera & depth...";
      console.log("Starting Auto-Join sequence (Integration Mode)...");
      
      try {
        // 1. Start Depth Processor (Waits for Library #video)
        console.log("Starting Depth Processor (Library Mode)...");
        // This function now finds #video internally and waits for it.
        const compositeStream = await initDepthProcessor();
        
        // Trigger Resolution Sequence in background
        runDepthSequencer();
        
        const compositeTrack = compositeStream.getVideoTracks()[0];
        console.log("Depth Processor started. Composite track:", compositeTrack.label);

        // 2. Init Vision 
        // Note: vision.js needs access to the video element. 
        // We will need to ensure it uses #video (Library) not #webcam.
        // 2. Init Vision 
        try {
            console.log("Calling initVision...");
            await initVision(sceneContext); 
            console.log("initVision complete.");
        } catch(e) { console.error("Vision Init Failed", e); }

        // 3. Init Video (Daily) with Composite Track
        try {
            console.log("Calling initVideo with Depth Track...");
            await initVideo({
                videoSource: compositeTrack, // Send RGBD to remote
                onRemoteVideo: (videoEl) => {
                    sceneContext.createCutout(videoEl);
                },
                onAppMessage: async (data, fromId) => {
                    if (data.type === 'move') {
                        console.log("Received remote move:", data);
                        const result = await window.app.gameCtx.move(data.from, data.to); 
                        if (result) {
                            sceneContext.updateBoard(window.app.gameCtx.getFen());
                        }
                    }
                }
            }); 
            console.log("initVideo complete.");
        } catch(e) { console.error("Video Init Failed", e); }

        loadingUi.classList.add("hidden");

        // Start Loop
        requestAnimationFrame(loop);
        
      } catch (e) {
          console.error("Setup Failed", e);
          loadingDetails.textContent = "Error: " + e.message;
          // If auto-join fails, show button to retry
          startBtn.classList.remove("hidden");
          startBtn.textContent = "Retry Connection";
          startBtn.onclick = autoJoin;
      }
    };
    
    // Trigger immediately
    autoJoin();

    function loop(time) {
      updateVision();
      
      // Remote video texture updates handled by THREE.VideoTexture automatically
      // updateRemoteSegmentation(remoteVideo); // Legacy CPU segmentation removed
      
      updateInteraction(time);
      animateScene(time);
      requestAnimationFrame(loop);
    }
  } catch (err) {
    loadingDetails.textContent = "Fatal Error: " + err.message;
    console.error(err);
  }
}

main();
