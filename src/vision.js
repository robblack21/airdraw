import { 
    FilesetResolver, 
    FaceLandmarker, 
    HandLandmarker, 
    ImageSegmenter 
} from '@mediapipe/tasks-vision';
// const FilesetResolver = { forVisionTasks: async () => ({}) };
// const FaceLandmarker = { createFromOptions: async () => ({}) };
// const HandLandmarker = { createFromOptions: async () => ({}) };
// const ImageSegmenter = { createFromOptions: async () => ({}) };
import { getLocalVideoElement } from './video.js';

let faceLandmarker;
let handLandmarker;
let imageSegmenter;
let lastVideoTime = -1;

// State to export
export const trackingState = {
    headPose: null, // { rotation, translation }
    handLandmarks: [],
    segmentationMask: null // canvas/imageBitmap
};

let headTrackingEnabled = true;

export function setHeadTrackingEnabled(enabled) {
    headTrackingEnabled = enabled;
}

export async function initVision(sceneContext) {
    console.log("Initializing MediaPipe Vision...");
    
    // Load WASM files (Local public/ copy)
    const visionGen = await FilesetResolver.forVisionTasks(
        import.meta.env.BASE_URL
    );

    // 1. Face Landmarker (Head Tracking)
    faceLandmarker = await FaceLandmarker.createFromOptions(visionGen, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });

    // 2. Hand Landmarker (Interaction)
    handLandmarker = await HandLandmarker.createFromOptions(visionGen, {
         baseOptions: {
             modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
             delegate: "GPU"
         },
         runningMode: "VIDEO",
         numHands: 2
    });

    // 3. Image Segmenter (Background Removal)
    imageSegmenter = await ImageSegmenter.createFromOptions(visionGen, {
        baseOptions: {
            modelAssetPath: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite",
            delegate: "GPU"
        },
        runningMode: "VIDEO",
        outputCategoryMask: true,
        outputConfidenceMasks: false
    });
    
    console.log("Vision models loaded.");
}

// Export mask canvas for use in texture
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
maskCanvas.width = 640; maskCanvas.height = 480; 
// Initialize white (opaque) so we see the video even if segmentation fails initially
maskCtx.fillStyle = 'white';
maskCtx.fillRect(0, 0, 640, 480);
export { maskCanvas };

export function updateVision() {
    const video = getLocalVideoElement();
    if (!video || !video.videoWidth) return;

    if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        let now = performance.now();
        
        // 1. Head (Local)
        if (faceLandmarker && headTrackingEnabled) {
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks.length > 0) {
                 trackingState.headPose = faceResult; 
            }
        }
        
        // 2. Hand (Local)
        if (handLandmarker) {
            const handResult = handLandmarker.detectForVideo(video, now);
            trackingState.handLandmarks = handResult.landmarks;
            
            // Process Interaction (Hover/Pinch)
            if (handResult.landmarks.length > 0) {
                // Use first hand for now
                const hand = handResult.landmarks[0];
                const thumbTip = hand[4];
                const indexTip = hand[8];
                
                // Calculate Pinch (Euclidean distance in normalized space)
                // Note: Z is also available but we mainly care about screen space pinch for now
                const dx = thumbTip.x - indexTip.x;
                const dy = thumbTip.y - indexTip.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                
                const isPinched = dist < 0.05; // Threshold for pinch
                
                // Use Index Tip as cursor position
                trackingState.handInteraction = {
                    x: indexTip.x,
                    y: indexTip.y,
                    isPinched: isPinched
                };
            } else {
                trackingState.handInteraction = null;
            }
        }
    }
}

// Separate function for Remote Segmentation
export function updateRemoteSegmentation(remoteVideo) {
    if (!remoteVideo || !remoteVideo.videoWidth || !imageSegmenter) return;
    
    // Resize mask canvas if needed
    if (maskCanvas.width !== remoteVideo.videoWidth || maskCanvas.height !== remoteVideo.videoHeight) {
        maskCanvas.width = remoteVideo.videoWidth;
        maskCanvas.height = remoteVideo.videoHeight;
    }

    imageSegmenter.segmentForVideo(remoteVideo, performance.now(), (result) => {
         // Draw mask to canvas
         const mask = result.categoryMask;
         if (mask) {
             // Handle MPMask -> ImageData
             // mask is likely MPImage or specific container. 
             // In 0.10.x, it has getAsUint8Array() or similar if on CPU, 
             // or we might need to use `imageSegmenter.labels` to know which is person.
             // Typically index 1 is person (Selfie Segmenter).
             
             const width = mask.width;
             const height = mask.height;
             
             // Ensure canvas matches
             if (maskCanvas.width !== width || maskCanvas.height !== height) {
                 maskCanvas.width = width;
                 maskCanvas.height = height;
             }
             
             // Get raw data (Uint8Array)
             // Note: mask.getAsUint8Array() is synchronous if data is available on CPU.
             // If GPU is used, this might be slow? But we need it for texture.
             const maskData = mask.getAsUint8Array(); 
             
             // Create ImageData buffer
             // We want Grayscale (luminance) for AlphaMap, or just Alpha channel?
             // Canvas texture uses the canvas content.
             // Let's write to RGBA ImageData.
             
             const imageData = maskCtx.getImageData(0, 0, width, height);
             const pixels = imageData.data;
             
             for (let i = 0; i < maskData.length; ++i) {
                 const val = maskData[i]; // 0=Background, 1=Person
                 // We want Person=White (Opaque), Background=Black (Transparent)
                 // Set RGB to White (255)
                 // Set Alpha to 255 if Person, 0 if Background
                 
                 const p = i * 4;
                 const isPerson = (val === 1); 
                 
                 pixels[p] = 255;     // R
                 pixels[p + 1] = 255; // G
                 pixels[p + 2] = 255; // B
                 pixels[p + 3] = isPerson ? 255 : 0; // A
             }
             
             maskCtx.putImageData(imageData, 0, 0);
             maskCanvas.needsUpdate = true;
         }
    });
}
