'use strict';

let ss_localStream = null;
let ss_sharingState = 'idle'; 
let ss_peerConnection; 
let ss_isNegotiating = false; 
let ss_remoteStream = null; 
let ss_transceivers = { video: null, audio: null }; 

// UI Element References
let startScreenShareButton = null;
let stopScreenShareButton = null;
// ... (other UI element vars)
let screenResolutionSelect = null;
let screenFramerateSelect = null;
let screenShareStatus = null;
let remoteScreenVideo = null; 
let screenAudioOutputSelect = null;
let screenOutputVolumeSlider = null;
let toggleViewScreenShareButton = null;


const ss_log = (message, level = 'info', ...args) => { /* ... (as defined before) ... */ 
    const prefix = "ScreenSharePlugin:";
    if (typeof log === 'function') {
        log(`${prefix} ${message}`, level, ...args);
    } else {
        switch (level) {
            case 'error': console.error(`${prefix} ${message}`, ...args); break;
            case 'warn': console.warn(`${prefix} ${message}`, ...args); break;
            default: console.log(`${prefix} ${message}`, ...args); break;
        }
    }
};
const ss_addMessageToChat = (message, type = "system") => { /* ... (as defined before) ... */ 
    if (typeof addMessageToChat === 'function') {
        try { addMessageToChat(message, type); } 
        catch (e) { ss_log(`Error calling addMessageToChat: ${e.message}`, 'error', e); }
    } else { ss_log(`addMessageToChat not available. Message: ${message} (type: ${type})`, 'warn'); }
};

async function ss_populateAudioOutputDevices() { /* ... (as defined before) ... */ 
    ss_log("ss_populateAudioOutputDevices() called.");
    if (!screenAudioOutputSelect) {
        ss_log("screenAudioOutputSelect element not found.", 'warn');
        return;
    }
    const currentSelection = screenAudioOutputSelect.value;
    screenAudioOutputSelect.innerHTML = '<option value="">Default Speaker</option>'; 
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        devices.forEach(device => {
            if (device.kind === 'audiooutput') {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.text = device.label || `Speaker ${screenAudioOutputSelect.options.length}`;
                screenAudioOutputSelect.appendChild(option);
            }
        });
        if (Array.from(screenAudioOutputSelect.options).some(opt => opt.value === currentSelection)) {
            screenAudioOutputSelect.value = currentSelection;
        }
        ss_log("Audio output devices populated.");
    } catch (error) {
        ss_log(`Error populating audio output devices: ${error.name} - ${error.message}`, 'error', error);
        ss_addMessageToChat("--- Error listing audio output devices. ---", "error");
    }
}

function ss_updateShareUI() { /* ... (as defined before, with checks for element existence) ... */ 
    if (!startScreenShareButton || !stopScreenShareButton || !screenShareStatus || !screenResolutionSelect || !screenFramerateSelect || !toggleViewScreenShareButton) {
        ss_log("Not all UI elements found in ss_updateShareUI. UI update might be incomplete.", 'warn');
    }
    ss_log(`ss_updateShareUI: Current state: ${ss_sharingState}, Negotiating: ${ss_isNegotiating}, PC State: ${ss_peerConnection ? ss_peerConnection.signalingState : 'N/A'}`);

    const isDataChannelReady = typeof dataChannel !== 'undefined' && dataChannel && dataChannel.readyState === 'open';
    const isCurrentlySending = (ss_sharingState === 'sharing');
    const isCurrentlyReceiving = remoteScreenVideo && remoteScreenVideo.srcObject && remoteScreenVideo.srcObject.getVideoTracks().some(t => t.readyState === 'live');

    let statusText;
    const peerName = (typeof PEER_USERNAME !== 'undefined' && PEER_USERNAME) ? PEER_USERNAME : 'Peer';

    if (isCurrentlySending && isCurrentlyReceiving) {
        statusText = `Status: Sharing your screen & Viewing ${peerName}'s screen`;
    } else if (isCurrentlySending) {
        statusText = "Status: Sharing your screen";
    } else if (isCurrentlyReceiving) {
        statusText = `Status: Viewing ${peerName}'s screen`;
    } else { // Not sending and not receiving (ss_sharingState should be 'idle')
        statusText = isDataChannelReady ? "Status: Idle" : "Status: Idle (P2P not ready)";
    }
    if(screenShareStatus) screenShareStatus.textContent = statusText;

    if(startScreenShareButton) {
        startScreenShareButton.style.display = isCurrentlySending ? 'none' : 'inline-block';
        
        const canStartShare = isDataChannelReady && 
                              !isCurrentlySending && 
                              !ss_isNegotiating && 
                              (ss_peerConnection && (ss_peerConnection.signalingState === 'stable' || ss_peerConnection.signalingState === 'have-nothing'));
        
        startScreenShareButton.disabled = !canStartShare;
        startScreenShareButton.title = canStartShare ? "Start Sharing Screen" : 
                                       (isCurrentlySending ? "You are already sharing your screen" : "System busy or P2P not ready.");
    }
    if(stopScreenShareButton) stopScreenShareButton.style.display = isCurrentlySending ? 'inline-block' : 'none';
    
    if(screenResolutionSelect) screenResolutionSelect.disabled = isCurrentlySending || ss_isNegotiating;
    if(screenFramerateSelect) screenFramerateSelect.disabled = isCurrentlySending || ss_isNegotiating;

    if (toggleViewScreenShareButton) {
        if (isCurrentlyReceiving) { 
            toggleViewScreenShareButton.style.display = 'inline-block';
            toggleViewScreenShareButton.textContent = remoteScreenVideo.muted ? 'Unmute Stream' : 'Mute Stream';
        } else {
            toggleViewScreenShareButton.style.display = 'none';
        }
    }
}

