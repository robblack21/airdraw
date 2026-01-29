let depthCanvas;
let depthCtx;
let processing = false;

// Optimization: Reuse generic canvas
const width = 504; // User's library default is 504? Or 640? Library HTML said 504. Let's stick to 640x480 if we can, or resize.
// If library video is something else, we scale it.
const TARGET_WIDTH = 640;
const TARGET_HEIGHT = 480;
const compositeWidth = TARGET_WIDTH * 2; // Side-by-Side

export async function initDepthProcessor() {
    console.log("Initializing Depth Processor (Integration Mode)...");

    // Find Library Elements
    const libraryVideo = document.getElementById('video');
    const libraryCanvas = document.getElementById('output-canvas');
    
    if (!libraryVideo || !libraryCanvas) {
        throw new Error("Depth Library elements not found (#video or #output-canvas missing)");
    }

    if (!depthCanvas) {
        depthCanvas = document.createElement('canvas');
        depthCanvas.width = compositeWidth;
        depthCanvas.height = TARGET_HEIGHT;
        depthCtx = depthCanvas.getContext('2d', { willReadFrequently: true });
    }

    // Wait for library video to start
    console.log("Waiting for library video stream...");
    while (libraryVideo.readyState < 2) {
        await new Promise(r => setTimeout(r, 100));
    }
    console.log("Library video active. Dimensions:", libraryVideo.videoWidth, libraryVideo.videoHeight);

    processing = true;
    processFrame(libraryVideo, libraryCanvas);

    return depthCanvas.captureStream(30); // 30 FPS
}

function processFrame(video, depthSourceCanvas) {
    if (!processing) return;

    if (video.readyState >= 2) {
        try {
            // 1. Draw RGB (Left) - Scale to Target
            depthCtx.drawImage(video, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
            
            // 2. Draw Depth (Right) - Bake Alpha to RGB
            // We assume the library might store depth in Alpha or is transparent.
            // Drawing over BLACK ensures Alpha values become Intensity (assuming white ink).
            depthCtx.fillStyle = '#000000';
            depthCtx.fillRect(TARGET_WIDTH, 0, TARGET_WIDTH, TARGET_HEIGHT);
            depthCtx.drawImage(depthSourceCanvas, TARGET_WIDTH, 0, TARGET_WIDTH, TARGET_HEIGHT);
            
        } catch (e) {
            console.error("Depth compositing error:", e);
            processing = false;
        }
    }

    if (processing) {
        requestAnimationFrame(() => processFrame(video, depthSourceCanvas));
    }
}

export function stopDepthProcessor() {
    processing = false;
}
