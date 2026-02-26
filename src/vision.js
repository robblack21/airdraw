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
// Pure time-based throttle — no frame-count confusion.
let _handIntervalMs = 33;       // default ~30fps (configurable via slider)
let _lastHandTime = 0;
let _faceIntervalMs = 250;      // face tracking ~4fps
let _lastFaceTime = 0;

// Tracking stats (for UI display)
let _handDetectCount = 0;
let _handDetectStartTime = 0;
let _lastHandDurationMs = 0;
export function getHandTrackingStats() {
  const elapsed = performance.now() - _handDetectStartTime;
  const fps = elapsed > 1000 ? (_handDetectCount / (elapsed / 1000)).toFixed(1) : '--';
  return { fps, lastDurationMs: _lastHandDurationMs.toFixed(1) };
}

// ── Smoothing state ──────────────────────────────────────
let _smoothedLandmarks = null;
const SMOOTH_ALPHA = 0.35;

// Track whether new data arrived (version counter for main loop to gate expensive work)
let _handDataVersion = 0;
export function getHandDataVersion() { return _handDataVersion; }

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

export function setHandTrackingFps(fps) {
  fps = Math.max(1, Math.min(30, fps));
  _handIntervalMs = 1000 / fps;
}

export function getHandTrackingFps() {
  return Math.round(1000 / _handIntervalMs);
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

    _handDetectStartTime = performance.now();
    console.log(`Hand tracking loaded (${getHandTrackingFps()}fps, smoothing α=${SMOOTH_ALPHA})`);
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
 */
function smoothLandmarks(rawLandmarks) {
  if (!rawLandmarks || rawLandmarks.length === 0) {
    _smoothedLandmarks = null;
    return rawLandmarks;
  }

  if (!_smoothedLandmarks || _smoothedLandmarks.length !== rawLandmarks.length) {
    _smoothedLandmarks = rawLandmarks.map(hand =>
      hand.map(lm => ({ x: lm.x, y: lm.y, z: lm.z }))
    );
    return _smoothedLandmarks;
  }

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

    const now = performance.now();

    // ── Face tracking (very infrequent, time-based) ──
    if (_headTrackingNeeded && (now - _lastFaceTime >= _faceIntervalMs)) {
      if (faceLandmarker) {
        _lastFaceTime = now;
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

    // ── Hand tracking (pure time-based throttle) ──
    if (!_handTrackingEnabled || !handLandmarker) return;
    if (now - _lastHandTime < _handIntervalMs) return;
    _lastHandTime = now;

    try {
        lastVideoTime = video.currentTime;
        const t0 = performance.now();
        const handResult = handLandmarker.detectForVideo(video, now);
        _lastHandDurationMs = performance.now() - t0;
        _handDetectCount++;

        // Bump version so main loop knows new data arrived
        _handDataVersion++;

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
