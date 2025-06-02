'use strict';

// Global variables (moved from main.js or newly defined for core.js)
let PEER_USERNAME = "Peer"; // Default, will be updated
const rsaKeySize = 2048;
let myKeyPair = null;
let myPublicKeyPEM = null;
let myPrivateKeyPEM = null;
let peerPublicKeyPEM = null;

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks
const LARGE_FILE_THRESHOLD = 256 * 1024; // Files larger than 256 KB will be chunked
const MAX_FILE_SIZE_FOR_HASHING = 100 * 1024 * 1024; // 100MB

let localAudioStream = null;
let remoteAudioElement = null; // Will be created in DOMContentLoaded
let callState = 'idle'; // idle, calling, offer_sent, ringing, active
let incomingCallOfferDetails = null; // { offer: RTCSessionDescription, peerUsername: string }
let currentCallId = null;

let selectedFile = null; // Potentially for core handling if plugins don't manage their own state
let pendingFileTransfers = {};
let incomingFileTransfers = {};
let expectingFileDataForId = null;
let expectingFileChunkNum = undefined;

// Lightbox Modal Elements
let lightboxModal, lightboxImage;

// Core P2P and Signaling Variables
let pc = null;
let dataChannel = null;
let ws = null; // WebSocket connection
const iceServers = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] };


// Debug Logging Function
function log(message) {
    if (typeof DEBUG !== 'undefined' && DEBUG) {
        console.log("[DEBUG]", message);
    }
}

// RSA Key Generation Function
function generateRSAKeyPair() {
    log(`Generating RSA key pair (${rsaKeySize} bit)...`);
    try {
        myKeyPair = new JSEncrypt({ default_key_size: rsaKeySize });
        myPrivateKeyPEM = myKeyPair.getPrivateKey();
        myPublicKeyPEM = myKeyPair.getPublicKey();
        if (!myPrivateKeyPEM || !myPublicKeyPEM) {
            log("Error: RSA key pair generation failed. Keys are empty after generation attempt.");
            myKeyPair = null; myPrivateKeyPEM = null; myPublicKeyPEM = null;
        } else {
            log("RSA key pair generated successfully.");
        }
    } catch (error) {
        log(`Error during RSA key pair generation: ${error}`);
        console.error("RSA Key Generation Error: ", error);
        myKeyPair = null; myPrivateKeyPEM = null; myPublicKeyPEM = null;
    }
}

// Helper function to read Blob as ArrayBuffer
function readBlobAsArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result);
        };
        reader.onerror = (error) => {
            reject(error);
        };
        reader.readAsArrayBuffer(blob);
    });
}

// Helper function to calculate SHA-256 hash of a File or Blob
async function calculateFileHash(fileOrBlob) {
    if (!fileOrBlob) {
        log("Cannot calculate hash: fileOrBlob is null or undefined.");
        return null;
    }
    if (fileOrBlob.size > MAX_FILE_SIZE_FOR_HASHING) {
        log(`File size (${fileOrBlob.size} bytes) exceeds limit for hashing (${MAX_FILE_SIZE_FOR_HASHING} bytes). Skipping hash.`);
        return "hash_skipped_large_file";
    }
    try {
        const buffer = await fileOrBlob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        return hashHex;
    } catch (error) {
        log(`Error calculating file hash: ${error}`);
        console.error("Hash calculation error:", error);
        return null;
    }
}

// Function to add messages to the chat display area
function addMessageToChat(messageText, messageType, timestamp) {
    const chatArea = document.getElementById('chat-area');
    if (!chatArea) {
        log("Chat area not found, cannot add message: " + messageText);
        return;
    }
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    let formattedMessage = "";
    const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    if (messageType === 'system') {
        formattedMessage = `<em>${messageText}</em>`;
        messageElement.classList.add('system-message');
    } else if (messageType === 'sent') {
        formattedMessage = `[${time}] ${USERNAME}: ${messageText}`; // USERNAME is from global scope (chat.html)
        messageElement.classList.add('sent-message');
    } else if (messageType === 'received') {
        formattedMessage = `[${time}] ${PEER_USERNAME}: ${messageText}`;
        messageElement.classList.add('received-message');
    } else {
        formattedMessage = messageText; // Plain text
    }
    messageElement.innerHTML = formattedMessage;
    chatArea.appendChild(messageElement);
    chatArea.scrollTop = chatArea.scrollHeight;
}

