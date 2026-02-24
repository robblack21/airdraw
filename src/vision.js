import {
    FilesetResolver,
    FaceLandmarker,
    HandLandmarker
} from '@mediapipe/tasks-vision';
import { getLocalVideoElement } from './video.js';

let faceLandmarker;
let handLandmarker;
let lastVideoTime = -1;
let _headTrackingNeeded = false;
let _handTrackingEnabled = true;

// ── Performance tuning ──────────────────────────────────
// Hand tracking is expensive (~8-12ms GPU per call).
// Run at ~6fps (every 10th render frame at 60fps).
let _frameCount = 0;
const HAND_EVERY_N = 10;    // run hand detection every 10th frame (~6fps)
const FACE_EVERY_N = 15;    // run face detection every 15th frame (~4fps)
let _lastHandTime = 0;
const MIN_HAND_INTERVAL_MS = 100; // absolute floor: max 10fps

// ── Smoothing state ──────────────────────────────────────
// Exponential moving average for landmark positions
let _smoothedLandmarks = null;  // smoothed copy of hand landmarks
const SMOOTH_ALPHA = 0.35;      // higher = less lag, lower = smoother

// State to export
export const trackingState = {
    headPose: null,
    handLandmarks: [],
    handInteraction: null
};

export function setVisionHeadTracking(enabled) {
  _headTrackingNeeded = enabled;
}

export function setVisionHandTracking(enabled) {
  _handTrackingEnabled = enabled;
  if (!enabled) {
    trackingState.handLandmarks = [];
    trackingState.handInteraction = null;
    _smoothedLandmarks = null;
  }
}

export async function initVision(sceneContext) {
    console.log("Initializing MediaPipe Vision...");

    const visionGen = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm"
    );

    handLandmarker = await HandLandmarker.createFromOptions(visionGen, {
         baseOptions: {
             modelAssetPath: `https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
             delegate: "GPU"
         },
         runningMode: "VIDEO",
         numHands: 2
    });

    console.log(`Hand tracking loaded (throttled to ~${Math.round(60/HAND_EVERY_N)}fps, smoothing α=${SMOOTH_ALPHA})`);
}

// Lazy-load face landmarker only when first needed
let _faceLoadPromise = null;
async function ensureFaceLandmarker() {
  if (faceLandmarker || _faceLoadPromise) return;
  _faceLoadPromise = (async () => {
    console.log("Loading face landmarker...");
    const visionGen = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(visionGen, {
        baseOptions: {
            modelAssetPath: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
            delegate: "GPU"
        },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1
    });
    console.log("Face landmarker loaded.");
  })();
}

/**
 * Smooth landmarks using exponential moving average.
 * Returns a new array of smoothed landmarks.
 */
function smoothLandmarks(rawLandmarks) {
  if (!rawLandmarks || rawLandmarks.length === 0) {
    _smoothedLandmarks = null;
    return rawLandmarks;
  }

  if (!_smoothedLandmarks || _smoothedLandmarks.length !== rawLandmarks.length) {
    // First frame or hand count changed — snap
    _smoothedLandmarks = rawLandmarks.map(hand =>
      hand.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }))
    );
    return _smoothedLandmarks;
  }

  // Lerp each landmark toward raw position
  for (let h = 0; h < rawLandmarks.length; h++) {
    const raw = rawLandmarks[h];
    const smooth = _smoothedLandmarks[h];
    if (!smooth || smooth.length !== raw.length) {
      _smoothedLandmarks[h] = raw.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }));
      continue;
    }
    for (let i = 0; i < raw.length; i++) {
      smooth[i].x += (raw[i].x - smooth[i].x) * SMOOTH_ALPHA;
      smooth[i].y += (raw[i].y - smooth[i].y) * SMOOTH_ALPHA;
      smooth[i].z += (raw[i].z - smooth[i].z) * SMOOTH_ALPHA;
    }
  }

  return _smoothedLandmarks;
}

export function updateVision() {
    const video = getLocalVideoElement();
    if (!video || !video.videoWidth) return;
    if (video.currentTime === lastVideoTime) return;

    _frameCount++;
    const now = performance.now();

    // ── Face tracking (very infrequent) ──
    if (_headTrackingNeeded && _frameCount % FACE_EVERY_N === 0) {
      if (faceLandmarker) {
        try {
            lastVideoTime = video.currentTime;
            const faceResult = faceLandmarker.detectForVideo(video, now);
            if (faceResult.faceLandmarks.length > 0) {
                trackingState.headPose = faceResult;
            }
        } catch (e) { /* skip frame */ }
      } else {
        ensureFaceLandmarker();
      }
    }

    // ── Hand tracking (throttled to ~6fps with time floor) ──
    if (!_handTrackingEnabled || !handLandmarker) return;
    if (_frameCount % HAND_EVERY_N !== 0) return;
    if (now - _lastHandTime < MIN_HAND_INTERVAL_MS) return;
    _lastHandTime = now;

    try {
        lastVideoTime = video.currentTime;
        const handResult = handLandmarker.detectForVideo(video, now);

        // Smooth the raw landmarks
        const smoothed = smoothLandmarks(handResult.landmarks);
        trackingState.handLandmarks = smoothed;

        if (smoothed && smoothed.length > 0) {
            const hand = smoothed[0];
            const thumbTip = hand[4];
            const indexTip = hand[8];

            const dx = thumbTip.x - indexTip.x;
            const dy = thumbTip.y - indexTip.y;
            const dist = Math.sqrt(dx*dx + dy*dy);

            trackingState.handInteraction = {
                x: (thumbTip.x + indexTip.x) / 2,
                y: (thumbTip.y + indexTip.y) / 2,
                isPinched: dist < 0.05,
                pinchDistance: dist
            };
        } else {
            trackingState.handInteraction = null;
        }
    } catch (e) { /* skip frame */ }
}
