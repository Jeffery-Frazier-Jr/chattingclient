'use strict';

// Voice Chat Plugin
// Depends on core.js for:
// - log(message)
// - addMessageToChat(messageText, messageType, timestamp)
// - sendDataChannelMessage(messageObject)
// - pc (RTCPeerConnection instance from core.js)
// - remoteAudioElement (global from core.js)
// - PEER_USERNAME, USERNAME (globals from core.js/chat.html)
// - dataChannel (global from core.js for sending messages)
// - initializePeerConnection (if needed to ensure pc is ready, though core.js should handle)

// Plugin-specific state variables
let vc_localAudioStream = null;
let vc_callState = 'idle'; // idle, calling, offer_sent, ringing, active
let vc_incomingCallOfferDetails = null; // { offer: RTCSessionDescription, peerUsername: string, callId: string }
let vc_currentCallId = null; // To track a specific call instance

// UI Elements (will be fetched in initVoiceChat)
let vc_callButton, vc_hangupButton, vc_acceptCallButton, vc_rejectCallButton;
let vc_callStatus, vc_audioInputSelect, vc_audioOutputSelect, vc_outputVolumeSlider;


function vc_updateCallUI() {
    // vc_callState is global to this plugin's scope
    log(`VoiceChatPlugin: vc_updateCallUI() called. Current call state: ${vc_callState}`);

    if (!vc_callButton || !vc_hangupButton || !vc_acceptCallButton || !vc_rejectCallButton || !vc_callStatus) {
        log("VoiceChatPlugin: Call UI elements not all found in vc_updateCallUI. Skipping UI update.");
        return;
    }

    vc_callButton.style.display = 'none';
    vc_hangupButton.style.display = 'none';
    vc_acceptCallButton.style.display = 'none';
    vc_rejectCallButton.style.display = 'none';

    // Access dataChannel from core.js's scope
    const isDataChannelReady = typeof dataChannel !== 'undefined' && dataChannel && dataChannel.readyState === 'open';

    switch (vc_callState) {
        case 'idle':
            vc_callButton.style.display = 'inline-block';
            vc_callButton.disabled = !isDataChannelReady;
            vc_callStatus.textContent = isDataChannelReady ? "Idle" : "Idle (P2P not ready)";
            vc_callButton.title = isDataChannelReady ? "Call Peer" : "P2P connection not ready for calling.";
            break;
        case 'calling':
            vc_hangupButton.style.display = 'inline-block';
            vc_callStatus.textContent = `Calling ${PEER_USERNAME || 'Peer'}...`;
            break;
        case 'offer_sent':
            vc_hangupButton.style.display = 'inline-block';
            vc_callStatus.textContent = `Offer sent to ${PEER_USERNAME || 'Peer'}. Waiting...`;
            break;
        case 'ringing':
            vc_acceptCallButton.style.display = 'inline-block';
            vc_rejectCallButton.style.display = 'inline-block';
            vc_callStatus.textContent = `Incoming call from ${vc_incomingCallOfferDetails ? vc_incomingCallOfferDetails.peerUsername : (PEER_USERNAME || 'Peer')}`;
            break;
        case 'active':
            vc_hangupButton.style.display = 'inline-block';
            vc_callStatus.textContent = `Call active with ${PEER_USERNAME || 'Peer'}`;
            break;
        default:
            vc_callStatus.textContent = "Unknown";
            vc_callButton.style.display = 'none'; // Default to hidden if state is unknown
            vc_callButton.disabled = true;
            break;
    }
    // Example logs for button visibility
    if(vc_callButton) log(`VoiceChatPlugin: vc_updateCallUI - Call button display: ${vc_callButton.style.display}`);
    if(vc_hangupButton) log(`VoiceChatPlugin: vc_updateCallUI - Hangup button display: ${vc_hangupButton.style.display}`);
}