// Helper function to send messages over the dataChannel
function sendDataChannelMessage(messageObject) {
    if (dataChannel && dataChannel.readyState === 'open') {
        try {
            const messageString = JSON.stringify(messageObject);
            dataChannel.send(messageString);
            log(`Sent data channel message: ${messageObject.type}`);
        } catch (error) {
            log(`Error sending data channel message: ${error}. Message: ${JSON.stringify(messageObject)}`);
            console.error("sendDataChannelMessage error:", error);
        }
    } else {
        log(`Cannot send data channel message: dataChannel not ready or not open. State: ${dataChannel ? dataChannel.readyState : 'null'}`);
    }
}


function initializePeerConnection() {
    if (pc) { log("PeerConnection already initialized."); return; }
    log("Initializing RTCPeerConnection...");
    const p2pStatusElement = document.getElementById('p2p-status');
    try {
        pc = new RTCPeerConnection(iceServers);
        if (p2pStatusElement && !p2pStatusElement.textContent.startsWith("Error:")) {
            p2pStatusElement.textContent = "Initializing P2P connection...";
        }
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                log(`Sending ICE candidate`);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate, room: ROOM_NAME })); // ROOM_NAME from global scope
                } else { log("WebSocket not open. Cannot send ICE candidate."); }
            } else { log("All ICE candidates have been sent."); }
        };
        pc.oniceconnectionstatechange = () => {
            if (!pc) return;
            const iceState = pc.iceConnectionState;
            log(`ICE connection state changed: ${iceState}`);
            if(p2pStatusElement) p2pStatusElement.textContent = `P2P Status: ${iceState}`;
            switch (iceState) {
                case "connected": log("ICE Connection: Connected."); break;
                case "disconnected":
                    log("ICE Disconnected. Resetting peer state."); PEER_USERNAME = "Peer"; peerPublicKeyPEM = null;
                    addMessageToChat("--- P2P Connection Lost. Waiting for peer to rejoin... ---", "system");
                    break;
                case "failed":
                    log("ICE Failed. Resetting peer state."); PEER_USERNAME = "Peer"; peerPublicKeyPEM = null;
                    addMessageToChat("--- P2P Connection Failed. Please refresh. ---", "system");
                    break;
                case "closed":
                    log("ICE Closed. Resetting peer state."); PEER_USERNAME = "Peer"; peerPublicKeyPEM = null;
                    addMessageToChat("--- P2P Connection Closed. Please refresh. ---", "system");
                    break;
            }
        };
        pc.ondatachannel = (event) => {
            log("Data channel received."); dataChannel = event.channel;
            setupDataChannelEvents(dataChannel);
        };
        pc.ontrack = (event) => {
            log(`Core pc.ontrack: Received remote track. Kind: ${event.track.kind}, ID: ${event.track.id}, Stream IDs: ${event.streams.map(s => s.id).join(', ')}`);
            const track = event.track;
            const stream = event.streams && event.streams.length > 0 ? event.streams[0] : null;

            if (!stream) {
                log("Core pc.ontrack: No stream associated with the track. Cannot process.", "warn");
                return;
            }

            let isVideoTrackPresentInStream = false;
            stream.getTracks().forEach(t => {
                if (t.kind === 'video') {
                    isVideoTrackPresentInStream = true;
                }
            });

            if (track.kind === 'audio') {
                if (isVideoTrackPresentInStream) {
                    log(`Core pc.ontrack: Dispatching screen share associated audio track ${track.id} to ScreenSharePlugin.`);
                    document.dispatchEvent(new CustomEvent('core-screenshare-audiotrack-received', { detail: { track, stream } }));
                } else {
                    // Assume it's voice chat audio
                    log(`Core pc.ontrack: Handling voice chat audio track ${track.id}.`);
                    if (remoteAudioElement) {
                        if (!remoteAudioElement.srcObject || remoteAudioElement.srcObject !== stream) {
                           remoteAudioElement.srcObject = stream;
                           log("Core pc.ontrack: Assigned stream to remote audio element for voice chat.");
                           remoteAudioElement.play().catch(e => log(`Error playing remote audio for voice chat: ${e.name} - ${e.message}`));
                        } else {
                           log("Core pc.ontrack: Voice chat audio track received for an already assigned stream.");
                        }
                    } else {
                        log("Core pc.ontrack: remoteAudioElement not found for voice chat.", "error");
                    }
                }
            } else if (track.kind === 'video') {
                log(`Core pc.ontrack: Dispatching screen share video track ${track.id} to ScreenSharePlugin.`);
                document.dispatchEvent(new CustomEvent('core-screenshare-videotrack-received', { detail: { track, stream } }));
            } else {
                log(`Core pc.ontrack: Received remote track of unhandled kind: ${track.kind}. Ignoring.`);
            }
        };
    } catch (error) {
        log(`RTCPeerConnection init error: ${error.toString()}`); console.error("RTCPeerConnection init error:", error);
        if (p2pStatusElement) p2pStatusElement.textContent = "P2P Initialization Error.";
        addMessageToChat("--- P2P Initialization Error ---", "system");
    }
}

