// Global constants from chat.html (USERNAME, ROOM_NAME, DEBUG)

// Global variable for Peer Username
let PEER_USERNAME = "Peer"; // Default, will be updated

// RSA Key Variables
let rsaKeySize = 2048;
let myKeyPair = null;
let myPublicKeyPEM = null;
let myPrivateKeyPEM = null;
let peerPublicKeyPEM = null; // For peer's public key

// File Transfer Variables
let selectedFile = null;
let pendingFileTransfers = {};
let incomingFileTransfers = {};
let expectingFileDataForId = null;
let expectingFileChunkNum = undefined; // Used by receiver for chunked files

// File Chunking Parameters
const CHUNK_SIZE = 64 * 1024; // 64 KB chunks
const LARGE_FILE_THRESHOLD = 256 * 1024; // Files larger than 256 KB will be chunked


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


// Ensure this script runs after the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    const signalingStatusElement = document.getElementById('signaling-status');
    const p2pStatusElement = document.getElementById('p2p-status');
    const chatArea = document.getElementById('chat-area');
    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');
    const fileInputElement = document.getElementById('file-input');
    const sendFileButton = document.getElementById('send-file-button');

    function addMessageToChat(messageText, messageType, timestamp) {
        if (!chatArea) return;
        const messageElement = document.createElement('div');
        messageElement.classList.add('message');
        let formattedMessage = "";
        const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        if (messageType === 'system') {
            formattedMessage = `<em>${messageText}</em>`;
            messageElement.classList.add('system-message');
        } else if (messageType === 'sent') {
            formattedMessage = `[${time}] ${USERNAME}: ${messageText}`;
            messageElement.classList.add('sent-message');
        } else if (messageType === 'received') {
            formattedMessage = `[${time}] ${PEER_USERNAME}: ${messageText}`;
            messageElement.classList.add('received-message');
        } else {
            formattedMessage = messageText;
        }
        messageElement.innerHTML = formattedMessage;
        chatArea.appendChild(messageElement);
        chatArea.scrollTop = chatArea.scrollHeight;
    }

    log(`Username: ${USERNAME}, Room: ${ROOM_NAME}, Debug Mode: ${DEBUG}`);

    if (typeof JSEncrypt === 'undefined') {
        console.error("JSEncrypt library is not loaded!");
        log("Error: JSEncrypt library not loaded. Encryption will not work.");
        if (p2pStatusElement) p2pStatusElement.textContent = "Error: Encryption library failed to load.";
        addMessageToChat("--- Error: Encryption library (JSEncrypt) not loaded. Secure chat disabled. ---", "system");
    } else {
        generateRSAKeyPair();
        if (myPublicKeyPEM && myPrivateKeyPEM) {
            addMessageToChat("--- Your RSA encryption keys generated. ---", "system");
        } else {
            addMessageToChat("--- Error: Failed to generate your encryption keys. Secure chat may not work. ---", "system");
        }
    }

    if (p2pStatusElement && !p2pStatusElement.textContent.startsWith("Error:")) {
        p2pStatusElement.textContent = "Waiting for P2P connection...";
    }

    let pc = null;
    let localStream = null;
    let dataChannel = null;
    const iceServers = { 'iceServers': [{ 'urls': 'stun:stun.l.google.com:19302' }] };

    function initializePeerConnection() {
        if (pc) { log("PeerConnection already initialized."); return; }
        log("Initializing RTCPeerConnection...");
        try {
            pc = new RTCPeerConnection(iceServers);
            if (p2pStatusElement && !p2pStatusElement.textContent.startsWith("Error:")) {
                p2pStatusElement.textContent = "Initializing P2P connection...";
            }
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    log(`Sending ICE candidate`);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "candidate", candidate: event.candidate, room: ROOM_NAME }));
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
                ws.send(JSON.stringify({ type: "offer", offer: pc.localDescription, room: ROOM_NAME }));
                if (p2pStatusElement) p2pStatusElement.textContent = "Offer sent. Waiting for answer...";
            } else {
                log("WebSocket not open for offer.");
                if (p2pStatusElement) p2pStatusElement.textContent = "Offer not sent (Signaling disconnected).";
                addMessageToChat("--- Could not send offer: Signaling disconnected ---", "system");
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
        if (p2pStatusElement) p2pStatusElement.textContent = "Creating answer...";
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            log(`Sending answer`);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "answer", answer: pc.localDescription, room: ROOM_NAME }));
                if (p2pStatusElement) p2pStatusElement.textContent = "Answer sent.";
            } else {
                log("WebSocket not open for answer.");
                if (p2pStatusElement) p2pStatusElement.textContent = "Answer not sent (Signaling disconnected).";
                addMessageToChat("--- Could not send answer: Signaling disconnected ---", "system");
            }
        } catch (error) {
            log(`Error creating answer: ${error.toString()}`); console.error("Answer creation error:", error);
            if (p2pStatusElement) p2pStatusElement.textContent = "Answer Creation Error.";
            addMessageToChat("--- Answer Creation Error ---", "system");
        }
    }

    async function initiateFileSend(fileId) {
        const transferInfo = pendingFileTransfers[fileId];
        if (!transferInfo || transferInfo.status !== 'accepted' || !transferInfo.file) {
            log(`Error: Cannot send file for fileId ${fileId}. Status: ${transferInfo ? transferInfo.status : 'unknown'}, File: ${transferInfo ? transferInfo.file : 'missing'}`);
            addMessageToChat(`--- Error: Could not start sending file ${transferInfo ? transferInfo.file.name : fileId}. ---`, "system");
            return;
        }

        const file = transferInfo.file;
        log(`Calculating hash for file: ${file.name}`);
        const fullFileHashHex = await calculateFileHash(file);
        if (!fullFileHashHex) {
            addMessageToChat(`--- Error calculating hash for ${file.name}. Send cancelled. ---`, "system");
            pendingFileTransfers[fileId].status = 'error_hashing';
            return;
        }
        log(`Calculated SHA-256 hash for ${file.name}: ${fullFileHashHex.substring(0,10)}...`);

        log(`Starting to send file: ${file.name} (ID: ${fileId}), Size: ${file.size}`);
        pendingFileTransfers[fileId].status = 'sending_data';

        const fileDataHeaderBase = {
            fileId: fileId, fileName: file.name,
            fileType: file.type || "application/octet-stream",
            fullFileHash: fullFileHashHex
        };

        if (file.size > LARGE_FILE_THRESHOLD) {
            addMessageToChat(`--- Sending large file: ${file.name} in chunks... ---`, "system");
            fileDataHeaderBase.isChunked = true;
            fileDataHeaderBase.totalChunks = Math.ceil(file.size / CHUNK_SIZE);

            try {
                const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM);
                const encryptedHeaderPayload = encrypt.encrypt(JSON.stringify(fileDataHeaderBase));
                if (!encryptedHeaderPayload) {
                    log("Error encrypting chunked file_data_header.");
                    addMessageToChat(`--- Error sending header for ${file.name}. Aborted. ---`, "system");
                    pendingFileTransfers[fileId].status = 'error_sending_header'; return;
                }
                dataChannel.send(JSON.stringify({ type: "encrypted_control_message", subType: "file_data_header", payload: encryptedHeaderPayload }));
                log(`Sent encrypted file_data_header for chunked file ${file.name}`);

                for (let chunkNum = 0; chunkNum < fileDataHeaderBase.totalChunks; chunkNum++) {
                    if (dataChannel.readyState !== 'open') { throw new Error("Data channel closed mid-transfer"); }
                    const start = chunkNum * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);
                    const chunkArrayBuffer = await readBlobAsArrayBuffer(chunkBlob);

                    const chunkHeader = { fileId: fileId, chunkNum: chunkNum, chunkSize: chunkArrayBuffer.byteLength };
                    const encryptedChunkHeaderPayload = encrypt.encrypt(JSON.stringify(chunkHeader));
                    if (!encryptedChunkHeaderPayload) {
                        log(`Error encrypting chunk header ${chunkNum} for ${file.name}. Aborting.`);
                        addMessageToChat(`--- Error sending chunk ${chunkNum + 1} for ${file.name}. Aborted. ---`, "system");
                        pendingFileTransfers[fileId].status = 'error_chunk_encryption'; return;
                    }
                    dataChannel.send(JSON.stringify({ type: "encrypted_control_message", subType: "file_chunk_header", payload: encryptedChunkHeaderPayload }));
                    dataChannel.send(chunkArrayBuffer);
                    log(`Sent chunk ${chunkNum + 1}/${fileDataHeaderBase.totalChunks} for ${file.name}`);
                    addMessageToChat(`--- Sent chunk ${chunkNum + 1}/${fileDataHeaderBase.totalChunks} for ${file.name} ---`, "system");
                    pendingFileTransfers[fileId].sentChunks = (pendingFileTransfers[fileId].sentChunks || 0) + 1;
                }
                pendingFileTransfers[fileId].status = 'sent_all_chunks';
                addMessageToChat(`--- All chunks for ${file.name} sent successfully. ---`, "system");
            } catch (error) {
                log(`Error during chunked file send for ${file.name}: ${error}`); console.error("Chunked File Send Error:", error);
                pendingFileTransfers[fileId].status = 'error_sending_chunks';
                addMessageToChat(`--- Error sending ${file.name}. Transfer aborted. ---`, "system");
            }
        } else {
            addMessageToChat(`--- Sending small file: ${file.name}... ---`, "system");
            fileDataHeaderBase.isChunked = false;

            const reader = new FileReader();
            reader.onload = (event) => {
                const arrayBuffer = event.target.result;
                try {
                    const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM);
                    const encryptedHeaderPayload = encrypt.encrypt(JSON.stringify(fileDataHeaderBase));
                    if (!encryptedHeaderPayload) {
                        log("Error encrypting small file_data_header.");
                        addMessageToChat(`--- Error sending header for ${file.name}. Aborted. ---`, "system");
                        pendingFileTransfers[fileId].status = 'error_sending_header'; return;
                    }
                    dataChannel.send(JSON.stringify({ type: "encrypted_control_message", subType: "file_data_header", payload: encryptedHeaderPayload }));
                    log(`Sent encrypted file_data_header for small file ${file.name}`);
                    if (dataChannel && dataChannel.readyState === 'open') {
                        dataChannel.send(arrayBuffer);
                        log(`Sent ArrayBuffer for small file ${file.name}`);
                        pendingFileTransfers[fileId].status = 'sent_data';
                        addMessageToChat(`--- File ${file.name} sent successfully. ---`, "system");
                    } else {
                        log(`Data channel closed before sending small file ${file.name}`);
                        pendingFileTransfers[fileId].status = 'error_channel_closed';
                        addMessageToChat(`--- Error sending ${file.name}. Connection lost. ---`, "system");
                    }
                } catch (error) {
                    log(`Error sending small file ${file.name}: ${error}`); console.error("Small File Send Error:", error);
                    pendingFileTransfers[fileId].status = 'error_sending_data';
                    addMessageToChat(`--- Error sending file data for ${file.name}. ---`, "system");
                }
            };
            reader.onerror = (error) => {
                log(`Error reading small file ${file.name}: ${error}`);
                pendingFileTransfers[fileId].status = 'error_reading_file';
                addMessageToChat(`--- Error reading file ${file.name}. ---`, "system");
            };
            reader.readAsArrayBuffer(file);
        }
    }

    async function assembleFileFromChunks(fileId) { // Made async
        const transferInfo = incomingFileTransfers[fileId];

        if (!transferInfo || !transferInfo.chunks || transferInfo.receivedChunksCount !== transferInfo.totalChunks) {
            log(`Error assembling file ${fileId}: Missing information, chunks, or not all chunks received. Received: ${transferInfo ? transferInfo.receivedChunksCount : 'N/A'}, Expected: ${transferInfo ? transferInfo.totalChunks : 'N/A'}`);
            addMessageToChat(`--- Error: Could not assemble file ${transferInfo ? transferInfo.fileName : fileId}. Data incomplete. ---`, "system");
            if(transferInfo) transferInfo.status = 'error_assembling';
            return;
        }

        log(`Assembling file ${transferInfo.fileName} (ID: ${fileId}) from ${transferInfo.totalChunks} chunks.`);
        addMessageToChat(`--- Assembling file: ${transferInfo.fileName}... ---`, "system");

        try {
            for (let i = 0; i < transferInfo.totalChunks; i++) {
                if (!transferInfo.chunks[i]) {
                    log(`Error: Chunk ${i} is missing for file ${fileId}.`);
                    addMessageToChat(`--- Error: Chunk ${i+1} missing for ${transferInfo.fileName}. Assembly failed. ---`, "system");
                    transferInfo.status = 'error_missing_chunk';
                    return;
                }
            }

            const completeFileBlob = new Blob(transferInfo.chunks, { type: transferInfo.fileType || 'application/octet-stream' });
            log(`File ${transferInfo.fileName} assembled into Blob. Size: ${completeFileBlob.size}`);

            let hashMatchStatus = "Unknown";
            if (transferInfo.fullFileHash) { // Check if original hash was provided
                const receivedFileHashHex = await calculateFileHash(completeFileBlob);
                if (receivedFileHashHex) {
                    if (receivedFileHashHex === transferInfo.fullFileHash) {
                        hashMatchStatus = "OK";
                        log(`Hash match for assembled file ${transferInfo.fileName}: OK`);
                    } else {
                        hashMatchStatus = "MISMATCH!";
                        log(`Hash MISMATCH for assembled file ${transferInfo.fileName}. Expected: ${transferInfo.fullFileHash.substring(0,10)}..., Got: ${receivedFileHashHex.substring(0,10)}...`);
                    }
                } else {
                    hashMatchStatus = "Error calculating hash";
                    log(`Could not calculate hash for assembled file ${transferInfo.fileName}.`);
                }
            } else {
                hashMatchStatus = "Not provided by sender";
                log(`Original hash not provided by sender for ${transferInfo.fileName}.`);
            }

            if (completeFileBlob.size !== transferInfo.fileSize) { // This check is still useful
                log(`Warning: Assembled file size (${completeFileBlob.size}) does not match expected size (${transferInfo.fileSize}).`);
                addMessageToChat(`--- Warning: Assembled file size for ${transferInfo.fileName} is incorrect. File may be corrupt. Checksum: ${hashMatchStatus}. ---`, "system");
            }


            const downloadLink = document.createElement('a');
            downloadLink.href = URL.createObjectURL(completeFileBlob);
            downloadLink.download = transferInfo.fileName;

            const linkContainer = document.createElement('div');
            linkContainer.classList.add('file-download-container');
            const icon = document.createElement('span'); icon.textContent = '📄 '; linkContainer.appendChild(icon);
            const textNode = document.createTextNode(`Download: `); linkContainer.appendChild(textNode);
            downloadLink.textContent = `${transferInfo.fileName} (${(transferInfo.fileSize / 1024).toFixed(2)} KB) - Checksum: ${hashMatchStatus}`;
            if (hashMatchStatus !== "OK" && hashMatchStatus !== "Not provided by sender") { downloadLink.style.color = 'red'; }
            linkContainer.appendChild(downloadLink);

            const messageDiv = document.createElement('div');
            messageDiv.classList.add('message', 'system-message');
            messageDiv.appendChild(linkContainer);
            chatArea.appendChild(messageDiv);
            chatArea.scrollTop = chatArea.scrollHeight;

            log(`Download link created for assembled file ${transferInfo.fileName}.`);
            transferInfo.status = (hashMatchStatus === "OK" || hashMatchStatus === "Not provided by sender") ? 'received_data_complete' : 'error_hash_mismatch';
            addMessageToChat(`--- File ${transferInfo.fileName} received and assembled. Checksum: ${hashMatchStatus}. ---`, "system");

        } catch (error) {
            log(`Error during file assembly for ${transferInfo.fileName}: ${error}`);
            console.error("File Assembly Error:", error);
            addMessageToChat(`--- Error assembling file data for ${transferInfo.fileName}. ---`, "system");
            transferInfo.status = 'error_assembling';
        } finally {
            if (transferInfo && transferInfo.chunks) {
                delete transferInfo.chunks;
                log(`Cleaned up chunks for fileId ${fileId}`);
            }
        }
    }


    function setupDataChannelEvents(channel) {
        log(`Setting up data channel events for: ${channel.label}`);
        channel.binaryType = 'arraybuffer';

        channel.onopen = () => {
            log(`Data channel '${channel.label}' opened.`);
            if (p2pStatusElement) p2pStatusElement.textContent = "P2P Connected!";
            if (signalingStatusElement) signalingStatusElement.textContent = "Signaling server disconnected (P2P active).";
            addMessageToChat("--- P2P Connected ---", "system");
            log(`Sending username: ${USERNAME}`);
            channel.send(JSON.stringify({ type: "username_exchange", username: USERNAME }));
            if (myPublicKeyPEM) {
                log("Sending public key...");
                channel.send(JSON.stringify({ type: "public_key_exchange", publicKey: myPublicKeyPEM }));
            } else {
                log("Error: My public key is not available.");
                addMessageToChat("--- Error: Your public key not available. Secure chat may fail. ---", "system");
            }
            if (ws && ws.readyState === WebSocket.OPEN) { log("Closing WebSocket."); ws.close(); }
            if (messageInput) { messageInput.disabled = false; messageInput.focus(); }
            if (sendButton) sendButton.disabled = false;
            if (sendFileButton) sendFileButton.disabled = false;
        };
        channel.onclose = () => {
            log("Data channel closed. Resetting peer state."); PEER_USERNAME = "Peer"; peerPublicKeyPEM = null;
            expectingFileDataForId = null; expectingFileChunkNum = undefined;
            if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
                 p2pStatusElement.textContent = "P2P Disconnected. Refresh to reconnect.";
                 addMessageToChat(`--- P2P Disconnected ---`, "system");
            }
            if (messageInput) messageInput.disabled = true;
            if (sendButton) sendButton.disabled = true;
            if (sendFileButton) sendFileButton.disabled = true;
        };
        channel.onmessage = async (event) => { // Made onmessage async
            if (event.data instanceof ArrayBuffer) {
                const arrayBuffer = event.data;
                const currentFileId = expectingFileDataForId;
                const currentChunkNum = expectingFileChunkNum;

                if (currentFileId) {
                    const transferInfo = incomingFileTransfers[currentFileId];
                    if (!transferInfo) {
                        log(`Warning: Received ArrayBuffer for unknown transferInfo (fileId: ${currentFileId})`);
                        expectingFileDataForId = null; expectingFileChunkNum = undefined; return;
                    }

                    if (transferInfo.isChunked) {
                        if (transferInfo.status === 'receiving_chunks' && typeof currentChunkNum !== 'undefined') {
                            log(`Received ArrayBuffer for CHUNK ${currentChunkNum} of fileId: ${currentFileId}. Size: ${arrayBuffer.byteLength}`);
                            transferInfo.chunks[currentChunkNum] = arrayBuffer;
                            transferInfo.receivedSize = (transferInfo.receivedSize || 0) + arrayBuffer.byteLength;
                            transferInfo.receivedChunksCount = (transferInfo.receivedChunksCount || 0) + 1;
                            addMessageToChat(`--- Received chunk ${currentChunkNum + 1}/${transferInfo.totalChunks} for ${transferInfo.fileName}. ---`, "system");
                            if (transferInfo.receivedChunksCount === transferInfo.totalChunks) {
                                log(`All chunks received for fileId: ${currentFileId}. Assembling file...`);
                                addMessageToChat(`--- All chunks for ${transferInfo.fileName} received. Assembling... ---`, "system");
                                await assembleFileFromChunks(currentFileId); // Now awaited
                            }
                        } else {
                            log(`Warning: Received chunk ArrayBuffer for fileId: ${currentFileId} but not expecting specific chunk or status is wrong: ${transferInfo.status}, chunkNum: ${currentChunkNum}`);
                        }
                    } else { // Small File Logic
                        if (transferInfo.status === 'receiving_data') {
                            log(`Received ArrayBuffer for SMALL fileId: ${currentFileId}. Size: ${arrayBuffer.byteLength}`);
                            transferInfo.receivedSize = arrayBuffer.byteLength;
                            try {
                                const blob = new Blob([arrayBuffer], { type: transferInfo.fileType || 'application/octet-stream' });

                                let hashMatchStatus = "Unknown";
                                if (transferInfo.fullFileHash) {
                                    const receivedFileHashHex = await calculateFileHash(blob);
                                    if (receivedFileHashHex) {
                                        if (receivedFileHashHex === transferInfo.fullFileHash) {
                                            hashMatchStatus = "OK";
                                        } else { hashMatchStatus = "MISMATCH!"; }
                                    } else { hashMatchStatus = "Error calculating hash"; }
                                } else { hashMatchStatus = "Not provided"; }
                                log(`Small file ${transferInfo.fileName} hash status: ${hashMatchStatus}`);

                                const downloadLink = document.createElement('a');
                                downloadLink.href = URL.createObjectURL(blob);
                                downloadLink.download = transferInfo.fileName;
                                const linkContainer = document.createElement('div');
                                linkContainer.classList.add('file-download-container');
                                const icon = document.createElement('span'); icon.textContent = '📄 '; linkContainer.appendChild(icon);
                                const textNode = document.createTextNode(`Download: `); linkContainer.appendChild(textNode);
                                downloadLink.textContent = `${transferInfo.fileName} (${(transferInfo.fileSize / 1024).toFixed(2)} KB) - Checksum: ${hashMatchStatus}`;
                                if (hashMatchStatus !== "OK" && hashMatchStatus !== "Not provided") { downloadLink.style.color = 'red'; }
                                linkContainer.appendChild(downloadLink);
                                const messageDiv = document.createElement('div');
                                messageDiv.classList.add('message', 'system-message'); messageDiv.appendChild(linkContainer);
                                chatArea.appendChild(messageDiv); chatArea.scrollTop = chatArea.scrollHeight;

                                addMessageToChat(`--- File ${transferInfo.fileName} received. Checksum: ${hashMatchStatus}. ---`, "system");
                                transferInfo.status = (hashMatchStatus === "OK" || hashMatchStatus === "Not provided") ? 'received_data_complete' : 'error_hash_mismatch';
                            } catch (error) {
                                log(`Error processing small file ArrayBuffer for ${transferInfo.fileName}: ${error}`);
                                console.error("Small File Blob/Link Error:", error);
                                addMessageToChat(`--- Error processing file data for ${transferInfo.fileName}. ---`, "system");
                                transferInfo.status = 'error_processing_data';
                            }
                        } else {
                            log(`Warning: Received ArrayBuffer for small fileId: ${currentFileId} but status is wrong: ${transferInfo.status}`);
                        }
                    }
                    expectingFileDataForId = null;
                    expectingFileChunkNum = undefined;
                } else {
                    log("Warning: Received unexpected ArrayBuffer data (expectingFileDataForId is null).");
                }
                return;
            }

            let msg;
            try { msg = JSON.parse(event.data); }
            catch (e) { log(`Non-JSON string on data channel: ${event.data}`); return; }

            log(`Received message via Data Channel: type=${msg.type}, subType=${msg.subType || 'N/A'}`);

            if (msg.type === "encrypted_control_message") {
                if (!myKeyPair) { log("Cannot decrypt control msg: keys missing."); addMessageToChat("--- Error: Cannot process secure control message. ---", "system"); return; }
                try {
                    const decryptedPayloadJSON = myKeyPair.decrypt(msg.payload);
                    if (!decryptedPayloadJSON) { log("Failed to decrypt control payload."); addMessageToChat("--- Received undecryptable control message. ---", "system"); return; }
                    const controlMsg = JSON.parse(decryptedPayloadJSON);
                    log(`Decrypted control: subType=${msg.subType}, details=${JSON.stringify(controlMsg)}`);

                    switch (msg.subType) {
                        case "file_transfer_accept": // For the original sender of the file
                            const acceptedFileId = controlMsg.fileId;
                            const transferDetails = pendingFileTransfers[acceptedFileId];
                            log(`DEBUG: 'file_transfer_accept' received. controlMsg: ${JSON.stringify(controlMsg)}`);
                            log(`DEBUG: Looking for fileId '${acceptedFileId}' in pendingFileTransfers.`);

                            if (transferDetails && controlMsg.status === "accepted") {
                                log(`DEBUG: Found pending transfer for fileId '${acceptedFileId}'. Current status: '${transferDetails.status}'.`);
                                transferDetails.status = 'accepted';
                                let fileTypeCheckMessage = "N/A";
                                let fileNameForLog = "N/A";
                                if (transferDetails.file) {
                                    fileNameForLog = transferDetails.file.name;
                                    fileTypeCheckMessage = transferDetails.file instanceof File ? "File object" : `Not a File object (type: ${typeof(transferDetails.file)})`;
                                } else {
                                    fileTypeCheckMessage = "transferDetails.file is null or undefined";
                                    fileNameForLog = transferDetails.name || "Name not found in transferDetails";
                                }
                                log(`DEBUG: Pre-initiateFileSend for fileId: ${acceptedFileId}. ` +
                                    `transferInfo_status: ${transferDetails.status}, ` +
                                    `transferInfo_name_from_pending: ${transferDetails.name}, ` +
                                    `transferInfo_size_from_pending: ${transferDetails.size}, ` +
                                    `transferInfo_file_property_type: ${fileTypeCheckMessage}, ` +
                                    `transferInfo_file_object_name_if_exists: ${fileNameForLog}`);
                                if (!transferDetails.file || !(transferDetails.file instanceof File)) {
                                    log(`ERROR_DIAGNOSTIC: File object is missing or invalid in pendingFileTransfers for fileId ${acceptedFileId} just before calling initiateFileSend.`);
                                    addMessageToChat(`--- Diagnostic: File object error for ${fileNameForLog} (ID: ${acceptedFileId}). Cannot send. Please check console. ---`, "system");
                                } else {
                                    addMessageToChat(`--- Peer accepted file: ${transferDetails.name}. Starting send... ---`, "system");
                                    initiateFileSend(acceptedFileId);
                                }
                            } else {
                                let logReason = "Unknown reason.";
                                if (!transferDetails) {
                                    logReason = `FileId '${acceptedFileId}' not found in pendingFileTransfers.`;
                                } else if (controlMsg.status !== "accepted") {
                                    logReason = `ControlMsg status was '${controlMsg.status}', not 'accepted'.`;
                                }
                                log(`Warn: Acceptance for fileId '${acceptedFileId}' not processed. ${logReason} ` +
                                    `Details found in pending (if any): ${transferDetails ? JSON.stringify(transferDetails) : 'N/A'}`);
                                addMessageToChat(`--- Unexpected file acceptance for ID: ${acceptedFileId}. Reason: ${logReason} ---`, "system");
                            }
                            break;
                        case "file_data_header":
                            const fileHeader = controlMsg;
                            log(`Received file_data_header for ID: ${fileHeader.fileId}, Name: ${fileHeader.fileName}, Chunked: ${fileHeader.isChunked}`);
                            if (!incomingFileTransfers[fileHeader.fileId] || incomingFileTransfers[fileHeader.fileId].status !== 'offered') {
                                log(`Warn: file_data_header for unknown fileId: ${fileHeader.fileId} or status not 'offered'. Current status: ${incomingFileTransfers[fileHeader.fileId] ? incomingFileTransfers[fileHeader.fileId].status : 'N/A'}`);
                                if (!incomingFileTransfers[fileHeader.fileId]) incomingFileTransfers[fileHeader.fileId] = {chunks: [], receivedSize:0, fileSize:0};
                            }
                            const transfer = incomingFileTransfers[fileHeader.fileId];
                            transfer.fileName = fileHeader.fileName;
                            transfer.fileType = fileHeader.fileType;
                            transfer.isChunked = fileHeader.isChunked;
                            transfer.fullFileHash = fileHeader.fullFileHash;
                            if(!transfer.fileSize && fileHeader.fileSizeFromOffer) transfer.fileSize = fileHeader.fileSizeFromOffer; // Use fileSize from original offer if available
                            else if (!transfer.fileSize && fileHeader.fileSize) transfer.fileSize = fileHeader.fileSize;


                            if (fileHeader.isChunked) {
                                transfer.totalChunks = fileHeader.totalChunks;
                                transfer.chunks = new Array(fileHeader.totalChunks);
                                transfer.receivedChunksCount = 0;
                                transfer.status = 'receiving_chunks';
                                addMessageToChat(`--- Receiving chunked file: ${fileHeader.fileName}. Total chunks: ${fileHeader.totalChunks}. ---`, "system");
                            } else {
                                transfer.status = 'receiving_data';
                                expectingFileDataForId = fileHeader.fileId;
                                addMessageToChat(`--- Receiving small file: ${fileHeader.fileName}. Preparing for data... ---`, "system");
                            }
                            break;
                        case "file_chunk_header":
                            const chunkHeader = controlMsg;
                            log(`Received file_chunk_header for fileId: ${chunkHeader.fileId}, chunkNum: ${chunkHeader.chunkNum}`);
                            const transferChunk = incomingFileTransfers[chunkHeader.fileId];
                            if (transferChunk && transferChunk.status === 'receiving_chunks') {
                                expectingFileDataForId = chunkHeader.fileId;
                                expectingFileChunkNum = chunkHeader.chunkNum;
                                addMessageToChat(`--- Preparing for chunk ${chunkHeader.chunkNum + 1}/${transferChunk.totalChunks} of ${transferChunk.fileName}... ---`, "system");
                            } else {
                                log(`Warning: Received file_chunk_header for unknown/unexpected fileId: ${chunkHeader.fileId} or status not 'receiving_chunks'.`);
                            }
                            break;
                        default: log(`Unknown encrypted_control_message subType: ${msg.subType}`);
                    }
                } catch (error) { log(`Encrypted control msg error: ${error}`); console.error("Encrypted Control Msg Error:", error); addMessageToChat("--- Error processing secure control message. ---", "system");}

            } else if (msg.type === "file_offer_secure") {
                log(`Received secure file offer for fileId: ${msg.fileId}`);
                if (!myKeyPair) { log("Cannot decrypt file offer: keys missing."); addMessageToChat("--- Error: Cannot decrypt file offer. ---", "system"); return; }
                if (!peerPublicKeyPEM) { log("Peer public key unknown. Cannot accept file offer."); addMessageToChat("--- Error: Cannot accept file offer. ---", "system"); return; }
                try {
                    const decryptedDetailsJSON = myKeyPair.decrypt(msg.encryptedDetails);
                    if (!decryptedDetailsJSON) { log("Failed to decrypt file offer details."); addMessageToChat("--- Undecryptable file offer received. ---", "system"); return; }
                    const offerDetails = JSON.parse(decryptedDetailsJSON);
                    log(`Decrypted file offer: ${JSON.stringify(offerDetails)}`);
                    incomingFileTransfers[msg.fileId] = {
                        fileId: msg.fileId, fileName: offerDetails.fileName, fileSize: offerDetails.fileSize,
                        fileType: offerDetails.fileType, status: 'offered', chunks: [], receivedSize: 0
                    };
                    const friendlySize = (offerDetails.fileSize / 1024).toFixed(2) + " KB";
                    addMessageToChat(`--- Incoming file: ${offerDetails.fileName} (${friendlySize}). Auto-accepting. ---`, "system");
                    const acceptMessageDetails = { fileId: msg.fileId, status: "accepted" };
                    const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM);
                    const encryptedAcceptPayload = encrypt.encrypt(JSON.stringify(acceptMessageDetails));
                    if (!encryptedAcceptPayload) { log("Failed to encrypt file acceptance."); addMessageToChat("--- Error preparing file acceptance. ---", "system"); return; }
                    const messageToSend = { type: "encrypted_control_message", subType: "file_transfer_accept", payload: encryptedAcceptPayload };
                    dataChannel.send(JSON.stringify(messageToSend));
                    log(`Sent acceptance for fileId: ${msg.fileId}`);
                } catch (error) { log(`File offer processing error: ${error}`); console.error("File Offer Error:", error); addMessageToChat("--- Error processing file offer. ---", "system"); }

            } else if (msg.type === "username_exchange") {
                PEER_USERNAME = msg.username; log(`Peer username: ${PEER_USERNAME}`);
                addMessageToChat(`${PEER_USERNAME} has joined the chat.`, "system");
            } else if (msg.type === "public_key_exchange") {
                peerPublicKeyPEM = msg.publicKey; log("Received peer public key.");
                addMessageToChat("Public keys exchanged. Secure communication active.", "system");
            } else if (msg.type === "chat_secure") {
                if (!myKeyPair) { log("Private key missing for decryption."); addMessageToChat("--- Error: Cannot decrypt. Key missing. ---", "system"); return; }
                try {
                    log(`Ciphertext: ${msg.ciphertext.substring(0,30)}...`);
                    const decrypted = myKeyPair.decrypt(msg.ciphertext);
                    if (!decrypted) { log("Decryption failed."); addMessageToChat("--- Message decryption failed. ---", "system"); return; }
                    log(`Decrypted: ${decrypted}`); addMessageToChat(decrypted, "received");
                } catch (error) { log(`Decryption error: ${error}`); console.error("Decryption Error:", error); addMessageToChat("--- Message decryption error. ---", "system"); }
            } else {
                log(`Unknown data channel msg type: ${msg.type}`);
            }
        };
        channel.onerror = (errorEvent) => {
            log(`Data channel error: ${errorEvent.error}`); console.error("DataChannel error:", errorEvent.error);
            if (p2pStatusElement) p2pStatusElement.textContent = `P2P Error: ${errorEvent.error.message}. Refresh.`;
            addMessageToChat(`--- P2P Data Channel Error ---`, "system");
        };
    }

    function sendMessage() {
        const messageText = messageInput.value.trim();
        if (!messageText) return;
        if (!dataChannel || dataChannel.readyState !== 'open') { log("Error: Data channel not open."); addMessageToChat("--- Error: Data channel not open. ---", "system"); return; }
        if (!peerPublicKeyPEM || !myKeyPair) { log("Error: Keys not set up."); addMessageToChat("--- Error: Encryption keys not set up. ---", "system"); return; }
        try {
            log(`Encrypting: ${messageText}`);
            const encryptInstance = new JSEncrypt(); encryptInstance.setPublicKey(peerPublicKeyPEM);
            const encryptedMessage = encryptInstance.encrypt(messageText);
            if (!encryptedMessage) { log("Encryption failed."); addMessageToChat("--- Error: Encryption failed. ---", "system"); return; }
            log(`Sending encrypted: ${encryptedMessage.substring(0,30)}...`);
            dataChannel.send(JSON.stringify({ type: "chat_secure", ciphertext: encryptedMessage }));
            addMessageToChat(messageText, "sent"); messageInput.value = "";
        } catch (error) { log(`Encryption Error: ${error}`); console.error("Encryption Error:", error); addMessageToChat("--- Error: Encryption failed. ---", "system"); }
    }

    if (sendButton) sendButton.onclick = sendMessage;
    if (messageInput) {
        messageInput.onkeypress = (event) => { if (event.key === "Enter") { event.preventDefault(); sendMessage(); } };
        messageInput.disabled = true;
        if(sendButton) sendButton.disabled = true;
    }

    if (fileInputElement) {
        fileInputElement.addEventListener('change', (event) => {
            if (event.target.files && event.target.files.length > 0) {
                selectedFile = event.target.files[0];
                log(`File selected: ${selectedFile.name}`);
                addMessageToChat(`--- File selected: ${selectedFile.name}. Click "Send File". ---`, "system");
                if(sendFileButton && dataChannel && dataChannel.readyState === 'open') sendFileButton.disabled = false;
            } else {
                selectedFile = null; log("File selection cleared.");
                if(sendFileButton) sendFileButton.disabled = true;
            }
        });
    }

    if (sendFileButton) {
        sendFileButton.disabled = true;
        sendFileButton.onclick = () => { // Removed async here, initiateFileSend is async
            if (!selectedFile) { addMessageToChat("--- Select a file first. ---", "system"); return; }
            if (!dataChannel || dataChannel.readyState !== 'open') { addMessageToChat("--- P2P connection not ready. ---", "system"); return; }
            if (!peerPublicKeyPEM || !myKeyPair) { addMessageToChat("--- Encryption keys not set up for file offer. ---", "system"); return; }

            const fileId = `${Date.now()}-${USERNAME}-${Math.random().toString(36).substring(2, 9)}`;
            // Store the file in pendingFileTransfers BEFORE calling initiateFileSend,
            // as initiateFileSend will need it for the hash calculation.
            pendingFileTransfers[fileId] = {
                file: selectedFile, // Store the actual File object
                status: 'offering', // Initial status before acceptance
                name: selectedFile.name,
                size: selectedFile.size
            };

            // Now craft the offer message (which doesn't need the file content, just metadata)
            const offerDetails = {
                fileName: selectedFile.name,
                fileSize: selectedFile.size,
                fileType: selectedFile.type || "application/octet-stream"
            };

            try {
                log(`Encrypting file offer: ${JSON.stringify(offerDetails)}`);
                const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM);
                const encryptedOfferDetails = encrypt.encrypt(JSON.stringify(offerDetails));
                if (!encryptedOfferDetails) {
                    log("File offer encryption failed.");
                    addMessageToChat("--- Error encrypting file details. ---", "system");
                    delete pendingFileTransfers[fileId]; // Clean up
                    return;
                }
                const messageToSend = { type: "file_offer_secure", fileId: fileId, encryptedDetails: encryptedOfferDetails };
                dataChannel.send(JSON.stringify(messageToSend));
                log(`Sent file offer: ${fileId}`);
                addMessageToChat(`--- Offering: ${selectedFile.name} (${(selectedFile.size / 1024).toFixed(2)} KB). Waiting... ---`, "system");

                // Update status after successfully sending the offer
                pendingFileTransfers[fileId].status = 'offered';

                fileInputElement.value = ''; selectedFile = null; sendFileButton.disabled = true;
            } catch (error) {
                log(`File Offer Error: ${error}`); console.error("File Offer Error:", error);
                addMessageToChat("--- Error sending file offer. ---", "system");
                delete pendingFileTransfers[fileId]; // Clean up
            }
        };
    }

    const signalingServerUrl = "wss://thing-1-gzkh.onrender.com";
    let ws;
    function connectWebSocket() {
        if (!signalingStatusElement || !p2pStatusElement || !chatArea || !messageInput || !sendButton) {
            console.error('Required DOM elements not found.');
            const statusElem = document.getElementById('signaling-status') || document.getElementById('p2p-status');
            if(statusElem) statusElem.textContent = "Init Error: Missing page elements."; return;
        }
        if (signalingStatusElement) signalingStatusElement.textContent = "Connecting to signaling server...";
        ws = new WebSocket(signalingServerUrl);
        ws.onopen = () => {
            log(`Connected to signaling server.`); ws.send(JSON.stringify({ type: "join", room: ROOM_NAME }));
            log(`Sent join for room: ${ROOM_NAME}`); initializePeerConnection();
            ws.send(JSON.stringify({ type: "ready", room: ROOM_NAME }));
            log(`Sent ready for room: ${ROOM_NAME}`);
            if (signalingStatusElement) signalingStatusElement.textContent = `Joined room '${ROOM_NAME}'. Waiting for peer...`;
            addMessageToChat(`--- Joined room '${ROOM_NAME}'. Waiting for peer... ---`, "system");
        };
        ws.onmessage = async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); }
            catch (e) { log(`Received non-JSON from signaling: ${event.data}`); return; }
            if (msg.room && msg.room !== ROOM_NAME) { log(`Ignoring signaling for room ${msg.room}`); return; }
            log(`Signaling msg: ${msg.type}`);
            switch (msg.type) {
                case "offer":
                    log("Received offer."); if (!pc) initializePeerConnection();
                    if (pc) await createAnswer(msg.offer); else log("PC not ready for offer."); break;
                case "answer":
                    log("Received answer.");
                    if (pc) { try { await pc.setRemoteDescription(new RTCSessionDescription(msg.answer)); }
                        catch (e) { log(`Error setting remote (answer): ${e}`); console.error("Set remote answer error:", e); }}
                    else log("PC not ready for answer."); break;
                case "candidate":
                    log("Received ICE candidate.");
                    if (pc && msg.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
                        catch (e) { log(`Error adding ICE candidate: ${e}`); console.error("Add ICE candidate error:", e); }}
                    else if (!pc) log("PC not init for ICE candidate."); break;
                case "ready":
                    log("Received ready from peer.");
                    if (pc && pc.signalingState === "stable") {
                        log("Peer ready, I am stable. Creating offer.");
                        addMessageToChat("--- Peer is ready. Attempting P2P... ---", "system");
                        await createOffer();
                    } else if (pc) log(`Peer ready, my state ${pc.signalingState}. Not offering.`);
                    else log("Peer ready, my PC not init. Unexpected."); break;
                default: log(`Unknown signaling type: ${msg.type}`);
            }
        };
        ws.onerror = (event) => {
            log(`WebSocket error: ${event.type}.`); console.error("WebSocket error:", event);
            if (signalingStatusElement) signalingStatusElement.textContent = "Error with signaling. Refresh.";
            addMessageToChat("--- Signaling error. P2P might fail. ---", "system");
            if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect.") {
                p2pStatusElement.textContent = "P2P Lost (Signaling Error)";
            }
        };
        ws.onclose = (event) => {
            log(`Disconnected from signaling. Code: ${event.code}, Clean: ${event.wasClean}`);
            if (!dataChannel || dataChannel.readyState !== "open") {
                if (signalingStatusElement) signalingStatusElement.textContent = event.wasClean ? "Signaling disconnected." : "Lost signaling. Refresh.";
                addMessageToChat(event.wasClean ? "--- Signaling disconnected. ---" : "--- Lost signaling. ---", "system");
                if (p2pStatusElement && p2pStatusElement.textContent !== "P2P Disconnected. Refresh to reconnect." && (!pc || pc.iceConnectionState !== "connected")) {
                    p2pStatusElement.textContent = "P2P Disconnected (Signaling Closed)";
                }
            } else {
                if (signalingStatusElement) signalingStatusElement.textContent = "Signaling disconnected (P2P active).";
                log("WS closed, P2P active.");
            }
        };
    }
    connectWebSocket();
});

[end of static/js/main.js]

[end of static/js/main.js]

[end of static/js/main.js]

[end of static/js/main.js]
