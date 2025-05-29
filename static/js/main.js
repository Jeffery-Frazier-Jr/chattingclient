// Ensure this script runs after the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    // 1. Retrieve Data (USERNAME, ROOM_NAME, DEBUG are global constants from chat.html)

    // 2. Debug Logging Function
    function log(message) {
        if (DEBUG) {
            console.log("[DEBUG]", message);
        }
    }

    log(`Username: ${USERNAME}, Room: ${ROOM_NAME}, Debug Mode: ${DEBUG}`);

    // 3. DOM Element References
    const signalingStatusElement = document.getElementById('signaling-status');
    const p2pStatusElement = document.getElementById('p2p-status');
    const chatArea = document.getElementById('chat-area');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');

    // Initial P2P Status
    p2pStatusElement.textContent = "Waiting for P2P connection...";

    // WebRTC Global Variables
    let pc = null;
    let localStream = null; // Not used for data channel only, but good for future audio/video
    let dataChannel = null;

    // RTCPeerConnection Configuration
    const iceServers = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] };

    // Helper function to add messages to the chat area
    function addMessageToChat(messageText, messageType, timestamp) {
        if (!chatArea) return;
        const messageElement = document.createElement('div');
        messageElement.classList.add('message', `${messageType}-message`);

        let formattedMessage = "";
        const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

        if (messageType === 'system') {
            formattedMessage = `<em>${messageText}</em>`;
        } else if (messageType === 'sent') {
            formattedMessage = `[${time}] You: ${messageText}`;
        } else if (messageType === 'received') {
            formattedMessage = `[${time}] Peer: ${messageText}`;
        } else {
            formattedMessage = messageText;
        }

        messageElement.innerHTML = formattedMessage;
        chatArea.appendChild(messageElement);
        chatArea.scrollTop = chatArea.scrollHeight; // Scroll to bottom
    }


    function initializePeerConnection() {
        if (pc) {
            log("PeerConnection already initialized.");
            return;
        }
        log("Initializing RTCPeerConnection...");
        try {
            pc = new RTCPeerConnection(iceServers);
            p2pStatusElement.textContent = "Initializing P2P connection...";

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    log(`Sending ICE candidate: ${JSON.stringify(event.candidate)}`);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate, room: ROOM_NAME }));
                    } else {
                        log("WebSocket not open. Cannot send ICE candidate.");
                    }
                } else {
                    log("All ICE candidates have been sent.");
                }
            };

            pc.oniceconnectionstatechange = () => {
                if (!pc) return;
                log(`ICE connection state changed: ${pc.iceConnectionState}`);
                switch (pc.iceConnectionState) {
                    case "connected":
                        log("ICE Connection: Connected. Data channel should open soon if not already.");
                        p2pStatusElement.textContent = "P2P Connection Established.";
                        // dataChannel.onopen will handle final P2P connected state and ws.close()
                        break;
                    case "disconnected":
                        log("ICE Connection: Disconnected.");
                        p2pStatusElement.textContent = "P2P Disconnected. Signaling may be needed again.";
                        addMessageToChat("--- P2P Connection Lost (ICE Disconnected) ---", "system");
                        // DataChannel.onclose might also fire. Consider cleanup or reconnection logic.
                        break;
                    case "failed":
                        log("ICE Connection: Failed.");
                        p2pStatusElement.textContent = "P2P Connection Failed. Please refresh.";
                        addMessageToChat("--- P2P Connection Failed (ICE) ---", "system");
                        break;
                    case "closed":
                        log("ICE Connection: Closed.");
                        p2pStatusElement.textContent = "P2P Connection Closed. Please refresh.";
                        addMessageToChat("--- P2P Connection Closed (ICE) ---", "system");
                        break;
                    default:
                        p2pStatusElement.textContent = `P2P Status: ${pc.iceConnectionState}`;
                        break;
                }
            };

            pc.ondatachannel = (event) => {
                log("Data channel received.");
                dataChannel = event.channel;
                setupDataChannelEvents(dataChannel);
                // p2pStatusElement.textContent = "Data channel received."; // onopen will provide better status
            };
        } catch (error) {
            log(`Error initializing RTCPeerConnection: ${error.toString()}`);
            console.error("RTCPeerConnection initialization error:", error);
            p2pStatusElement.textContent = "P2P Initialization Error.";
            addMessageToChat("--- P2P Initialization Error ---", "system");
        }
    }

    async function createOffer() {
        if (!pc) {
            log("Cannot create offer: PeerConnection is not initialized.");
            return;
        }
        if (pc.signalingState !== "stable") {
            log(`Cannot create offer in signaling state: ${pc.signalingState}. Waiting for stable state.`);
            return;
        }
        log("Creating offer...");
        p2pStatusElement.textContent = "Creating offer...";
        try {
            if (!dataChannel || dataChannel.readyState === "closed") {
                log("Creating new data channel 'chat'.")
                dataChannel = pc.createDataChannel("chat");
                setupDataChannelEvents(dataChannel); // Setup events for the offerer's channel instance
            } else {
                log("Data channel 'chat' already exists or is being set up.");
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            log(`Sending offer`);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "offer", offer: pc.localDescription, room: ROOM_NAME }));
                p2pStatusElement.textContent = "Offer sent. Waiting for answer...";
            } else {
                log("WebSocket not open. Cannot send offer.");
                p2pStatusElement.textContent = "Offer not sent (Signaling disconnected).";
                addMessageToChat("--- Could not send offer: Signaling disconnected ---", "system");
            }
        } catch (error) {
            log(`Error creating offer: ${error.toString()}`);
            console.error("Offer creation error:", error);
            p2pStatusElement.textContent = "Offer Creation Error.";
            addMessageToChat("--- Offer Creation Error ---", "system");
        }
    }

    async function createAnswer(offer) {
        if (!pc) {
            log("Cannot create answer: PeerConnection is not initialized.");
            return;
        }
        log("Creating answer...");
        p2pStatusElement.textContent = "Creating answer...";
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            log(`Sending answer`);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "answer", answer: pc.localDescription, room: ROOM_NAME }));
                p2pStatusElement.textContent = "Answer sent.";
            } else {
                log("WebSocket not open. Cannot send answer.");
                p2pStatusElement.textContent = "Answer not sent (Signaling disconnected).";
                addMessageToChat("--- Could not send answer: Signaling disconnected ---", "system");
            }
        } catch (error) {
            log(`Error creating answer: ${error.toString()}`);
            console.error("Answer creation error:", error);
            p2pStatusElement.textContent = "Answer Creation Error.";
            addMessageToChat("--- Answer Creation Error ---", "system");
        }
    }

    function setupDataChannelEvents(channel) {
        log(`Setting up data channel event handlers for channel: ${channel.label}`);
        channel.onopen = () => {
            log(`Data channel '${channel.label}' opened.`);
            p2pStatusElement.textContent = "P2P Connected!";
            signalingStatusElement.textContent = "Signaling server disconnected (P2P active).";
            addMessageToChat("--- P2P Connected ---", "system");
            if (ws && ws.readyState === WebSocket.OPEN) {
                log("Closing WebSocket connection as P2P is active.");
                ws.close();
            }
            messageInput.disabled = false;
            sendButton.disabled = false;
            messageInput.focus();
        };
        channel.onclose = () => {
            log(`Data channel '${channel.label}' closed.`);
            // This might be called if the peer disconnects or due to network issues
            if (p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
                 p2pStatusElement.textContent = "P2P Disconnected. Refresh to reconnect.";
                 addMessageToChat("--- P2P Disconnected (Data Channel Closed) ---", "system");
            }
            messageInput.disabled = true;
            sendButton.disabled = true;
        };
        channel.onmessage = (event) => {
            log(`Message received on data channel '${channel.label}': ${event.data}`);
            // Assuming message is plain text for now
            addMessageToChat(event.data, "received");
        };
        channel.onerror = (errorEvent) => { // event is an RTCErrorEvent
            log(`Data channel '${channel.label}' error: ${errorEvent.error}`);
            console.error("DataChannel error:", errorEvent.error);
            p2pStatusElement.textContent = `P2P Error: ${errorEvent.error.message}. Refresh to reconnect.`;
            addMessageToChat(`--- P2P Data Channel Error: ${errorEvent.error.message} ---`, "system");
        };
    }
    
    function sendMessage() {
        if (!messageInput || !dataChannel || dataChannel.readyState !== "open") {
            log("Cannot send message: Data channel not open or message input not found.");
            if (dataChannel && dataChannel.readyState !== "open") {
                addMessageToChat("--- Cannot send: P2P connection not fully established. ---", "system");
            }
            return;
        }
        const messageText = messageInput.value;
        if (messageText.trim() === "") {
            return; // Don't send empty messages
        }

        log(`Sending message via data channel: ${messageText}`);
        try {
            dataChannel.send(messageText);
            addMessageToChat(messageText, "sent");
            messageInput.value = ""; // Clear input field
        } catch (error) {
            log(`Error sending message: ${error.toString()}`);
            console.error("Error sending message via DataChannel:", error);
            addMessageToChat(`--- Error sending message: ${error.toString()} ---`, "system");
        }
    }

    if (sendButton) {
        sendButton.onclick = sendMessage;
    }
    if (messageInput) {
        messageInput.onkeypress = (event) => {
            if (event.key === "Enter") {
                event.preventDefault(); // Prevent default form submission if it's in a form
                sendMessage();
            }
        };
        // Initially disable input until P2P is connected
        messageInput.disabled = true;
        if(sendButton) sendButton.disabled = true;
    }


    // WebSocket Connection
    const signalingServerUrl = "wss://thing-1-gzkh.onrender.com";
    let ws;

    function connectWebSocket() {
        if (!signalingStatusElement || !p2pStatusElement || !chatArea || !messageInput || !sendButton) {
            console.error('Required DOM elements not found. Aborting WebSocket connection.');
            if(document.getElementById('signaling-status')) document.getElementById('signaling-status').textContent = "Initialization Error: Missing page elements.";
            return;
        }
        
        signalingStatusElement.textContent = "Connecting to signaling server...";
        ws = new WebSocket(signalingServerUrl);

        ws.onopen = () => {
            log(`Connected to signaling server: ${signalingServerUrl}`);
            const joinPayload = { type: "join", room: ROOM_NAME };
            ws.send(JSON.stringify(joinPayload));
            log(`Sent to signaling server: ${JSON.stringify(joinPayload)}`);
            
            initializePeerConnection(); 

            const readyPayload = { type: "ready", room: ROOM_NAME };
            ws.send(JSON.stringify(readyPayload));
            log(`Sent to signaling server: ${JSON.stringify(readyPayload)}`);
            
            signalingStatusElement.textContent = `Joined room '${ROOM_NAME}'. Sent ready signal. Waiting for peer...`;
            addMessageToChat(`--- Joined room '${ROOM_NAME}'. Waiting for peer... ---`, "system");
        };

        ws.onmessage = async (event) => {
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (e) {
                log(`Received non-JSON message from signaling server: ${event.data}`);
                return;
            }

            if (msg.room && msg.room !== ROOM_NAME) {
                log(`Ignoring message for room ${msg.room}`);
                return;
            }

            log(`Received from signaling server: ${JSON.stringify(msg).substring(0, 200)}...`); // Log snippet for large msgs

            switch (msg.type) {
                case "offer":
                    log("Received offer.");
                    if (!pc) initializePeerConnection();
                    if (pc) {
                         if (pc.signalingState !== "stable" && pc.signalingState !== "have-remote-offer") {
                             log(`Cannot handle offer in signaling state: ${pc.signalingState}. This might be glare.`);
                             // Basic glare handling: if we are stable, proceed. If we also sent an offer, the role (polite/impolite) might matter.
                             // For simplicity, if we are not stable, we might ignore or try to reset.
                             // Current server.py relays, so both might send offers.
                             // A more robust glare handling might involve comparing roles or timestamps.
                             // For now, proceed if not already in a conflicting state.
                        }
                        await createAnswer(msg.offer);
                    } else {
                        log("PeerConnection not ready to handle offer.");
                    }
                    break;
                case "answer":
                    log("Received answer.");
                    if (pc) {
                        if (pc.signalingState !== "have-local-offer") {
                            log(`Cannot handle answer in signaling state: ${pc.signalingState}. Expected have-local-offer.`);
                        }
                        try {
                            await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
                        } catch (e) {
                             log(`Error setting remote description for answer: ${e.toString()}`);
                             console.error("Error setting remote description (answer):", e);
                        }
                    } else {
                        log("PeerConnection not ready to handle answer.");
                    }
                    break;
                case "candidate":
                    log("Received ICE candidate.");
                    if (pc && msg.candidate) {
                        try {
                            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch (e) {
                            log(`Error adding received ICE candidate: ${e.toString()}`);
                            console.error("Error adding ICE candidate:", e);
                        }
                    } else if (!pc) {
                        log("PeerConnection not initialized, cannot add ICE candidate yet.");
                        // Could queue candidates if this happens often.
                    }
                    break;
                case "ready": 
                    log("Received ready message from peer.");
                    if (pc && pc.signalingState === "stable") {
                        log("Peer is ready, and I am stable. Creating offer.");
                        addMessageToChat("--- Peer is ready. Attempting to establish P2P connection... ---", "system");
                        await createOffer();
                    } else if (pc) {
                        log(`Peer is ready, but my signalingState is ${pc.signalingState}. Not creating offer now (glare handling or waiting).`);
                    } else {
                        log("Peer is ready, but my PeerConnection is not initialized. This is unexpected.");
                    }
                    break;
                default:
                    log(`Unknown message type from signaling: ${msg.type}`);
            }
        };

        ws.onerror = (event) => {
            log(`WebSocket error: ${event.type}. Check console for details.`);
            console.error("WebSocket error event:", event);
            signalingStatusElement.textContent = "Error with signaling server. Please refresh.";
            addMessageToChat("--- Error with signaling server. P2P connection might fail. ---", "system");
            if (p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
                p2pStatusElement.textContent = "P2P Connection Lost (Signaling Error)";
            }
        };

        ws.onclose = (event) => {
            log(`Disconnected from signaling server. Code: ${event.code}, Reason: ${event.reason}`);
            // Only show "Disconnected" if P2P channel isn't already open and active
            if (!dataChannel || dataChannel.readyState !== "open") {
                if (event.wasClean) {
                    signalingStatusElement.textContent = "Signaling server disconnected.";
                    addMessageToChat("--- Signaling server disconnected. ---", "system");
                } else {
                    signalingStatusElement.textContent = "Lost connection to signaling server. Refresh if P2P fails.";
                    addMessageToChat("--- Lost connection to signaling server. ---", "system");
                }
                if (p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect." && (!pc || pc.iceConnectionState !== "connected")) {
                    p2pStatusElement.textContent = "P2P Disconnected (Signaling Closed)";
                }
            } else {
                signalingStatusElement.textContent = "Signaling server disconnected (P2P active).";
                log("WebSocket closed, but P2P data channel is active.");
            }
            // Do not close pc here unless it's certain P2P failed due to this.
            // pc.oniceconnectionstatechange handles P2P state.
        };
    }

    // Initialize WebSocket connection
    connectWebSocket();
});