async function createOffer() {
    if (!pc) { log("Cannot create offer: PC not init."); return; }
    if (pc.signalingState !== "stable") { log(`Cannot create offer in state: ${pc.signalingState}.`); return; }
    log("Creating offer...");
    const p2pStatusElement = document.getElementById('p2p-status');
    if (p2pStatusElement) p2pStatusElement.textContent = "Creating offer...";
    try {
        if (!dataChannel || dataChannel.readyState === "closed") {
            log("Creating new data channel 'chat'.")
            dataChannel = pc.createDataChannel("chat", {ordered: true});
            setupDataChannelEvents(dataChannel);
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        log(`Sending offer`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "offer", offer: pc.localDescription, room: ROOM_NAME })); // ROOM_NAME from global
            if (p2pStatusElement) p2pStatusElement.textContent = "Offer sent. Waiting for answer...";
        } else {
            log("WebSocket not open for offer.");
            if (p2pStatusElement) p2pStatusElement.textContent = "Offer not sent (Signaling disconnected).";
        }
    } catch (error) {
        log(`Error creating offer: ${error.toString()}`); console.error("Offer creation error:", error);
        if (p2pStatusElement) p2pStatusElement.textContent = "Offer Creation Error.";
        addMessageToChat("--- Offer Creation Error ---", "system");
    }
}

async function createAnswer(offer) {
    if (!pc) { log("Cannot create answer: PC not init."); return; }
    log("Creating answer...");
    const p2pStatusElement = document.getElementById('p2p-status');
    if (p2pStatusElement) p2pStatusElement.textContent = "Creating answer...";
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        log(`Sending answer`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "answer", answer: pc.localDescription, room: ROOM_NAME })); // ROOM_NAME from global
            if (p2pStatusElement) p2pStatusElement.textContent = "Answer sent.";
        } else {
            log("WebSocket not open for answer.");
            if (p2pStatusElement) p2pStatusElement.textContent = "Answer not sent (Signaling disconnected).";
        }
    } catch (error) {
        log(`Error creating answer: ${error.toString()}`); console.error("Answer creation error:", error);
        if (p2pStatusElement) p2pStatusElement.textContent = "Answer Creation Error.";
        addMessageToChat("--- Answer Creation Error ---", "system");
    }
}

