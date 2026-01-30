import { toggleAudio, toggleVideo, getDevices, setInputDevice } from './video.js';
import { setHeadTrackingEnabled } from './vision.js';
import { toggleOverheadView } from './scene.js';

export class CallUI {
    constructor() {
        this.controls = document.getElementById('call-controls');
        this.micBtn = document.getElementById('btn-mic');
        this.camBtn = document.getElementById('btn-cam');
        this.headBtn = document.getElementById('btn-head');
        this.settingsBtn = document.getElementById('btn-settings');
        this.settingsMenu = document.getElementById('settings-menu');
        this.audioSelect = document.getElementById('audio-select');
        this.videoSelect = document.getElementById('video-select');
        this.overheadBtn = document.getElementById('btn-overhead');
        
        this.isMicOn = true;
        this.isCamOn = true;
        this.isHeadTracking = true;
        this.isSettingsOpen = false;
        
        this.setupListeners();
    }
    
    setupListeners() {
        // Mic
        if (this.micBtn) {
            this.micBtn.addEventListener('click', () => {
                this.isMicOn = !this.isMicOn;
                toggleAudio(this.isMicOn);
                this.micBtn.textContent = this.isMicOn ? '🎤' : '🎤🚫'; // Visual feedback
                this.micBtn.style.opacity = this.isMicOn ? '1' : '0.5';
                console.log("Mic toggled:", this.isMicOn);
            });
        }
        
        // Cam
        if (this.camBtn) {
            this.camBtn.addEventListener('click', () => {
                this.isCamOn = !this.isCamOn;
                toggleVideo(this.isCamOn);
                this.camBtn.textContent = this.isCamOn ? '📷' : '📷🚫';
                this.camBtn.style.opacity = this.isCamOn ? '1' : '0.5';
                console.log("Cam toggled:", this.isCamOn);
            });
        }
        
        // Overhead View
        if (this.overheadBtn) {
            this.overheadBtn.addEventListener('click', () => {
                const isActive = toggleOverheadView();
                this.overheadBtn.style.opacity = isActive ? '1' : '0.5';
                console.log("Overhead View toggled:", isActive);
            });
        }
        
        // Head Tracking
        if (this.headBtn) {
            this.headBtn.addEventListener('click', () => {
                this.isHeadTracking = !this.isHeadTracking;
                setHeadTrackingEnabled(this.isHeadTracking);
                this.headBtn.style.opacity = this.isHeadTracking ? '1' : '0.5';
                console.log("Head Tracking toggled:", this.isHeadTracking);
            });
        }

        // Settings
        if (this.settingsBtn) {
            this.settingsBtn.addEventListener('click', async () => {
                this.isSettingsOpen = !this.isSettingsOpen;
                if (this.isSettingsOpen) {
                    this.settingsMenu.classList.remove('hidden');
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
    }

    async populateDevices() {
        const devices = await getDevices();
        
        this.audioSelect.innerHTML = '';
        this.videoSelect.innerHTML = '';
        
        devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `${d.kind} (${d.deviceId.slice(0,5)}...)`;
            
            if (d.kind === 'audioinput') {
                this.audioSelect.appendChild(opt);
            } else if (d.kind === 'videoinput') {
                this.videoSelect.appendChild(opt);
            }
        });
    }
}

export function initUI() {
    new CallUI();
}