function setupPeerConnectionEventHandlers() {
    if (ss_peerConnection) { // ss_peerConnection is pc
        ss_log('setupPeerConnectionEventHandlers: Setting up event handlers for pc object.');

        // Guard against multiple attachments if function is called multiple times
        // by checking if a specific handler (e.g. onsignalingstatechange) has already been set by this plugin
        // A more robust way would be to use a flag, e.g. pc._ss_handlers_set = true;
        if (pc._ss_onsignalingstatechange_set) {
            ss_log("PeerConnection event handlers seem to be already set by ScreenSharePlugin. Skipping.", "info");
            return;
        }

        pc.onsignalingstatechange = () => {
            ss_log(`PeerConnection signaling state changed: ${pc.signalingState}`);
            ss_updateShareUI(); 
        };
        pc._ss_onsignalingstatechange_set = true; // Mark as set
        ss_log(`pc.onsignalingstatechange handler set. Current state: ${pc.signalingState}`);

        pc.oniceconnectionstatechange = () => {
            ss_log(`ICE connection state changed: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
               ss_addMessageToChat(`--- Screen share P2P connection issue: ${pc.iceConnectionState}. May impact streaming. ---`, "warning");
            }
            ss_updateShareUI(); 
        };
        ss_log(`pc.oniceconnectionstatechange handler set. Current state: ${pc.iceConnectionState}`);

        pc.onconnectionstatechange = () => { 
            ss_log(`PeerConnection state changed: ${pc.connectionState}`);
             if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
               ss_addMessageToChat(`--- Screen share P2P connection status: ${pc.connectionState}. Streaming may be interrupted. ---`, "warning");
                if (ss_sharingState === 'sharing') {
                    ss_log("P2P connection lost while sharing. Consider local cleanup.", "warn");
                    // May call a function to stop local stream and UI without signaling, e.g.,
                    // if (stopScreenShareButton && stopScreenShareButton.onclick) stopScreenShareButton.onclick(true /* localOnly */);
                }
            }
            ss_updateShareUI();
        };
        ss_log(`pc.onconnectionstatechange handler set. Current state: ${pc.connectionState}`);

        // pc.ontrack = (event) => {
        //     ss_log(`pc.ontrack event fired. Track kind: ${event.track.kind}, ID: ${event.track.id}, Stream IDs: ${event.streams.map(s => s.id).join(', ')}`);
        //     const track = event.track;
        //     if (!remoteScreenVideo) {
        //         ss_log("remoteScreenVideo element not found. Cannot attach track.", "error");
        //         return;
        //     }

        //     let isScreenShareTrack = false;
        //     if (track.kind === 'video') {
        //         if (!remoteScreenVideo.srcObject || remoteScreenVideo.srcObject.getVideoTracks().length === 0) {
        //             isScreenShareTrack = true;
        //             ss_log(`Heuristic: Attaching video track ${track.id} as first video for remoteScreenVideo.`);
        //             if (!ss_transceivers.video || !ss_transceivers.video.receiver) {
        //                  ss_log("Video transceiver not found or receiver missing, cannot definitively link for screen share management beyond heuristic.", "warn");
        //             } else {
        //                  ss_log("Associating incoming video track with existing video transceiver for management.");
        //             }
        //         } else if (ss_transceivers.video && ss_transceivers.video.receiver && ss_transceivers.video.receiver.track === track) {
        //             isScreenShareTrack = true; 
        //             ss_log("Incoming video track matches managed screen share video transceiver's existing track. (Unexpected for restart if cleanup was perfect)");
        //         } else {
        //              ss_log(`Additional video track ${track.id} received but remoteScreenVideo already has video. Not treating as primary screen share.`, "info");
        //         }
        //     } else if (track.kind === 'audio') {
        //         if (remoteScreenVideo.srcObject && remoteScreenVideo.srcObject.getVideoTracks().length > 0 && remoteScreenVideo.srcObject.getAudioTracks().length === 0) {
        //             isScreenShareTrack = true;
        //             ss_log(`Heuristic: Attaching audio track ${track.id} to remoteScreenVideo with existing video.`);
        //             if (!ss_transceivers.audio || !ss_transceivers.audio.receiver) {
        //                 ss_log("Audio transceiver not found or receiver missing, cannot definitively link for screen share management beyond heuristic.", "warn");
        //             } else {
        //                  ss_log("Associating incoming audio track with existing audio transceiver for management.");
        //             }
        //         } else if (ss_transceivers.audio && ss_transceivers.audio.receiver && ss_transceivers.audio.receiver.track === track) {
        //             isScreenShareTrack = true;
        //             ss_log("Incoming audio track matches managed screen share audio transceiver's existing track. (Unexpected for restart if cleanup was perfect)");
        //         } else {
        //             ss_log(`Additional audio track ${track.id} received but not fitting screen share audio heuristics.`, "info");
        //         }
        //     } else {
        //         ss_log(`Track ${track.id} (kind: ${track.kind}) not video or audio. Ignoring for screen share.`, "info");
        //     }

        //     if (isScreenShareTrack) {
        //         ss_log(`Attaching screen share track (kind: ${track.kind}, ID: ${track.id}) to remoteScreenVideo.`);
        //         if (!remoteScreenVideo.srcObject) {
        //             remoteScreenVideo.srcObject = new MediaStream();
        //             ss_log("Created new MediaStream for remoteScreenVideo.srcObject in ontrack.");
        //         }
        //         try {
        //             if (!remoteScreenVideo.srcObject.getTrackById(track.id)) { // Avoid duplicates
        //                 remoteScreenVideo.srcObject.addTrack(track);
        //                 ss_log(`Successfully added track ${track.id}. Total tracks: ${remoteScreenVideo.srcObject.getTracks().length}`);
        //             } else {
        //                 ss_log(`Track ${track.id} already present in remoteScreenVideo. Not re-adding.`, "info");
        //             }
        //         } catch (addTrackError) {
        //             ss_log(`Error adding track ${track.id} to remoteScreenVideo: ${addTrackError.name} - ${addTrackError.message}`, "error");
        //             return;
        //         }
                
        //         remoteScreenVideo.play().catch(playError => {
        //             ss_log(`remoteScreenVideo.play() error: ${playError.name} - ${playError.message}`, "warn");
        //         });

        //         if (track.kind === 'video') {
        //             // We don't change ss_sharingState here based on incoming tracks anymore.
        //             // ss_sharingState is for LOCAL actions. The fact that we are receiving is handled by isCurrentlyReceiving (derived in ss_updateShareUI).
        //             ss_log(`Remote video track ${track.id} is now active. UI update will be handled by ss_updateShareUI call.`);
        //         }

        //         if (!ss_remoteStream || ss_remoteStream !== remoteScreenVideo.srcObject) {
        //             ss_remoteStream = remoteScreenVideo.srcObject;
        //         }
                
        //         track.onended = () => {
        //             ss_log(`Remote screen share track (kind: ${track.kind}, ID: ${track.id}) ended.`);
        //             if (ss_transceivers.video && ss_transceivers.video.receiver && ss_transceivers.video.receiver.track === track) {
        //                 ss_log(`Cleared plugin reference to video receiver track ${track.id} as it ended.`);
        //                 // ss_transceivers.video.receiver.track = null; 
        //             } else if (ss_transceivers.audio && ss_transceivers.audio.receiver && ss_transceivers.audio.receiver.track === track) {
        //                 ss_log(`Cleared plugin reference to audio receiver track ${track.id} as it ended.`);
        //                 // ss_transceivers.audio.receiver.track = null;
        //             }
        //             if (remoteScreenVideo && remoteScreenVideo.srcObject) {
        //                 const trackToRemove = remoteScreenVideo.srcObject.getTrackById(track.id);
        //                 if (trackToRemove) {
        //                     remoteScreenVideo.srcObject.removeTrack(trackToRemove);
        //                     ss_log(`Removed track ${track.id} from remoteScreenVideo.srcObject.`);
        //                     if (remoteScreenVideo.srcObject.getTracks().length === 0) {
        //                         remoteScreenVideo.srcObject = null;
        //                         ss_log("Cleared remoteScreenVideo.srcObject as no tracks are left.");
        //                         if (ss_remoteStream) ss_remoteStream = null;
        //                         ss_log("Resetting plugin's managed transceiver references as all remote tracks ended (receiver).");
        //                         ss_transceivers.video = null;
        //                         ss_transceivers.audio = null;
        //                         // ss_sharingState is not changed here based on remote tracks ending.
        //                         // If local user was sharing, they continue to be in 'sharing' state until they stop.
        //                         // If they were 'idle', they remain 'idle'.
        //                     }
        //                 }
        //             }
        //             ss_updateShareUI();
        //         };
        //         ss_updateShareUI();
        //         ss_populateAudioOutputDevices(); 
        //     } else {
        //         ss_log(`Track (kind: ${track.kind}, ID: ${track.id}) not identified as screen share for remoteScreenVideo.`);
        //     }
        // };
        // ss_log('pc.ontrack handler set.'); // Also comment this log if the handler is removed.
        ss_log('pc.ontrack handler in ScreenSharePlugin is disabled. Plugin will rely on core for track dispatch via custom events (TODO).');

    } else {
        ss_log('setupPeerConnectionEventHandlers: pc object not available. Cannot set handlers.', 'warn');
    }
}


function initScreenShare() {
    ss_log('initScreenShare() called.');
    // ss_peerConnection = pc; // Use the global pc from core.js - This will be set in datachannel-ready

    startScreenShareButton = document.getElementById('start-screen-share-button');
    // ... (rest of element fetching)
    stopScreenShareButton = document.getElementById('stop-screen-share-button');
    screenResolutionSelect = document.getElementById('screen-resolution-select');
    screenFramerateSelect = document.getElementById('screen-framerate-select');
    screenShareStatus = document.getElementById('screen-share-status');
    remoteScreenVideo = document.getElementById('remote-screen-video'); 
    screenAudioOutputSelect = document.getElementById('screen-audio-output-select');
    screenOutputVolumeSlider = document.getElementById('screen-output-volume-slider');
    toggleViewScreenShareButton = document.getElementById('toggle-view-screen-share-button');


    if (!ss_peerConnection) ss_log("PeerConnection (pc) not available at init time.", 'error'); // Log if pc isn't there
    if (!startScreenShareButton || !stopScreenShareButton || !screenShareStatus || !remoteScreenVideo) {
        ss_log("One or more critical UI elements are missing. Screen share plugin may not function correctly.", 'error');
        return; 
    }
    // ... (other checks for non-critical elements)

    const ssControlsSection = document.getElementById('screen-share-controls');
    if (ssControlsSection) ssControlsSection.style.display = 'block';
    else ss_log('Screen share controls section not found.', 'warn');

    // Setup for audio output selection, volume, toggle view (as before)
    if (screenAudioOutputSelect && remoteScreenVideo) { /* ... as before ... */ 
        ss_populateAudioOutputDevices(); 
        screenAudioOutputSelect.onchange = async () => {
            const selectedDeviceId = screenAudioOutputSelect.value;
            if (typeof remoteScreenVideo.setSinkId === 'function') {
                try { await remoteScreenVideo.setSinkId(selectedDeviceId); ss_addMessageToChat("--- Screen share speaker changed. ---", "system");}
                catch (error) { ss_log(`Error setting sinkId: ${error.name}`, 'error'); ss_addMessageToChat(`--- Error changing speaker: ${error.message}. ---`, "error"); await ss_populateAudioOutputDevices(); }
            } else { ss_addMessageToChat("--- Speaker selection not supported. ---", "system");}
        };
        if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange) {
            navigator.mediaDevices.ondevicechange = () => { ss_populateAudioOutputDevices(); };
        }
    }
    if (screenOutputVolumeSlider && remoteScreenVideo) { /* ... as before ... */ 
        screenOutputVolumeSlider.oninput = function() { remoteScreenVideo.volume = this.value; };
        remoteScreenVideo.volume = screenOutputVolumeSlider.value;
    }
    if (toggleViewScreenShareButton && remoteScreenVideo) { /* ... as before ... */ 
        toggleViewScreenShareButton.onclick = () => {
            if (!remoteScreenVideo.srcObject || !remoteScreenVideo.srcObject.getTracks().some(t=>t.readyState === 'live')) return;
            remoteScreenVideo.muted = !remoteScreenVideo.muted;
            ss_addMessageToChat(`--- Screen share view ${remoteScreenVideo.muted ? 'muted' : 'unmuted'}. ---`, "system");
            ss_updateShareUI(); 
        };
    }


    // Start Sharing Logic (onclick handler as defined in previous step, with its try-catch blocks)
    if (startScreenShareButton) { startScreenShareButton.onclick = async () => { /* ... as before ... */ 
        ss_log('Start Sharing button clicked.');
        if (ss_sharingState === 'sharing' || ss_isNegotiating || (ss_peerConnection && ss_peerConnection.signalingState !== 'stable' && ss_peerConnection.signalingState !== 'have-nothing')) {
            ss_log(`Cannot start sharing. State: ${ss_sharingState}, Negotiating: ${ss_isNegotiating}, PC State: ${ss_peerConnection ? ss_peerConnection.signalingState : 'N/A'}`, 'warn');
            ss_addMessageToChat("--- Cannot start screen share: system busy or already sharing. ---", "system");
            ss_updateShareUI(); return;
        }
        if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') {
            ss_log("Data channel not open.", 'warn'); ss_addMessageToChat("--- P2P connection not ready. ---", "error"); return;
        }
        const requestedResolution = screenResolutionSelect ? screenResolutionSelect.value : 'auto';
        const requestedFramerate = screenFramerateSelect ? screenFramerateSelect.value : 'auto';
        let videoConstraints = true; 
        if (requestedResolution !== 'auto' || requestedFramerate !== 'auto') { 
            videoConstraints = {};
            if (requestedResolution === '1080p') videoConstraints.height = { ideal: 1080 };
            else if (requestedResolution === '720p') videoConstraints.height = { ideal: 720 };
            else if (requestedResolution === '480p') videoConstraints.height = { ideal: 480 };
            if (requestedFramerate !== 'auto') videoConstraints.frameRate = { ideal: parseInt(requestedFramerate, 10) };
        }
        ss_log(`Requesting screen capture with constraints: ${JSON.stringify(videoConstraints)}`);
        ss_isNegotiating = true; ss_updateShareUI(); 
        try {
            ss_localStream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: true });
            if (!ss_localStream) throw new Error("User cancelled or no stream.");
            ss_log("Stream acquired.");
            if (ss_localStream.getVideoTracks().length > 0) {
                 const s = ss_localStream.getVideoTracks()[0].getSettings();
                 ss_log(`Actual video track settings: ${s.width}x${s.height}, ${s.frameRate ? s.frameRate.toFixed(2) : 'N/A'}fps`);
                 ss_addMessageToChat(`--- Streaming at ~${s.width}x${s.height}${s.frameRate ? ', '+s.frameRate.toFixed(0)+'fps':''} ---`, "local");
            }
            ss_localStream.getVideoTracks()[0].onended = () => { 
                ss_log("Sharing stopped via browser UI.");
                if (ss_sharingState === 'sharing') {
                    if (typeof sendDataChannelMessage === 'function') sendDataChannelMessage({ type: 'screen_share_stop' });
                    if (stopScreenShareButton && stopScreenShareButton.onclick) stopScreenShareButton.onclick();
                }
            };
            if (!ss_peerConnection) throw new Error("PeerConnection not available.");
            const videoTrack = ss_localStream.getVideoTracks()[0]; const audioTrack = ss_localStream.getAudioTracks()[0];
            try { 
                if (videoTrack) {
                    if (ss_transceivers.video) await ss_transceivers.video.sender.replaceTrack(videoTrack);
                    else ss_transceivers.video = ss_peerConnection.addTransceiver(videoTrack, { direction: 'sendrecv', streams: [ss_localStream] });
                }
                if (audioTrack) {
                    if (ss_transceivers.audio) await ss_transceivers.audio.sender.replaceTrack(audioTrack);
                    else ss_transceivers.audio = ss_peerConnection.addTransceiver(audioTrack, { direction: 'sendrecv', streams: [ss_localStream] });
                }
            } catch (transceiverError) { throw transceiverError; }
            const offer = await ss_peerConnection.createOffer(); await ss_peerConnection.setLocalDescription(offer);
            if (typeof sendDataChannelMessage === 'function') {
                sendDataChannelMessage({ type: 'screen_share_offer', offer: ss_peerConnection.localDescription, resolution: requestedResolution, framerate: requestedFramerate });
                ss_sharingState = 'sharing'; ss_log("Offer sent."); ss_addMessageToChat("--- Screen sharing offer sent. ---", "system");
            } else { throw new Error("sendDataChannelMessage not available."); }
        } catch (error) {
            ss_log(`Error starting screen share: ${error.name} - ${error.message}`, 'error', error);
            let userMessage = `--- Error starting screen sharing: ${error.message}. ---`;
            if (error.name === 'NotAllowedError') userMessage = "--- Screen sharing permission denied. ---";
            else if (error.name === 'NotFoundError') userMessage = "--- No screen/window found/selected. ---";
            ss_addMessageToChat(userMessage, "error");
            if (ss_localStream) { ss_localStream.getTracks().forEach(track => track.stop()); ss_localStream = null; }
            ss_sharingState = 'idle'; 
        } finally { ss_isNegotiating = false; ss_updateShareUI(); }
    };}

    // Stop Sharing Logic (onclick handler as defined, with its try-catch blocks for transceiver track nulling)
    if (stopScreenShareButton) { stopScreenShareButton.onclick = async () => { /* ... as before ... */ 
        if (ss_sharingState !== 'sharing') return;
        ss_log("Stop Sharing button clicked.");
        if (typeof sendDataChannelMessage === 'function') sendDataChannelMessage({ type: 'screen_share_stop' });
        if (ss_localStream) { ss_localStream.getTracks().forEach(track => track.stop()); ss_localStream = null; }
        try {
            if (ss_transceivers.video && ss_transceivers.video.sender.track) await ss_transceivers.video.sender.replaceTrack(null);
            if (ss_transceivers.audio && ss_transceivers.audio.sender.track) await ss_transceivers.audio.sender.replaceTrack(null);
        } catch (e) { ss_log(`Error nullifying tracks: ${e.name}`, "error", e); }
        
        ss_log("Resetting sender's plugin managed transceiver references.");
        ss_transceivers.video = null;
        ss_transceivers.audio = null;
        ss_sharingState = 'idle'; 
        ss_addMessageToChat("--- Screen sharing stopped locally. ---", "system"); 
        ss_updateShareUI();
    };}

    // Event Listeners
    document.addEventListener('datachannel-ready', () => {
        ss_log('Datachannel-ready event received.');
        // Assign pc to ss_peerConnection here, as pc should be initialized by now.
        ss_peerConnection = pc; 

        if (ss_peerConnection) {
            ss_log(`Inside datachannel-ready: pc object IS available. SignalingState: ${ss_peerConnection.signalingState}`);
            // Check if handlers are already set by looking for our custom flag or a specific handler
            // setupPeerConnectionEventHandlers is idempotent due to the _ss_onsignalingstatechange_set flag
            setupPeerConnectionEventHandlers(); 
        } else {
            ss_log('Inside datachannel-ready: pc object is NOT available even after assignment attempt.', 'error');
        }
        ss_populateAudioOutputDevices(); 
        ss_updateShareUI(); 
        ss_log('Datachannel-ready: Finished processing event.');
    });

    document.addEventListener('core-message-received', async (event) => { /* ... (as before, with robust error handling) ... */ 
        if (!ss_peerConnection) { ss_log("Core-message, but pc not init.", 'error'); return; }
        const { type, ...payload } = event.detail;
        switch (type) {
            case 'screen_share_offer':
                if (ss_isNegotiating || (ss_peerConnection.signalingState !== 'stable' && ss_peerConnection.signalingState !== 'have-remote-offer')) {
                    ss_log(`Offer ignored: busy (negotiating: ${ss_isNegotiating}, pc.state: ${ss_peerConnection.signalingState}).`, 'warn'); return;
                }
                ss_log(`Handling offer. Resolution: ${payload.resolution}, Framerate: ${payload.framerate}`);
                ss_isNegotiating = true; ss_updateShareUI();
                try {
                    await ss_peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
                    const answer = await ss_peerConnection.createAnswer(); await ss_peerConnection.setLocalDescription(answer);
                    if (typeof sendDataChannelMessage === 'function') {
                        sendDataChannelMessage({ type: 'screen_share_answer', answer: ss_peerConnection.localDescription });
                        ss_addMessageToChat(`--- Peer ${payload.username || 'User'} started screen sharing. ---`, "system");
                        ss_populateAudioOutputDevices(); 
                    } else { throw new Error("sendDataChannelMessage not available."); }
                } catch (error) {
                    ss_log(`Error handling offer: ${error.name} - ${error.message}`, 'error', error);
                    ss_addMessageToChat(`--- Error processing offer: ${error.message}. ---`, "error");
                } finally { ss_isNegotiating = false; ss_updateShareUI(); }
                break;
            case 'screen_share_answer':
                if (ss_peerConnection.signalingState !== 'have-local-offer' && !(ss_isNegotiating && ss_peerConnection.signalingState === 'stable')) { 
                    ss_log(`Answer ignored: unexpected state (pc.state: ${ss_peerConnection.signalingState}, negotiating: ${ss_isNegotiating}).`, 'warn'); return;
                }
                ss_log('Handling answer.');
                try {
                    await ss_peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
                    ss_addMessageToChat(`--- Peer ${payload.username || 'User'} accepted screen share. ---`, "system");
                } catch (error) {
                    ss_log(`Error handling answer: ${error.name} - ${error.message}`, 'error', error);
                    ss_addMessageToChat(`--- Error finalizing share: ${error.message}. ---`, "error");
                    if (ss_sharingState === 'sharing' && stopScreenShareButton && stopScreenShareButton.onclick) stopScreenShareButton.onclick();
                } finally { if (ss_peerConnection.signalingState === 'stable') ss_isNegotiating = false; ss_updateShareUI(); }
                break;
            case 'screen_share_stop': 
                ss_log(`Handling stop from peer ${payload.username || 'User'}.`);
                if (remoteScreenVideo && remoteScreenVideo.srcObject) {
                    remoteScreenVideo.srcObject.getTracks().forEach(track => track.stop()); remoteScreenVideo.srcObject = null;
                }
                if (ss_remoteStream) { ss_remoteStream.getTracks().forEach(track => track.stop()); ss_remoteStream = null; }
                
                // Explicitly nullifying conceptual track references from previous step is fine.
                // Now, also reset the main transceiver holders for the receiver.
                ss_log("Resetting plugin's managed transceiver references on screen_share_stop (receiver).");
                ss_transceivers.video = null;
                ss_transceivers.audio = null;
                // ss_sharingState is not changed here based on remote peer stopping.
                // If local user was sharing, they continue to be in 'sharing' state.
                // If they were 'idle', they remain 'idle'.
                ss_addMessageToChat(`--- Peer ${payload.username || 'User'} stopped screen sharing. ---`, "system");
                ss_updateShareUI();
                break;
        }
    });
    
    ss_log("Attempting to set up PC event handlers during init.");
    setupPeerConnectionEventHandlers(); // Initial attempt to set handlers

    ss_log('Initialization complete.');
    ss_updateShareUI(); 
}

if (typeof log !== 'function') { /* ... (fallback log definition as before) ... */ 
    window.log = (message, level = 'info', ...args) => { 
        const prefix = "[FallbackLog]";
        switch (level) {
            case 'error': console.error(`${prefix} ${message}`, ...args); break;
            case 'warn': console.warn(`${prefix} ${message}`, ...args); break;
            default: console.log(`${prefix} ${message}`, ...args); break;
        }
    };
    ss_log("Global 'log' function was not available. Using fallback console logger for ScreenSharePlugin.", "warn");
}
ss_log("ScreenShare.js: Parsed. Waiting for initScreenShare() call.");