function setupDataChannelEvents(channel) {
    log(`Setting up data channel events for: ${channel.label}`);
    channel.binaryType = 'arraybuffer';
    const p2pStatusElement = document.getElementById('p2p-status');
    const signalingStatusElement = document.getElementById('signaling-status');
    // UI elements that plugins might interact with or that core needs to manage on P2P state change
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const sendFileButton = document.getElementById('send-file-button');
    const callButton = document.getElementById('call-button'); // Needed for updateCallUI

    channel.onopen = () => {
        log(`Data channel '${channel.label}' opened.`);
        if (p2pStatusElement) p2pStatusElement.textContent = "P2P Connected!";
        if (signalingStatusElement) signalingStatusElement.textContent = "Signaling server disconnected (P2P active).";
        addMessageToChat("--- P2P Connection Established ---", "system");
        log(`Sending username: ${USERNAME}`); // USERNAME from global
        channel.send(JSON.stringify({ type: "username_exchange", username: USERNAME }));
        if (myPublicKeyPEM) {
            log("Sending public key...");
            channel.send(JSON.stringify({ type: "public_key_exchange", publicKey: myPublicKeyPEM }));
        } else {
            log("Error: My public key is not available.");
            addMessageToChat("--- Error: Your public key not available. Secure chat may fail. ---", "system");
        }
        if (ws && ws.readyState === WebSocket.OPEN) { log("Closing WebSocket."); ws.close(); }

        // Enable UI elements that depend on an open data channel
        if (messageInput) messageInput.disabled = false;
        if (sendButton) sendButton.disabled = false;
        if (sendFileButton) sendFileButton.disabled = false;
        if (callButton && typeof updateCallUI === 'function') updateCallUI(); // Update call UI (defined in main or plugin)

        // TODO: Notify plugins that P2P is connected
        // Example: document.dispatchEvent(new CustomEvent('p2pconnected', { detail: { channel } }));
        log("P2P connection open, plugins can now be fully activated.");

        log('Core: Data channel open - Dispatching datachannel-ready event.');
        document.dispatchEvent(new CustomEvent('datachannel-ready'));
    };

    channel.onclose = () => {
        log("Data channel closed. Resetting peer state.");
        PEER_USERNAME = "Peer"; peerPublicKeyPEM = null;
        // Core-level expectation flags for binary data are removed as per task.
        // expectingFileDataForId = null;
        // expectingFileChunkNum = undefined;

        if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
             p2pStatusElement.textContent = "P2P Disconnected. Refresh to reconnect.";
             addMessageToChat(`--- P2P Disconnected ---`, "system");
        }
        // Disable UI elements
        if (messageInput) messageInput.disabled = true;
        if (sendButton) sendButton.disabled = true;
        if (sendFileButton) sendFileButton.disabled = true;

        // Handle call cleanup if a call was active
        if (callState !== 'idle' && typeof updateCallUI === 'function') { // updateCallUI might be in a plugin
            log(`Data channel closed during a call (state: ${callState}). Cleaning up call.`);
            // The actual call cleanup logic (stopping streams, removing tracks) will be in the voice chat plugin
            // For now, core just resets its state and tells the plugin to update UI.
            callState = 'idle';
            currentCallId = null;
            incomingCallOfferDetails = null;
            if (typeof updateCallUI === 'function') updateCallUI();
            addMessageToChat("--- Call ended due to P2P connection loss. ---", "system");
        }
        // TODO: Notify plugins that P2P is disconnected
        // Example: document.dispatchEvent(new CustomEvent('p2pdisconnected'));
    };

    channel.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
            const arrayBuffer = event.data;
            // ArrayBuffer (binary data) handling
            // Always dispatch the event with just the arrayBuffer.
            // Remove core.js level expectation flags (expectingFileDataForId, expectingFileChunkNum)
            // as plugins will manage their own state for interpreting binary data.
            log('Core: Dispatching core-binary-data-received (contains ArrayBuffer).');
            document.dispatchEvent(new CustomEvent('core-binary-data-received', {
                detail: { arrayBuffer: arrayBuffer }
            }));
            return;
        }

        let msg;
        try { msg = JSON.parse(event.data); }
        catch (e) { log(`Core: Non-JSON string on data channel: ${event.data}`); return; }

        log(`Core: Received JSON message via Data Channel: type=${msg.type}, subType=${msg.subType || 'N/A'}`);

        if (msg.type === "encrypted_control_message") {
            if (!myKeyPair) { log("Core: Cannot decrypt control msg: RSA keys missing."); addMessageToChat("--- Error: Cannot process secure control message (keys missing). ---", "system"); return; }
            try {
                const decryptedPayloadJSON = myKeyPair.decrypt(msg.payload);
                if (!decryptedPayloadJSON) { log("Core: Failed to decrypt control message payload."); addMessageToChat("--- Received undecryptable control message. ---", "system"); return; }
                const controlMsg = JSON.parse(decryptedPayloadJSON); // controlMsg is the decrypted payload
                log(`Core: Decrypted control message: subType=${msg.subType}, details (first 100 chars)=${JSON.stringify(controlMsg).substring(0,100)}...`);

                // Dispatch based on subType
                // Note: The event detail was 'data: controlMsg', now changing to 'decryptedPayload: controlMsg' for clarity
                log(`Core: Dispatching core-control-message-received, subType: ${msg.subType}`);
                document.dispatchEvent(new CustomEvent('core-control-message-received', { detail: { subType: msg.subType, decryptedPayload: controlMsg } }));

            } catch (error) { log(`Core: Encrypted control message processing error: ${error}`); console.error("Core Encrypted Control Msg Error:", error); addMessageToChat("--- Error processing secure control message. ---", "system");}

        } else if (msg.type === "username_exchange") {
            PEER_USERNAME = msg.username; log(`Core: Peer username updated to: ${PEER_USERNAME}`);
            addMessageToChat(`--- ${PEER_USERNAME} has joined the chat. ---`, "system");
        } else if (msg.type === "public_key_exchange") {
            peerPublicKeyPEM = msg.publicKey; log("Core: Received and stored peer public key.");
            addMessageToChat("--- Public keys exchanged. Secure communication active. ---", "system");
        } else {
            // For other message types (e.g., "chat_secure" which is not a "control_message")
            log(`Core: Dispatching core-message-received, type: ${msg.type}`);
            document.dispatchEvent(new CustomEvent('core-message-received', { detail: msg }));
        }
    };

    channel.onerror = (errorEvent) => {
        log(`Data channel error: ${errorEvent.error}`); console.error("DataChannel error:", errorEvent.error);
        if (p2pStatusElement) p2pStatusElement.textContent = `P2P Error: ${errorEvent.error.message}. Refresh.`;
        addMessageToChat(`--- P2P Data Channel Error ---`, "system");
        // TODO: Notify plugins of the error
        // Example: document.dispatchEvent(new CustomEvent('p2perror', { detail: errorEvent.error }));
    };
}