async function vc_populateAudioDevices() {
    log("VoiceChatPlugin: vc_populateAudioDevices() called.");
    if (!vc_audioInputSelect || !vc_audioOutputSelect) {
        log("VoiceChatPlugin: Audio select elements not found for vc_populateAudioDevices.");
        return;
    }

    vc_audioInputSelect.innerHTML = '<option value="">Default Input</option>';
    vc_audioOutputSelect.innerHTML = '<option value="">Default Output</option>';

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            if (device.kind === 'audioinput') {
                option.text = device.label || `Microphone ${vc_audioInputSelect.length}`;
                vc_audioInputSelect.appendChild(option);
            } else if (device.kind === 'audiooutput') {
                option.text = device.label || `Speaker ${vc_audioOutputSelect.length}`;
                vc_audioOutputSelect.appendChild(option);
            }
        });
        log("VoiceChat Plugin: Audio devices populated.");
    } catch (error) {
        log(`VoiceChat Plugin: Error populating audio devices: ${error}`);
        if (typeof addMessageToChat === 'function') addMessageToChat("--- Error listing audio devices. ---", "system");
    }
}

async function vc_getLocalAudioStream(deviceId = null) {
    log(`VoiceChatPlugin: vc_getLocalAudioStream() called with deviceId: ${deviceId}`);
    if (vc_localAudioStream) {
        log("VoiceChatPlugin: Stopping existing local audio stream tracks before acquiring new one.");
        vc_localAudioStream.getTracks().forEach(track => track.stop());
        vc_localAudioStream = null;
    }
    try {
        const constraints = deviceId ? { audio: { deviceId: { exact: deviceId } }, video: false } : { audio: true, video: false };
        vc_localAudioStream = await navigator.mediaDevices.getUserMedia(constraints);
        log("VoiceChat Plugin: Local audio stream acquired.");
        return vc_localAudioStream;
    } catch (error) {
        log(`VoiceChat Plugin: Error getting local audio stream: ${error}`);
        console.error("getUserMedia error (VC Plugin):", error);
        if (typeof addMessageToChat === 'function') addMessageToChat("--- Error accessing microphone. Please check permissions. ---", "system");
        vc_localAudioStream = null;
        return null;
    }
}

function vc_cleanupCall() {
    log("VoiceChat Plugin: Cleaning up call resources.");
    if (vc_localAudioStream) {
        vc_localAudioStream.getTracks().forEach(track => track.stop());
        vc_localAudioStream = null;
        log("VoiceChat Plugin: Local audio stream stopped.");
    }
    // remoteAudioElement is global from core.js
    if (typeof remoteAudioElement !== 'undefined' && remoteAudioElement && remoteAudioElement.srcObject) {
        remoteAudioElement.srcObject.getTracks().forEach(track => track.stop());
        remoteAudioElement.srcObject = null;
        remoteAudioElement.pause();
        remoteAudioElement.currentTime = 0;
        log("VoiceChat Plugin: Remote audio stream stopped.");
    }
    // pc is global from core.js
    if (typeof pc !== 'undefined' && pc) {
        pc.getSenders().forEach(sender => {
            if (sender.track && sender.track.kind === 'audio') {
                try { pc.removeTrack(sender); log("VoiceChat Plugin: Removed audio track from RTCPeerConnection."); }
                catch (e) { log(`VoiceChat Plugin: Error removing audio track: ${e}`); }
            }
        });
        // Potentially reset parts of pc if needed for future calls, e.g., renegotiation logic.
        // For now, just removing tracks. If createOffer is called again, new transceivers will be made.
    }
    vc_incomingCallOfferDetails = null;
    vc_currentCallId = null;
}


