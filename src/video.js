import DailyIframe from '@daily-co/daily-js';

let callObject;
let localStream = null;
let onAppMessageCallback = null;
let onRemoteVideoCallback = null;
let onParticipantLeftCallback = null;

// Multi-participant tracking
const remoteParticipants = new Map(); // peerId -> { videoEl, trackId }

const ROOM_URL = "https://vcroom.daily.co/airdraw";

export async function initVideo({ onRemoteVideo, onAppMessage, onParticipantLeft, videoSource } = {}) {
    console.log("Initializing Daily.co...");
    onRemoteVideoCallback = onRemoteVideo;
    onAppMessageCallback = onAppMessage;
    onParticipantLeftCallback = onParticipantLeft;

    callObject = DailyIframe.createCallObject({
        url: ROOM_URL,
        subscribeToTracksAutomatically: true
    });

    callObject.on('joined-meeting', (evt) => {
        console.log('Joined Daily meeting', evt);
        const participants = callObject.participants();
        const localPart = participants.local;
        if (localPart) {
            updateLocalVideo(localPart);
        }

        // Handle existing remote participants
        for (const [id, p] of Object.entries(participants)) {
            if (id !== 'local' && p.video) {
                updateRemoteVideo(p);
            }
        }
    });

    callObject.on('participant-updated', (evt) => {
        const p = evt.participant;
        if (p.local) {
            updateLocalVideo(p);
        } else {
            updateRemoteVideo(p);
        }
    });

    callObject.on('participant-left', (evt) => {
        const p = evt.participant;
        if (!p.local) {
            const peerId = p.user_id;
            removeRemoteParticipant(peerId);
            if (onParticipantLeftCallback) {
                onParticipantLeftCallback(peerId);
            }
        }
    });

    callObject.on('app-message', (evt) => {
        if (onAppMessageCallback) {
            onAppMessageCallback(evt.data, evt.fromId);
        }
    });

    try {
        console.log("Joining Daily room...");

        // Explicitly get local audio to ensure it works even with custom videoSource
        let audioTrack = null;
        try {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            audioTrack = audioStream.getAudioTracks()[0];
            console.log("Acquired local audio track:", audioTrack.label);
        } catch(e) {
            console.warn("Failed to get local audio:", e);
        }

        const joinOptions = { url: ROOM_URL };

        if (videoSource) {
            console.log("Using custom video source for Depth/Volumetric video");
            joinOptions.videoSource = videoSource;
        } else {
            joinOptions.video = true;
        }

        if (audioTrack) {
             joinOptions.audioSource = audioTrack;
        } else {
             // Fallback
             joinOptions.audio = true;
        }

        await callObject.join(joinOptions);
        console.log("Joined Daily room");
    } catch (e) {
        console.error("Failed to join call", e);
    }
}

// Control methods
export function toggleAudio(allowed) {
    if (callObject) {
        callObject.setLocalAudio(allowed);
        return allowed;
    }
    return false;
}

export function toggleVideo(allowed) {
    if (callObject) {
        callObject.setLocalVideo(allowed);
        return allowed;
    }
    return false;
}

export async function getDevices() {
    return await navigator.mediaDevices.enumerateDevices();
}

export async function setInputDevice(kind, deviceId) {
    if (!callObject) return;
    if (kind === 'audio') {
        await callObject.setInputDevicesAsync({ audioDeviceId: deviceId });
    } else if (kind === 'video') {
         await callObject.setInputDevicesAsync({ videoDeviceId: deviceId });
    }
}

export function sendMove(from, to) {
    if (callObject) {
        callObject.sendAppMessage({ type: 'move', from, to });
    }
}

export function getCallObject() {
    return callObject;
}

function updateLocalVideo(p) {
    if (!p.video) return;
    const track = p.tracks.video.persistentTrack;
    if (track) {
        if (!localStream || localStream.id !== track.id) {
            localStream = new MediaStream([track]);

            // Check for library video element first
            let videoEl = document.getElementById('video');
            if (videoEl) {
                // Library manages its own source. Do not overwrite with Daily's echo.
                return;
            }

            videoEl = document.getElementById('webcam');
            if (videoEl) {
                videoEl.srcObject = localStream;
                videoEl.onloadedmetadata = () => {
                    if (videoEl.paused) {
                        videoEl.play().catch(e => console.error("Local play error", e));
                    }
                };
            }
        }
    }
}

// Multi-participant remote video handling
function updateRemoteVideo(p) {
    if (!p.video) {
        console.log("Remote participant updated but no video", p.user_id);
        return;
    }

    const peerId = p.user_id;
    const track = p.tracks.video.persistentTrack;

    if (!track) {
        console.log("Remote video track is missing or not persistent for", peerId);
        return;
    }

    // Check if we already have this exact track
    const existing = remoteParticipants.get(peerId);
    if (existing && existing.trackId === track.id) return;

    console.log(`[Video] Remote video track for ${peerId}:`, track.id, track.readyState);

    // Create or reuse video element for this peer
    let videoEl;
    if (existing && existing.videoEl) {
        videoEl = existing.videoEl;
    } else {
        videoEl = document.createElement('video');
        videoEl.id = `remote-video-${peerId}`;
        videoEl.style.display = 'none'; // Texture source, hidden from DOM
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true; // Must mute for autoplay policy
        document.body.appendChild(videoEl);
    }

    videoEl.srcObject = new MediaStream([track]);
    videoEl.onloadedmetadata = () => {
        console.log(`[Video] Remote ${peerId} metadata loaded: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
        videoEl.play().then(() => {
            console.log(`[Video] Remote ${peerId} playing`);
            if (onRemoteVideoCallback) {
                onRemoteVideoCallback(videoEl, peerId);
            }
        }).catch(e => {
            console.error(`[Video] Remote ${peerId} play failed:`, e);
            if (!videoEl.muted) {
                videoEl.muted = true;
                videoEl.play().catch(e2 => console.error(`[Video] ${peerId} muted retry failed:`, e2));
            }
        });
    };

    remoteParticipants.set(peerId, { videoEl, trackId: track.id });
}

function removeRemoteParticipant(peerId) {
    const entry = remoteParticipants.get(peerId);
    if (!entry) return;

    console.log(`[Video] Removing remote participant ${peerId}`);
    if (entry.videoEl) {
        entry.videoEl.pause();
        entry.videoEl.srcObject = null;
        entry.videoEl.remove();
    }
    remoteParticipants.delete(peerId);
}

export function getLocalVideoElement() {
    return document.getElementById('video') || document.getElementById('webcam');
}

export function getRemoteVideoElement() {
    // Return first remote for backward compat
    for (const [, entry] of remoteParticipants) {
        return entry.videoEl;
    }
    return null;
}