function connectWebSocket() {
    const signalingStatusElement = document.getElementById('signaling-status');
    const p2pStatusElement = document.getElementById('p2p-status');

    if (!signalingStatusElement || !p2pStatusElement) {
        console.error('Required DOM elements for signaling/P2P status not found.');
        return;
    }
    signalingStatusElement.textContent = "Connecting to signaling server...";
    //const signalingServerUrl = "ws://localhost:8080"; // Local dev
    const signalingServerUrl = "wss://thing-1-gzkh.onrender.com"; // Render
    ws = new WebSocket(signalingServerUrl);

    ws.onopen = () => {
        log(`Connected to signaling server.`);
        ws.send(JSON.stringify({ type: "join", room: ROOM_NAME })); // ROOM_NAME from global
        log(`Sent join for room: ${ROOM_NAME}`);
        initializePeerConnection();
        ws.send(JSON.stringify({ type: "ready", room: ROOM_NAME }));
        log(`Sent ready for room: ${ROOM_NAME}`);
        signalingStatusElement.textContent = `Joined room '${ROOM_NAME}'. Waiting for peer...`;
        addMessageToChat(`--- Joined room '${ROOM_NAME}'. Waiting for peer... ---`, "system");
    };

    ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); }
        catch (e) { log(`Core WS: Received non-JSON from signaling: ${event.data}`); return; }

        if (msg.room && msg.room !== ROOM_NAME) { log(`Core WS: Ignoring signaling message for other room ${msg.room}`); return; }
        log(`Core WS: Received signaling message type: ${msg.type}`);

        switch (msg.type) {
            case "offer":
                log("Received offer."); if (!pc) initializePeerConnection();
                if (pc) await createAnswer(msg.offer); else log("PC not ready for offer.");
                break;
            case "answer":
                log("Received answer.");
                if (pc) { try { await pc.setRemoteDescription(new RTCSessionDescription(msg.answer)); }
                    catch (e) { log(`Error setting remote (answer): ${e}`); console.error("Set remote answer error:", e); }}
                else log("PC not ready for answer.");
                break;
            case "candidate":
                log("Received ICE candidate.");
                if (pc && msg.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
                    catch (e) { log(`Error adding ICE candidate: ${e}`); console.error("Add ICE candidate error:", e); }}
                else if (!pc) log("PC not init for ICE candidate.");
                break;
            case "ready":
                log("Received ready from peer.");
                if (pc && pc.signalingState === "stable") {
                    log("Peer ready, I am stable. Creating offer.");
                    addMessageToChat("--- Peer is ready. Attempting P2P connection... ---", "system");
                    await createOffer();
                } else if (pc) log(`Peer ready, my state ${pc.signalingState}. Not offering.`);
                else log("Peer ready, my PC not init. Unexpected.");
                break;
            default: log(`Unknown signaling type: ${msg.type}`);
        }
    };

    ws.onerror = (event) => {
        log(`WebSocket error: ${event.type}.`); console.error("WebSocket error:", event);
        signalingStatusElement.textContent = "Error with signaling. Refresh.";
        addMessageToChat("--- Signaling error. P2P might fail. ---", "system");
        if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
            p2pStatusElement.textContent = "P2P Lost (Signaling Error)";
        }
    };

    ws.onclose = (event) => {
        log(`Disconnected from signaling. Code: ${event.code}, Clean: ${event.wasClean}`);
        if (!dataChannel || dataChannel.readyState !== "open") {
            signalingStatusElement.textContent = event.wasClean ? "Signaling disconnected." : "Lost signaling. Refresh.";
            addMessageToChat(event.wasClean ? "--- Signaling disconnected. ---" : "--- Lost signaling connection. ---", "system");
            if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect." && (!pc || pc.iceConnectionState !== "connected")) {
                p2pStatusElement.textContent = "P2P Disconnected (Signaling Closed)";
            }
        } else {
            signalingStatusElement.textContent = "Signaling disconnected (P2P active).";
            log("WS closed, P2P active.");
        }
    };
}


