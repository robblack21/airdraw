import DailyIframe from '@daily-co/daily-js';

let callObject;
let localStream = null;
let onAppMessageCallback = null;
let onRemoteVideoCallback = null;

const ROOM_URL = "https://vcroom.daily.co/airdraw"; 

export async function initVideo({ onRemoteVideo, onAppMessage, videoSource } = {}) {
    console.log("Initializing Daily.co...");
    onRemoteVideoCallback = onRemoteVideo;
    onAppMessageCallback = onAppMessage;
    
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
    });

    callObject.on('participant-updated', (evt) => {
        const p = evt.participant;
        if (p.local) {
            updateLocalVideo(p);
        } else {
            updateRemoteVideo(p);
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

function updateRemoteVideo(p) {
    if (!p.video) {
        console.log("Remote participant updated but no video", p.user_id);
        return;
    }
    const track = p.tracks.video.persistentTrack;
    if (track) {
         console.log("Remote video track found:", track.id, track.readyState);
         let remoteEl = document.getElementById('remote-video-el');
         if (!remoteEl) {
             console.log("Creating new remote video element");
             remoteEl = document.createElement('video');
             remoteEl.id = 'remote-video-el';
             remoteEl.style.display = 'none'; // We use it as texture, so hide DOM
             remoteEl.autoplay = true;
             remoteEl.playsInline = true;
             // remoteEl.muted = false; // We want to hear them? 
             // Browsers BLOCK unmuted autoplay. 
             // We must mute it initially OR ensure user gesture cleared it.
             // Daily.co usually manages audio via its own audio elements.
             // This video element is PURELY for texture. So mute it to ensure autoplay works!
             remoteEl.muted = true; 
             document.body.appendChild(remoteEl);
         }
         
         if (!remoteEl.srcObject || remoteEl.srcObject.id !== track.id) {
             console.log("Assigning remote track to element");
             remoteEl.srcObject = new MediaStream([track]);
             remoteEl.onloadedmetadata = () => {
                 console.log("Remote video metadata loaded. Dimensions:", remoteEl.videoWidth, remoteEl.videoHeight);
                 remoteEl.play().then(() => {
                     console.log("Remote video playing successfully");
                     if (onRemoteVideoCallback) {
                         console.log("Triggering onRemoteVideoCallback");
                         onRemoteVideoCallback(remoteEl);
                     }
                 }).catch(e => {
                     console.error("Remote video failed to play (Autoplay policy?)", e);
                     // Fallback: try muted if not already
                     if (!remoteEl.muted) {
                         console.log("Retrying playback muted...");
                         remoteEl.muted = true;
                         remoteEl.play().catch(e2 => console.error("Remote video failed muted too", e2));
                     }
                 });
             };
         }
    } else {
        console.log("Remote video track is missing or not persistent");
    }
}



// ... updateRemoteVideo ...

export function getLocalVideoElement() {
    return document.getElementById('video') || document.getElementById('webcam');
}

export function getRemoteVideoElement() {
    return document.getElementById('remote-video-el');
}