function initVoiceChat() {
    if (typeof log !== 'function') { console.error("VoiceChatPlugin: Core 'log' function not available."); return; }
    log('VoiceChatPlugin: initVoiceChat() called.');

    vc_callButton = document.getElementById('call-button');
    vc_hangupButton = document.getElementById('hangup-button');
    vc_acceptCallButton = document.getElementById('accept-call-button');
    vc_rejectCallButton = document.getElementById('reject-call-button');
    vc_callStatus = document.getElementById('call-status');
    vc_audioInputSelect = document.getElementById('audio-input-select');
    vc_audioOutputSelect = document.getElementById('audio-output-select');
    vc_outputVolumeSlider = document.getElementById('output-volume-slider');
    // vc_remoteAudioElement is already global (remoteAudioElement from core.js)

    if (!vc_callButton || !vc_hangupButton || !vc_acceptCallButton || !vc_rejectCallButton || !vc_callStatus ||
        !vc_audioInputSelect || !vc_audioOutputSelect || !vc_outputVolumeSlider || typeof remoteAudioElement === 'undefined') {
        log("VoiceChatPlugin: Not all required UI elements found during init. Voice chat may not function correctly.");
        // return; // Decide if this is fatal or if parts can work
    }

    vc_updateCallUI(); // Initial UI setup based on vc_callState
    log('VoiceChatPlugin: vc_updateCallUI() called.');
    vc_populateAudioDevices();
    log('VoiceChatPlugin: vc_populateAudioDevices() called.');

    // Event Listeners for Call Control Buttons
    if (vc_callButton) {
        vc_callButton.onclick = async () => {
            log('VoiceChatPlugin: Call button clicked.'); // Added log
            if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') {
                log("VoiceChatPlugin: Call button clicked, but dataChannel not open.");
                if (typeof addMessageToChat === 'function') addMessageToChat("--- P2P connection not ready for calling. ---", "system");
                return;
            }
            if (vc_callState !== 'idle') { log("VoiceChatPlugin: Call button clicked but state not idle."); return; }

            vc_callState = 'calling';
            // vc_updateCallUI(); // Called at the end of the try-catch block or on error
            vc_currentCallId = `call-${USERNAME}-${Date.now()}`; // USERNAME from core/global
            log(`VoiceChatPlugin: Initiating call. ID: ${vc_currentCallId}`);

            if (!await vc_getLocalAudioStream()) {
                log("VoiceChatPlugin: Failed to get local audio stream for outgoing call.");
                if (typeof addMessageToChat === 'function') addMessageToChat("--- Could not start call: Mic access failed. ---", "system");
                vc_callState = 'idle'; vc_updateCallUI(); vc_currentCallId = null; return;
            }

            if (typeof pc === 'undefined' || !pc) { // pc from core.js
                if (typeof initializePeerConnection === 'function') initializePeerConnection(); 
                if (typeof pc === 'undefined' || !pc) {
                    log("VoiceChatPlugin: PeerConnection not available.");
                    if (typeof addMessageToChat === 'function') addMessageToChat("--- Could not start call: P2P not ready. ---", "system");
                    vc_callState = 'idle'; vc_updateCallUI(); vc_currentCallId = null; return;
                }
            }

            try {
                let audioTrackSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (audioTrackSender && vc_localAudioStream.getAudioTracks().length > 0) {
                    await audioTrackSender.replaceTrack(vc_localAudioStream.getAudioTracks()[0]);
                } else if (vc_localAudioStream.getAudioTracks().length > 0) {
                    vc_localAudioStream.getTracks().forEach(track => pc.addTrack(track, vc_localAudioStream));
                } else { throw new Error("No audio track available."); }

                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                vc_callState = 'offer_sent';
                sendDataChannelMessage({ type: 'voice_call_offer', offer: pc.localDescription, callId: vc_currentCallId }); 
                log("VoiceChatPlugin: Voice call offer sent.");
            } catch (error) {
                log(`VoiceChatPlugin: Error during call initiation: ${error}`);
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error starting call: ${error.message}. ---`, "system");
                vc_cleanupCall(); vc_callState = 'idle'; 
            }
            vc_updateCallUI(); // Update UI after state changes / potential errors
        };
    }

    if (vc_hangupButton) {
        vc_hangupButton.onclick = () => {
            log("VoiceChatPlugin: Hangup button clicked.");
            if (vc_callState === 'idle') { log("VoiceChatPlugin: Hangup clicked but already idle."); return; }
            
            sendDataChannelMessage({ type: 'voice_call_hangup', callId: vc_currentCallId });
            log(`VoiceChatPlugin: Sent voice_call_hangup for callId: ${vc_currentCallId}.`);
            
            const message = (vc_callState === 'ringing' && vc_incomingCallOfferDetails) ? `--- Call from ${vc_incomingCallOfferDetails.peerUsername} rejected by local user action (hangup). ---` : "--- Call ended by local user. ---";
            if (typeof addMessageToChat === 'function') addMessageToChat(message, "system");
            
            vc_cleanupCall();
            vc_callState = 'idle';
            vc_updateCallUI();
        };
    }

    if (vc_acceptCallButton) {
        vc_acceptCallButton.onclick = async () => {
            log("VoiceChatPlugin: Accept call button clicked.");
            if (vc_callState !== 'ringing' || !vc_incomingCallOfferDetails) {
                log("VoiceChatPlugin: Accept clicked but not ringing or no offer details."); return;
            }

            if (!await vc_getLocalAudioStream()) {
                log("VoiceChatPlugin: Failed to get local audio stream for incoming call.");
                if (typeof addMessageToChat === 'function') addMessageToChat("--- Could not accept call: Mic access failed. ---", "system");
                sendDataChannelMessage({ type: 'voice_call_reject', callId: vc_incomingCallOfferDetails.callId, reason: 'media_error' });
                vc_cleanupCall(); vc_callState = 'idle'; vc_updateCallUI(); return;
            }

            if (typeof pc === 'undefined' || !pc) {
                 log("VoiceChatPlugin: PeerConnection not available to accept call.");
                 if (typeof addMessageToChat === 'function') addMessageToChat("--- Could not accept call: P2P not ready. ---", "system");
                 sendDataChannelMessage({ type: 'voice_call_reject', callId: vc_incomingCallOfferDetails.callId, reason: 'p2p_error' });
                 vc_cleanupCall(); vc_callState = 'idle'; vc_updateCallUI(); return;
            }

            try {
                let audioTrackSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (audioTrackSender && vc_localAudioStream.getAudioTracks().length > 0) {
                    await audioTrackSender.replaceTrack(vc_localAudioStream.getAudioTracks()[0]);
                } else if (vc_localAudioStream.getAudioTracks().length > 0) {
                    vc_localAudioStream.getTracks().forEach(track => pc.addTrack(track, vc_localAudioStream));
                } else { throw new Error("No audio track available for accept."); }

                await pc.setRemoteDescription(new RTCSessionDescription(vc_incomingCallOfferDetails.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);

                sendDataChannelMessage({ type: 'voice_call_answer', answer: pc.localDescription, callId: vc_incomingCallOfferDetails.callId });
                vc_currentCallId = vc_incomingCallOfferDetails.callId; 
                log("VoiceChatPlugin: Voice call answer sent.");
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Call with ${vc_incomingCallOfferDetails.peerUsername} accepted and now active. ---`, "system");
                
                vc_callState = 'active'; 
                vc_incomingCallOfferDetails = null; 
            } catch (error) {
                log(`VoiceChatPlugin: Error during call acceptance: ${error}`);
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error accepting call: ${error.message}. ---`, "system");
                sendDataChannelMessage({ type: 'voice_call_reject', callId: vc_incomingCallOfferDetails.callId, reason: 'error_during_accept' });
                vc_cleanupCall(); vc_callState = 'idle'; 
            }
            vc_updateCallUI(); // Update UI after state changes / potential errors
        };
    }
    
    if (vc_rejectCallButton) {
        vc_rejectCallButton.onclick = () => {
            log("VoiceChatPlugin: Reject call button clicked.");
            if (vc_callState !== 'ringing' || !vc_incomingCallOfferDetails) {
                log("VoiceChatPlugin: Reject clicked but not ringing or no details."); return;
            }
            sendDataChannelMessage({ type: 'voice_call_reject', callId: vc_incomingCallOfferDetails.callId, reason: 'rejected_by_user' });
            log(`VoiceChatPlugin: Sent voice_call_reject for callId: ${vc_incomingCallOfferDetails.callId}.`);
            if (typeof addMessageToChat === 'function') addMessageToChat(`--- Call from ${vc_incomingCallOfferDetails.peerUsername} rejected. ---`, "system");
            vc_cleanupCall(); 
            vc_callState = 'idle';
            vc_updateCallUI();
        };
    }

    // Audio device and volume controls
    if (vc_audioInputSelect) {
        vc_audioInputSelect.onchange = async () => {
            const selectedDeviceId = vc_audioInputSelect.value;
            log(`VoiceChatPlugin: Audio input device changed to: ${selectedDeviceId}`);
            if (!await vc_getLocalAudioStream(selectedDeviceId)) {
                log("VoiceChatPlugin: Failed to switch audio input.");
                if (typeof addMessageToChat === 'function') addMessageToChat("--- Failed to switch microphone. ---", "system");
                await vc_populateAudioDevices(); return;
            }
            if (vc_callState === 'active' && pc && vc_localAudioStream) {
                const audioTrack = vc_localAudioStream.getAudioTracks()[0];
                if (audioTrack) {
                    const audioSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (audioSender) {
                        try { await audioSender.replaceTrack(audioTrack); log("VoiceChatPlugin: Audio track replaced."); if (typeof addMessageToChat === 'function') addMessageToChat("--- Microphone changed. ---", "system"); }
                        catch (error) { log(`VoiceChatPlugin: Error replacing audio track: ${error}`); if (typeof addMessageToChat === 'function') addMessageToChat("--- Error switching microphone. ---", "system");}
                    } else { 
                        log("VoiceChatPlugin: No existing audio sender found, adding new track.");
                        pc.addTrack(audioTrack, vc_localAudioStream); 
                    }
                }
            }
            await vc_populateAudioDevices(); 
        };
    }

    if (vc_audioOutputSelect && typeof remoteAudioElement !== 'undefined' && remoteAudioElement) {
        vc_audioOutputSelect.onchange = async () => {
            const selectedDeviceId = vc_audioOutputSelect.value;
            log(`VoiceChatPlugin: Audio output device changed to: ${selectedDeviceId}`);
            if (typeof remoteAudioElement.setSinkId === 'function') {
                try { await remoteAudioElement.setSinkId(selectedDeviceId); log("VoiceChatPlugin: Audio output sink set."); if (typeof addMessageToChat === 'function') addMessageToChat("--- Speaker changed. ---", "system");}
                catch (error) { log(`VoiceChatPlugin: Error setting sinkId: ${error}`); if (typeof addMessageToChat === 'function') addMessageToChat("--- Error switching speaker. ---", "system"); await vc_populateAudioDevices(); }
            } else { log("VoiceChatPlugin: setSinkId not supported by browser."); if (typeof addMessageToChat === 'function') addMessageToChat("--- Speaker selection not supported. ---", "system");}
        };
    }

    if (vc_outputVolumeSlider && typeof remoteAudioElement !== 'undefined' && remoteAudioElement) {
        vc_outputVolumeSlider.oninput = function() {
            remoteAudioElement.volume = this.value;
        };
    }
    log('VoiceChatPlugin: Added event listeners for voice call UI elements and device selectors.');

    // Listen for voice call related messages from core.js
    // Voice call signaling messages (offer, answer, reject, hangup) are NOT encrypted control messages.
    // They are plain JSON objects sent over the data channel.
    document.addEventListener('core-message-received', (event) => {
        const { type, ...payload } = event.detail; // payload contains the rest of event.detail
        // Add a more specific log to distinguish this from other core-message-received listeners if needed
        log(`VoiceChatPlugin: core-message-received event, type: ${type}`);

        switch (type) {
            case 'voice_call_offer':
                log('VoiceChatPlugin: Handling voice_call_offer message.');
                if (vc_callState !== 'idle') {
                    log('VoiceChatPlugin: Received voice_call_offer but current callState is not idle. Sending busy.');
                    sendDataChannelMessage({ type: 'voice_call_reject', callId: payload.callId, reason: 'busy' });
                    return;
                }
                // Assuming PEER_USERNAME is correctly updated by core.js from username_exchange
                vc_incomingCallOfferDetails = { offer: payload.offer, peerUsername: PEER_USERNAME, callId: payload.callId };
                vc_callState = 'ringing';
                vc_currentCallId = payload.callId || `call-${Date.now()}`; // Fallback for callId
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Incoming voice call from ${PEER_USERNAME}. ---`, "system");
                vc_updateCallUI();
                vc_populateAudioDevices();
                break;
            case 'voice_call_answer':
                log('VoiceChatPlugin: Handling voice_call_answer message.');
                if (vc_callState === 'calling' || vc_callState === 'offer_sent') {
                    if (pc && payload.answer) { // pc is from core.js
                        pc.setRemoteDescription(new RTCSessionDescription(payload.answer))
                            .then(() => {
                                vc_callState = 'active';
                                vc_currentCallId = payload.callId || vc_currentCallId;
                                log(`VoiceChatPlugin: Call active. Remote description set for answer. Call ID: ${vc_currentCallId}`);
                                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Voice call with ${PEER_USERNAME} is now active. ---`, "system");
                                vc_updateCallUI();
                            })
                            .catch(error => {
                                log(`VoiceChatPlugin: Error setting remote description for answer: ${error}`);
                                if (typeof addMessageToChat === 'function') addMessageToChat("--- Error accepting call answer. ---", "system");
                                vc_cleanupCall(); // Use the helper
                                vc_callState = 'idle';
                                vc_updateCallUI();
                            });
                    } else { 
                        log("VoiceChatPlugin: Cannot process answer: pc or answer missing."); 
                        vc_cleanupCall(); vc_callState = 'idle'; vc_updateCallUI(); 
                    }
                } else { 
                    log(`VoiceChatPlugin: Received voice_call_answer in unexpected state: ${vc_callState}`);
                }
                break;
            case 'voice_call_reject':
                log('VoiceChatPlugin: Handling voice_call_reject message.');
                if (vc_callState === 'calling' || vc_callState === 'offer_sent' || (vc_callState === 'ringing' && payload.reason === 'busy_local')) {
                    vc_cleanupCall(); // Use the helper
                    vc_callState = 'idle';
                    if (typeof addMessageToChat === 'function') addMessageToChat(`--- Call rejected by ${PEER_USERNAME} (Reason: ${payload.reason || 'N/A'}). ---`, "system");
                    vc_updateCallUI();
                } else { 
                     log(`VoiceChatPlugin: Received voice_call_reject in unexpected state: ${vc_callState}`);
                }
                break;
            case 'voice_call_hangup':
                log('VoiceChatPlugin: Handling voice_call_hangup message.');
                if (vc_callState === 'active' || vc_callState === 'ringing') {
                    vc_cleanupCall(); // Use the helper
                    vc_callState = 'idle';
                    if (typeof addMessageToChat === 'function') addMessageToChat(`--- ${PEER_USERNAME} ended the voice call. ---`, "system");
                    vc_updateCallUI();
                } else {
                    log(`VoiceChatPlugin: Received voice_call_hangup in unexpected state: ${vc_callState}`);
                }
                break;
            // Voice ICE candidates are handled by core.js via WebSocket.
            // No 'voice_ice_candidate' type message is expected here via DataChannel based on current design.
            default:
                // This listener will receive all 'core-message-received' events.
                // It's important to only act on types it's responsible for.
                // log(`VoiceChatPlugin: Received unhandled message type via core-message-received: ${type}`);
                break;
        }
    });
    log('VoiceChatPlugin: Updated event listener to use core-message-received for voice signals.');
    
    // Listen for P2P disconnection from core.js to cleanup UI and state
    // This event name 'p2pdisconnected' needs to be dispatched by core.js on data channel close or ICE failure.
    // Assuming core.js will dispatch this.
    document.addEventListener('p2pdisconnected', () => {
        log("VoiceChatPlugin: Received p2pdisconnected event.");
        if (vc_callState !== 'idle') {
            if (typeof addMessageToChat === 'function') addMessageToChat("--- Call ended due to P2P connection loss. ---", "system");
            vc_cleanupCall();
            vc_callState = 'idle';
            vc_updateCallUI();
        }
    });


    if (typeof addMessageToChat === 'function') addMessageToChat("--- Voice Chat plugin initialized. ---", "system");
    
    // Make the voice call controls section visible
    const vcControlsSection = document.getElementById('voice-call-controls');
    if (vcControlsSection) {
        vcControlsSection.style.display = 'block'; // Or its original display style
        log(`VoiceChatPlugin: Attempted to show #voice-call-controls. Current display: ${vcControlsSection.style.display}`);
    } else {
        log("VoiceChatPlugin: Voice call controls section (#voice-call-controls) not found in DOM.");
    }

    log("VoiceChatPlugin: Initialization complete.");

    document.addEventListener('datachannel-ready', () => {
        log('VoiceChatPlugin: datachannel-ready event received. Updating call UI.');
        if (typeof vc_updateCallUI === 'function') { // Ensure function exists
            vc_updateCallUI();
        }
    });
    log('VoiceChatPlugin: Added listener for datachannel-ready event.');
}

log("VoiceChat.js: Parsed. Waiting for initVoiceChat() call from main.js.");