document.addEventListener('DOMContentLoaded', () => {
    log("core.js: DOMContentLoaded");

    // Initialize Lightbox
    lightboxModal = document.createElement('div');
    lightboxModal.id = 'imageLightbox';
    lightboxModal.className = 'lightbox-modal';
    lightboxImage = document.createElement('img');
    lightboxImage.className = 'lightbox-content';
    lightboxModal.appendChild(lightboxImage);
    const lightboxClose = document.createElement('span');
    lightboxClose.className = 'lightbox-close';
    lightboxClose.innerHTML = '&times;';
    lightboxModal.appendChild(lightboxClose);
    document.body.appendChild(lightboxModal);

    lightboxClose.onclick = function() {
        lightboxModal.style.display = 'none';
        if (lightboxImage.src && lightboxImage.src.startsWith('blob:')) {
            try { URL.revokeObjectURL(lightboxImage.src); log(`Lightbox: Closed and revoked URL: ${lightboxImage.src}`); }
            catch (e) { log(`Lightbox: Error revoking URL on close (close button): ${e}`); }
            lightboxImage.src = '';
        }
    }
    lightboxModal.onclick = function(event) {
        if (event.target === lightboxModal) {
            lightboxModal.style.display = 'none';
            if (lightboxImage.src && lightboxImage.src.startsWith('blob:')) {
                try { URL.revokeObjectURL(lightboxImage.src); log(`Lightbox: Closed and revoked URL (background click): ${lightboxImage.src}`); }
                catch (e) { log(`Lightbox: Error revoking URL on close (background click): ${e}`); }
                lightboxImage.src = '';
            }
        }
    }

    // Create remote audio element for voice calls (plugins will use this)
    remoteAudioElement = document.createElement('audio');
    remoteAudioElement.id = 'remote-audio';
    // remoteAudioElement.controls = true; // Optional: for debugging by plugins
    document.body.appendChild(remoteAudioElement);
    log("Remote audio element created and added to DOM.");


    // Initial UI states that core can manage
    const signalingStatusElement = document.getElementById('signaling-status');
    const p2pStatusElement = document.getElementById('p2p-status');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const sendFileButton = document.getElementById('send-file-button');
    const callButton = document.getElementById('call-button');


    if (signalingStatusElement) signalingStatusElement.textContent = "Initializing...";
    if (p2pStatusElement) p2pStatusElement.textContent = "Not Connected";
    if (messageInput) messageInput.disabled = true;
    if (sendButton) sendButton.disabled = true;
    if (sendFileButton) sendFileButton.disabled = true;
    if (callButton) callButton.disabled = true;


    if (typeof JSEncrypt === 'undefined') {
        console.error("JSEncrypt library is not loaded!");
        log("Error: JSEncrypt library not loaded. Encryption will not work.");
        if (p2pStatusElement) p2pStatusElement.textContent = "Error: Encryption library failed to load.";
        addMessageToChat("--- Error: Encryption library (JSEncrypt) not loaded. Secure chat disabled. ---", "system");
    } else {
        generateRSAKeyPair();
        if (!myPublicKeyPEM || !myPrivateKeyPEM) {
            addMessageToChat("--- Error: Failed to generate your encryption keys. Secure chat may not work. ---", "system");
        }
    }
    connectWebSocket(); // Start signaling connection

    log("Core DOMContentLoaded setup complete.");
    // Dispatch an event to signal core is ready for plugins to initialize
    log('Core: DOMContentLoaded - Dispatching core-ready event');
    document.dispatchEvent(new CustomEvent('core-ready'));
});

// Expose necessary functions/variables to global scope if plugins need them directly,
// or rely on events and plugin-specific DOM element interactions.
// For now, most interaction will be via events or plugins finding elements.
// window.core = { addMessageToChat, sendDataChannelMessage, log, PEER_USERNAME, USERNAME, ROOM_NAME, DEBUG };
// Better to pass necessary things via events or allow plugins to grab from global scope (USERNAME, ROOM_NAME, DEBUG)
// and interact with core via specific functions if needed, or events.
console.log("core.js parsed and executed initial script block.");
