'use strict';

// File Transfer Plugin
// Depends on core.js for:
// - log(message)
// - addMessageToChat(messageText, messageType, timestamp)
// - sendDataChannelMessage(messageObject)
// - calculateFileHash(fileOrBlob)
// - readBlobAsArrayBuffer(blob)
// - myKeyPair, peerPublicKeyPEM, USERNAME (globals)
// - Constants: CHUNK_SIZE, LARGE_FILE_THRESHOLD, MAX_FILE_SIZE_FOR_HASHING (from core.js)
// - Lightbox elements: lightboxModal, lightboxImage (from core.js for displayReceivedFile)
// - dataChannel (global from core.js, for checking state before sending)

// Plugin-specific global variables for file transfer state
let ft_selectedFile = null;
let ft_pendingFileTransfers = {};
let ft_incomingFileTransfers = {};
// These are the plugin's own state variables to manage binary data expectations
let ft_expectingFileId = null;
let ft_expectingChunkNum = undefined;
let ft_isProcessingBinary = false; // Flag to indicate if plugin is expecting a binary chunk/file next

// UI Elements (will be fetched in initFileTransfer)
let ft_fileInputElement = null;
let ft_sendFileButton = null;
let ft_chatArea = null;


function displayReceivedFile(fileBlob, fileName, fileSize, fileType, fullFileHash, originalHashProvided, chatAreaElement, previewId = null) {
    // This function is moved from the old main.js.
    // It needs access to 'log', 'calculateFileHash' from core.js
    // and lightboxModal, lightboxImage from core.js
    if (typeof log !== 'function') { console.error("displayReceivedFile: log function is missing."); return; }
    log(`FileTransfer Plugin: Displaying received file: ${fileName}, Type: ${fileType}${previewId ? ', PreviewID: ' + previewId : ''}`);

    const messageDiv = document.createElement('div');
    if (previewId) {
        messageDiv.id = previewId;
    }
    messageDiv.classList.add('message', 'system-message'); // Using system-message for file entries

    const performDisplay = (calculatedHashMatchStatus) => {
        if (fileType && fileType.startsWith('image/')) {
            const imgPreviewElement = document.createElement('img');
            const previewBlobUrl = URL.createObjectURL(fileBlob);
            imgPreviewElement.src = previewBlobUrl;
            imgPreviewElement.alt = fileName;
            imgPreviewElement.style.maxWidth = '100%';
            imgPreviewElement.style.maxHeight = '200px';
            imgPreviewElement.style.display = 'block';
            imgPreviewElement.style.cursor = 'pointer';
            imgPreviewElement.title = 'Click to enlarge';
            imgPreviewElement.originalFileBlob = fileBlob; // Store the original blob

            imgPreviewElement.onload = function() { URL.revokeObjectURL(this.src); };
            imgPreviewElement.onerror = function() { try { URL.revokeObjectURL(this.src); } catch (e) { /* ignore */ } this.alt = 'Preview failed'; };
            imgPreviewElement.onclick = function() {
                if (lightboxModal && lightboxImage) { // lightboxModal and lightboxImage are from core.js
                    if (lightboxImage.src && lightboxImage.src.startsWith('blob:')) {
                        try { URL.revokeObjectURL(lightboxImage.src); } catch (e) { /* ignore */ }
                    }
                    lightboxImage.src = '';
                    if (this.originalFileBlob) { // Use the stored original blob for the lightbox
                        lightboxImage.src = URL.createObjectURL(this.originalFileBlob);
                    } else { lightboxImage.src = this.src; } // Fallback, though originalFileBlob should exist
                    lightboxModal.style.display = 'flex';
                }
            };
            messageDiv.appendChild(imgPreviewElement);
        } else if (fileType && fileType.startsWith('video/')) {
            const videoElement = document.createElement('video');
            videoElement.src = URL.createObjectURL(fileBlob);
            videoElement.controls = true; videoElement.preload = 'metadata';
            videoElement.style.maxWidth = '300px'; videoElement.style.maxHeight = '200px';
            videoElement.onerror = function() { try { URL.revokeObjectURL(this.src); } catch(e) {/*ignore*/} };
            messageDiv.appendChild(videoElement);
        } else if (fileType && fileType.startsWith('audio/')) {
            const audioElement = document.createElement('audio');
            audioElement.src = URL.createObjectURL(fileBlob);
            audioElement.controls = true; audioElement.preload = 'metadata';
            audioElement.onerror = function() { try { URL.revokeObjectURL(this.src); } catch(e) {/*ignore*/} };
            messageDiv.appendChild(audioElement);
        }

        const linkContainer = document.createElement('div');
        linkContainer.classList.add('file-download-container');
        const isMediaPreview = fileType && (fileType.startsWith('image/') || fileType.startsWith('video/') || fileType.startsWith('audio/'));
        if (isMediaPreview) linkContainer.style.marginTop = '5px';

        const downloadLink = document.createElement('a');
        downloadLink.href = URL.createObjectURL(fileBlob); // Create a fresh URL for download
        downloadLink.download = fileName;
        let linkText = originalHashProvided ? `Download: ${fileName} (${(fileSize / 1024).toFixed(2)} KB)` : `Local Preview: ${fileName} (${(fileSize / 1024).toFixed(2)} KB)`;
        if (!isMediaPreview && originalHashProvided) linkText = `Download: ${fileName} (${(fileSize / 1024).toFixed(2)} KB)`;
        else if (!isMediaPreview && !originalHashProvided) linkText = `${fileName} (${(fileSize / 1024).toFixed(2)} KB)`;


        downloadLink.textContent = linkText;

        if (!isMediaPreview) {
            const icon = document.createElement('span'); icon.textContent = '📄 ';
            linkContainer.appendChild(icon);
        }

        if (originalHashProvided) {
            if (fullFileHash === "hash_skipped_large_file") {
                const skippedIndicator = document.createElement('span');
                skippedIndicator.textContent = ' (Checksum: N/A - sender skipped)';
                skippedIndicator.style.fontStyle = 'italic'; skippedIndicator.style.fontSize = '0.9em';
                downloadLink.appendChild(skippedIndicator);
            } else if (calculatedHashMatchStatus === "MISMATCH!") {
                downloadLink.style.color = 'red';
                const mismatchIndicator = document.createElement('span');
                mismatchIndicator.textContent = ' (Checksum Mismatch!)';
                downloadLink.appendChild(mismatchIndicator);
            } else if (calculatedHashMatchStatus === "Error calculating hash") {
                downloadLink.style.color = 'orange';
                const errorIndicator = document.createElement('span');
                errorIndicator.textContent = ' (Hash Check Error)';
                downloadLink.appendChild(errorIndicator);
            }
        }
        linkContainer.appendChild(downloadLink);
        messageDiv.appendChild(linkContainer);
        chatAreaElement.appendChild(messageDiv);
        chatAreaElement.scrollTop = chatAreaElement.scrollHeight;
        log(`FileTransfer Plugin: File display created for ${fileName}. Checksum status: ${calculatedHashMatchStatus}`);
    };

    if (originalHashProvided && fullFileHash !== "hash_skipped_large_file") {
        if (typeof calculateFileHash !== 'function') {
             console.error("displayReceivedFile: calculateFileHash function is missing.");
             performDisplay("Error: Hash function unavailable"); return;
        }
        calculateFileHash(fileBlob).then(receivedFileHashHex => {
            let status = "Error calculating hash";
            if (receivedFileHashHex) {
                status = (receivedFileHashHex === fullFileHash) ? "OK" : "MISMATCH!";
            }
            performDisplay(status);
        }).catch(error => {
            log(`FileTransfer Plugin: Error calculating file hash for display: ${error}`);
            performDisplay("Error calculating hash");
        });
    } else if (originalHashProvided && fullFileHash === "hash_skipped_large_file") {
        performDisplay("N/A (Sender skipped for large file)");
    } else {
        performDisplay("N/A (Local Preview)");
    }
}

async function ft_initiateFileSend(fileId) {
    // Moved from main.js, adapted for plugin context
    // Needs: ft_pendingFileTransfers, log, calculateFileHash, addMessageToChat,
    // LARGE_FILE_THRESHOLD, CHUNK_SIZE, JSEncrypt, peerPublicKeyPEM, dataChannel,
    // readBlobAsArrayBuffer, sendDataChannelMessage, displayReceivedFile, ft_chatArea
    log(`FileTransferPlugin: ft_initiateFileSend() called for fileId: ${fileId}`);
    const transferInfo = ft_pendingFileTransfers[fileId];
    if (!transferInfo || transferInfo.status !== 'accepted' || !transferInfo.file) {
        log(`FileTransferPlugin: Error: Cannot send file for fileId ${fileId}. Status: ${transferInfo ? transferInfo.status : 'unknown'}, File: ${transferInfo ? transferInfo.file : 'missing'}`);
        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error: Could not start sending file ${transferInfo ? transferInfo.file.name : fileId}. ---`, "system");
        return;
    }

    const file = transferInfo.file;
    log(`FileTransfer Plugin: Calculating hash for file: ${file.name}`);
    const fullFileHashHex = await calculateFileHash(file); // calculateFileHash from core.js
    if (!fullFileHashHex) {
        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error calculating hash for ${file.name}. Send cancelled. ---`, "system");
        ft_pendingFileTransfers[fileId].status = 'error_hashing';
        return;
    }
    log(`FileTransfer Plugin: Calculated SHA-256 hash for ${file.name}: ${fullFileHashHex.substring(0,10)}...`);
    ft_pendingFileTransfers[fileId].status = 'sending_data';

    const fileDataHeaderBase = {
        fileId: fileId,
        fileSize: file.size,
        fullFileHash: fullFileHashHex
    };

    try {
        const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM); // peerPublicKeyPEM from core

        if (file.size > LARGE_FILE_THRESHOLD) { // LARGE_FILE_THRESHOLD from core
            fileDataHeaderBase.isChunked = true;
            fileDataHeaderBase.totalChunks = Math.ceil(file.size / CHUNK_SIZE); // CHUNK_SIZE from core
            const encryptedHeaderPayload = encrypt.encrypt(JSON.stringify(fileDataHeaderBase));
            if (!encryptedHeaderPayload) { throw new Error("Error encrypting chunked file_data_header."); }

            sendDataChannelMessage({ type: "encrypted_control_message", subType: "file_data_header", payload: encryptedHeaderPayload });
            log(`FileTransfer Plugin: Sent encrypted file_data_header for chunked file ${file.name}`);

            const localPreviewId = 'local-preview-' + fileId;
            const previewElement = document.getElementById(localPreviewId);
            if (previewElement && transferInfo.file && (transferInfo.file.type.startsWith('image/') || transferInfo.file.type.startsWith('video/') || transferInfo.file.type.startsWith('audio/'))) {
                const linkElement = previewElement.querySelector('.file-download-container a');
                if (linkElement) {
                    linkElement.textContent = `Download: ${transferInfo.name} (${(transferInfo.size / 1024).toFixed(2)} KB)`;
                    let childSpan = linkElement.querySelector('span');
                    while(childSpan) { linkElement.removeChild(childSpan); childSpan = linkElement.querySelector('span'); }
                    linkElement.style.color = '';
                }
            } else if (!previewElement && transferInfo && transferInfo.file) {
                 displayReceivedFile(transferInfo.file, transferInfo.name, transferInfo.size, transferInfo.file.type || "application/octet-stream", fullFileHashHex, true, ft_chatArea, null);
            }

            // Start of new chunk sending logic
            let currentChunk = 0;
            const totalChunks = fileDataHeaderBase.totalChunks;

            const MCIF_MIN = 2;
            const MCIF_MAX = 8;
            const MCIF_INITIAL = 4;
            const MCIF_ADJUST_SUCCESS_THRESHOLD = 3; // No. of full bursts before trying to increase
            const MCIF_ADJUST_HWM_HIT_THRESHOLD = 2;   // No. of HWM hits before trying to decrease

            let dynamic_mcif = MCIF_INITIAL;
            let current_high_water_mark = CHUNK_SIZE * dynamic_mcif;

            let successful_bursts_since_last_adjust = 0;
            let hwm_hits_since_last_adjust = 0;
            let mcif_at_burst_start = dynamic_mcif; // Store MCIF value used for the current burst

            function adjustMcifParameters(burst_hit_hwm, burst_was_full_and_no_hwm) {
                if (burst_hit_hwm) {
                    hwm_hits_since_last_adjust++;
                    successful_bursts_since_last_adjust = 0; // Reset success counter on any HWM hit
                    if (hwm_hits_since_last_adjust >= MCIF_ADJUST_HWM_HIT_THRESHOLD) {
                        if (dynamic_mcif > MCIF_MIN) {
                            dynamic_mcif--;
                            log(`FileTransfer Plugin: Dynamic MCIF decreased to ${dynamic_mcif}`);
                        }
                        hwm_hits_since_last_adjust = 0; // Reset after adjustment
                    }
                } else if (burst_was_full_and_no_hwm) {
                    successful_bursts_since_last_adjust++;
                    // Don't reset hwm_hits_since_last_adjust here, allow it to persist until an actual HWM hit.
                    if (successful_bursts_since_last_adjust >= MCIF_ADJUST_SUCCESS_THRESHOLD) {
                        if (dynamic_mcif < MCIF_MAX) {
                            dynamic_mcif++;
                            log(`FileTransfer Plugin: Dynamic MCIF increased to ${dynamic_mcif}`);
                        }
                        successful_bursts_since_last_adjust = 0; // Reset after adjustment
                    }
                }
                // Update high water mark for the next burst operation
                current_high_water_mark = CHUNK_SIZE * dynamic_mcif;
            }

            async function sendNextChunk() {
                mcif_at_burst_start = dynamic_mcif;
                log(`FileTransfer Plugin: sendNextChunk called. currentChunk: ${currentChunk + 1}/${totalChunks}, bufferedAmount: ${dataChannel.bufferedAmount}, dynamic_mcif: ${dynamic_mcif}, mcif_at_burst_start: ${mcif_at_burst_start}`);

                if (currentChunk >= totalChunks) {
                    // This case should ideally be caught after a burst or by the initial check.
                    // If reached, it means sendNextChunk was called when all chunks were already processed.
                    log(`FileTransfer Plugin: sendNextChunk called but all chunks already processed for ${file.name}.`);
                    if (ft_pendingFileTransfers[fileId].status !== 'sent_all_chunks') {
                         ft_pendingFileTransfers[fileId].status = 'sent_all_chunks';
                         log(`FileTransfer Plugin: Corrected status to 'sent_all_chunks' for ${file.name}`);
                    }
                    if (dataChannel && dataChannel.onbufferedamountlow === handleBufferedAmountLow) {
                        dataChannel.onbufferedamountlow = null;
                    }
                    return;
                }

                if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') {
                    log(`FileTransfer Plugin: Data channel closed mid-transfer for ${file.name}. Aborting.`);
                    ft_pendingFileTransfers[fileId].status = 'error_sending_channel_closed';
                    if (dataChannel && dataChannel.onbufferedamountlow === handleBufferedAmountLow) {
                        dataChannel.onbufferedamountlow = null;
                    }
                    if (typeof addMessageToChat === 'function') addMessageToChat(`--- Data channel closed while sending ${file.name}. Transfer aborted. ---`, "system");
                    return;
                }

                let chunksSentInBurst = 0;
                while (currentChunk < totalChunks && chunksSentInBurst < mcif_at_burst_start) {
                    if (dataChannel.bufferedAmount >= current_high_water_mark) {
                        log(`FileTransfer Plugin: Buffer high for ${file.name} (at ${dataChannel.bufferedAmount} >= ${current_high_water_mark}). Waiting for bufferedamountlow.`);
                        dataChannel.onbufferedamountlow = handleBufferedAmountLow;
                        return;
                    }

                    const start = currentChunk * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunkBlob = file.slice(start, end);
                    let chunkArrayBuffer;
                    try {
                        chunkArrayBuffer = await readBlobAsArrayBuffer(chunkBlob);
                    } catch (error) {
                        log(`FileTransfer Plugin: Error reading chunk ${currentChunk + 1} for ${file.name}: ${error}. Aborting.`);
                        ft_pendingFileTransfers[fileId].status = 'error_reading_chunk';
                        if (dataChannel && dataChannel.onbufferedamountlow === handleBufferedAmountLow) {
                            dataChannel.onbufferedamountlow = null;
                        }
                        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error reading file chunk ${currentChunk + 1} for ${file.name}. Transfer aborted. ---`, "system");
                        return;
                    }

                    const chunkHeader = { fileId: fileId, chunkNum: currentChunk, chunkSize: chunkArrayBuffer.byteLength };
                    const encryptedChunkHeaderPayload = encrypt.encrypt(JSON.stringify(chunkHeader));
                    if (!encryptedChunkHeaderPayload) {
                        log(`FileTransfer Plugin: Error encrypting chunk header ${currentChunk + 1} for ${file.name}. Aborting.`);
                        ft_pendingFileTransfers[fileId].status = 'error_encrypting_chunk_header';
                         if (dataChannel && dataChannel.onbufferedamountlow === handleBufferedAmountLow) {
                            dataChannel.onbufferedamountlow = null;
                        }
                        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error preparing chunk ${currentChunk + 1} for ${file.name}. Transfer aborted. ---`, "system");
                        return;
                    }

                    sendDataChannelMessage({ type: "encrypted_control_message", subType: "file_chunk_header", payload: encryptedChunkHeaderPayload });
                    dataChannel.send(chunkArrayBuffer);
                    log(`FileTransfer Plugin: Sent chunk ${currentChunk + 1}/${totalChunks} for ${file.name}. Buffered amount: ${dataChannel.bufferedAmount}, MCIF at burst start: ${mcif_at_burst_start}`);
                    if(ft_pendingFileTransfers[fileId]) ft_pendingFileTransfers[fileId].sentChunks = (ft_pendingFileTransfers[fileId].sentChunks || 0) + 1;

                    currentChunk++;
                    chunksSentInBurst++;
                }

                let burst_hit_hwm = (chunksSentInBurst < mcif_at_burst_start && currentChunk < totalChunks);
                let sent_all_planned_chunks_for_burst = (chunksSentInBurst === mcif_at_burst_start);
                let full_successful_burst_for_increase = sent_all_planned_chunks_for_burst && !burst_hit_hwm;

                if (currentChunk < totalChunks || burst_hit_hwm) {
                     adjustMcifParameters(burst_hit_hwm, full_successful_burst_for_increase);
                }

                if (currentChunk < totalChunks) {
                    log(`FileTransfer Plugin: Burst of ${chunksSentInBurst} chunks sent for ${file.name}. Scheduling next call to sendNextChunk. Next chunk: ${currentChunk + 1}, Buffered: ${dataChannel.bufferedAmount}, Next MCIF: ${dynamic_mcif}`);
                    Promise.resolve().then(sendNextChunk);
                } else {
                    ft_pendingFileTransfers[fileId].status = 'sent_all_chunks';
                    log(`FileTransfer Plugin: All ${totalChunks} chunks sent for ${file.name} after final burst of ${chunksSentInBurst}. Final MCIF: ${dynamic_mcif}`);
                    if (dataChannel && dataChannel.onbufferedamountlow === handleBufferedAmountLow) {
                        dataChannel.onbufferedamountlow = null;
                    }
                }
            }

            function handleBufferedAmountLow() {
                log(`FileTransfer Plugin: bufferedamountlow event fired for ${file.name}. Resuming send. Buffered amount: ${dataChannel.bufferedAmount}, Current MCIF: ${dynamic_mcif}`);
                if (dataChannel) {
                    dataChannel.onbufferedamountlow = null;
                }
                // Ensure we still have chunks to send and the channel is open
                if (currentChunk < totalChunks && dataChannel && dataChannel.readyState === 'open') {
                    adjustMcifParameters(true, false);
                    sendNextChunk();
                } else {
                    log(`FileTransfer Plugin: bufferedamountlow fired but conditions not met to resume for ${file.name}. Current chunk: ${currentChunk + 1}/${totalChunks}, Channel state: ${dataChannel ? dataChannel.readyState : 'N/A'}`);
                    if (currentChunk >= totalChunks && ft_pendingFileTransfers[fileId] && ft_pendingFileTransfers[fileId].status !== 'sent_all_chunks') {
                         ft_pendingFileTransfers[fileId].status = 'sent_all_chunks';
                         log(`FileTransfer Plugin: Marked as all chunks sent for ${file.name} from bufferedamountlow handler (post-loop).`);
                    }
                }
            }
            // Initiate the sending process
            sendNextChunk();

        } else { // Small file
            fileDataHeaderBase.isChunked = false;
            const encryptedHeaderPayload = encrypt.encrypt(JSON.stringify(fileDataHeaderBase));
            if (!encryptedHeaderPayload) { throw new Error("Error encrypting small file_data_header."); }

            const reader = new FileReader();
            reader.onload = (event) => {
                const arrayBuffer = event.target.result;
                sendDataChannelMessage({ type: "encrypted_control_message", subType: "file_data_header", payload: encryptedHeaderPayload });
                log(`FileTransfer Plugin: Sent encrypted file_data_header for small file ${file.name}`);

                const localPreviewIdSmall = 'local-preview-' + fileId;
                const previewElementSmall = document.getElementById(localPreviewIdSmall);
                 if (previewElementSmall && transferInfo.file && (transferInfo.file.type.startsWith('image/') || transferInfo.file.type.startsWith('video/') || transferInfo.file.type.startsWith('audio/'))) {
                    const linkElement = previewElementSmall.querySelector('.file-download-container a');
                    if (linkElement) {
                        linkElement.textContent = `Download: ${transferInfo.name} (${(transferInfo.size / 1024).toFixed(2)} KB)`;
                         let childSpan = linkElement.querySelector('span');
                        while(childSpan) { linkElement.removeChild(childSpan); childSpan = linkElement.querySelector('span'); }
                        linkElement.style.color = '';
                    }
                } else if (!previewElementSmall && transferInfo && transferInfo.file) {
                    displayReceivedFile(transferInfo.file, transferInfo.name, transferInfo.size, transferInfo.file.type || "application/octet-stream", fullFileHashHex, true, ft_chatArea, null);
                }

                if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') { throw new Error("Data channel closed before sending small file"); }
                dataChannel.send(arrayBuffer);
                log(`FileTransfer Plugin: Sent ArrayBuffer for small file ${file.name}`);
                ft_pendingFileTransfers[fileId].status = 'sent_data';
            };
            reader.onerror = (error) => { throw new Error(`Error reading small file: ${error}`); };
            reader.readAsArrayBuffer(file);
        }
    } catch (error) {
        log(`FileTransfer Plugin: Error during file send for ${file.name}: ${error}`);
        console.error("File Send Error (Plugin):", error);
        ft_pendingFileTransfers[fileId].status = `error_sending: ${error.message}`;
        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error sending ${file.name}. Transfer aborted. ---`, "system");
    }
}

async function ft_assembleFileFromChunks(fileId) {
    // Moved from main.js, adapted for plugin context
    // Needs: ft_incomingFileTransfers, log, calculateFileHash, addMessageToChat, displayReceivedFile, ft_chatArea
    log(`FileTransferPlugin: ft_assembleFileFromChunks() called for fileId: ${fileId}`);
    const transferInfo = ft_incomingFileTransfers[fileId];
    if (!transferInfo || !transferInfo.chunks || transferInfo.receivedChunksCount !== transferInfo.totalChunks) {
        log(`FileTransferPlugin: Error assembling file ${fileId}: Missing info or not all chunks. Received: ${transferInfo ? transferInfo.receivedChunksCount : 'N/A'}, Expected: ${transferInfo ? transferInfo.totalChunks : 'N/A'}`);
        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error: Could not assemble file ${transferInfo ? transferInfo.fileName : fileId}. Data incomplete. ---`, "system");
        if(transferInfo) transferInfo.status = 'error_assembling';
        return;
    }

    log(`FileTransfer Plugin: Assembling file ${transferInfo.fileName} (ID: ${fileId}) from ${transferInfo.totalChunks} chunks.`);
    try {
        for (let i = 0; i < transferInfo.totalChunks; i++) {
            if (!transferInfo.chunks[i]) { throw new Error(`Chunk ${i} is missing for file ${fileId}.`); }
        }
        const completeFileBlob = new Blob(transferInfo.chunks, { type: transferInfo.fileType || 'application/octet-stream' });
        log(`FileTransfer Plugin: File ${transferInfo.fileName} assembled. Size: ${completeFileBlob.size}`);

        if (completeFileBlob.size !== transferInfo.fileSize) {
            log(`FileTransfer Plugin: Warning: Assembled file size (${completeFileBlob.size}) does not match expected size (${transferInfo.fileSize}).`);
            if (typeof addMessageToChat === 'function') addMessageToChat(`--- Warning: Assembled file size for ${transferInfo.fileName} is ${completeFileBlob.size} bytes, but sender reported ${transferInfo.fileSize} bytes. ---`, "system");
        }

        displayReceivedFile(completeFileBlob, transferInfo.fileName, transferInfo.fileSize, transferInfo.fileType, transferInfo.fullFileHash, !!transferInfo.fullFileHash, ft_chatArea);
        transferInfo.status = 'received_data_complete'; // Or set based on hash check in displayReceivedFile if preferred

    } catch (error) {
        log(`FileTransfer Plugin: Error during file assembly for ${transferInfo.fileName}: ${error}`);
        console.error("File Assembly Error (Plugin):", error);
        if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error assembling file data for ${transferInfo.fileName}. ---`, "system");
        transferInfo.status = 'error_assembling';
    } finally {
        if (transferInfo && transferInfo.chunks) { delete transferInfo.chunks; log(`FileTransfer Plugin: Cleaned up chunks for fileId ${fileId}`); }
    }
}


function initFileTransfer() {
    if (typeof log !== 'function') { console.error("FileTransferPlugin: Core 'log' function not available."); return; }
    log('FileTransferPlugin: initFileTransfer() called.');

    ft_fileInputElement = document.getElementById('file-input');
    ft_sendFileButton = document.getElementById('send-file-button');
    ft_chatArea = document.getElementById('chat-area'); // Needed for displayReceivedFile

    log(`FileTransferPlugin: file-input element: ${ft_fileInputElement ? 'found' : 'NOT FOUND'}`);
    log(`FileTransferPlugin: send-file-button element: ${ft_sendFileButton ? 'found' : 'NOT FOUND'}`);
    log(`FileTransferPlugin: chat-area element (for displayReceivedFile): ${ft_chatArea ? 'found' : 'NOT FOUND'}`);


    if (!ft_fileInputElement || !ft_sendFileButton || !ft_chatArea) {
        log("FileTransferPlugin: Required UI elements not found. Aborting initFileTransfer.");
        return;
    }

    ft_fileInputElement.disabled = false;
    ft_sendFileButton.disabled = true; // Disabled until a file is selected
    // Log for enabling buttons is good, but event listener attachment log is more comprehensive
    // log("FileTransferPlugin: File input enabled, send button initially disabled.");

    ft_fileInputElement.addEventListener('change', (event) => {
        if (event.target.files && event.target.files.length > 0) {
            ft_selectedFile = event.target.files[0];
            log(`FileTransferPlugin: File selected via input: ${ft_selectedFile.name}`);
            // Enable send button only if P2P is ready and a file is selected
            ft_sendFileButton.disabled = !(typeof dataChannel !== 'undefined' && dataChannel && dataChannel.readyState === 'open' && ft_selectedFile);
        } else {
            ft_selectedFile = null;
            log("FileTransferPlugin: File selection cleared via input.");
            ft_sendFileButton.disabled = true;
        }
    });

    ft_sendFileButton.onclick = () => {
        log('FileTransferPlugin: send-file-button clicked.');
        if (!ft_selectedFile) { if (typeof addMessageToChat === 'function') addMessageToChat("--- Select a file first. ---", "system"); return; }
        if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') { if (typeof addMessageToChat === 'function') addMessageToChat("--- P2P connection not ready. ---", "system"); return; }
        if (!peerPublicKeyPEM || !myKeyPair) { if (typeof addMessageToChat === 'function') addMessageToChat("--- Encryption keys not set up for file offer. ---", "system"); return; }

        const fileId = `${Date.now()}-${USERNAME}-${Math.random().toString(36).substring(2, 9)}`; // USERNAME from core
        ft_pendingFileTransfers[fileId] = {
            file: ft_selectedFile, status: 'offering', name: ft_selectedFile.name, size: ft_selectedFile.size
        };

        if (ft_selectedFile.type.startsWith('image/') || ft_selectedFile.type.startsWith('video/') || ft_selectedFile.type.startsWith('audio/')) {
            displayReceivedFile(ft_selectedFile, ft_selectedFile.name, ft_selectedFile.size, ft_selectedFile.type, null, false, ft_chatArea, `local-preview-${fileId}`);
        }

        const offerDetails = { fileName: ft_selectedFile.name, fileSize: ft_selectedFile.size, fileType: ft_selectedFile.type || "application/octet-stream" };
        try {
            const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM); // peerPublicKeyPEM from core
            const encryptedOfferDetails = encrypt.encrypt(JSON.stringify(offerDetails));
            if (!encryptedOfferDetails) { throw new Error("File offer encryption failed."); }

            sendDataChannelMessage({ type: "file_offer_secure", fileId: fileId, encryptedDetails: encryptedOfferDetails }); // sendDataChannelMessage from core
            log(`FileTransfer plugin: Sent file offer: ${fileId}`);
            if (typeof addMessageToChat === 'function') addMessageToChat(`--- Offering file: ${ft_selectedFile.name}. Waiting... ---`, "system");
            ft_pendingFileTransfers[fileId].status = 'offered';
            ft_fileInputElement.value = ''; ft_selectedFile = null; ft_sendFileButton.disabled = true;
        } catch (error) {
            log(`FileTransfer plugin: File Offer Error: ${error}`); console.error("File Offer Error (Plugin):", error);
            if (typeof addMessageToChat === 'function') addMessageToChat("--- Error sending file offer. ---", "system");
            delete ft_pendingFileTransfers[fileId];
        }
    };
    log('FileTransferPlugin: Added event listeners for file transfer UI elements.');

    // Listen for messages from core.js
    document.addEventListener('core-control-message-received', (event) => {
        const { subType, decryptedPayload } = event.detail; // Using decryptedPayload as per core.js update
        log(`FileTransferPlugin: core-control-message-received event, subType: ${subType}`);

        switch (subType) {
            case "file_transfer_accept": // For the original sender of the file
                log(`FileTransferPlugin: Handling ${subType} control message.`);
                const acceptedFileId = decryptedPayload.fileId;
                const transferDetails = ft_pendingFileTransfers[acceptedFileId];
                if (transferDetails && decryptedPayload.status === "accepted") {
                    transferDetails.status = 'accepted';
                    if (typeof addMessageToChat === 'function') addMessageToChat(`--- Peer accepted file: ${transferDetails.name}. Starting send... ---`, "system");
                    ft_initiateFileSend(acceptedFileId);
                } else {
                    log(`FileTransferPlugin: Warn: Acceptance for fileId '${acceptedFileId}' not processed or not found/status not 'accepted'.`);
                }
                break;
            case "file_data_header": // For receiver
                log(`FileTransferPlugin: Handling ${subType} control message.`);
                const fileHeader = decryptedPayload;
                log(`FileTransferPlugin: Received file_data_header for ID: ${fileHeader.fileId}, Name (from header, if any): ${fileHeader.fileName}, Chunked: ${fileHeader.isChunked}`);
                 if (!ft_incomingFileTransfers[fileHeader.fileId] || ft_incomingFileTransfers[fileHeader.fileId].status !== 'offered') {
                    log(`FileTransferPlugin: Warn: file_data_header for unknown fileId ${fileHeader.fileId} or status not 'offered'. Current status: ${ft_incomingFileTransfers[fileHeader.fileId] ? ft_incomingFileTransfers[fileHeader.fileId].status : 'N/A'}`);
                    if (!ft_incomingFileTransfers[fileHeader.fileId]) {
                         log(`FileTransferPlugin: Warn: No existing transfer info from offer for fileId '${fileHeader.fileId}'. Creating minimal entry based on header.`);
                         ft_incomingFileTransfers[fileHeader.fileId] = {
                            fileId: fileHeader.fileId,
                            fileName: fileHeader.fileName || 'Unknown Filename', // Use from header if available, else fallback
                            fileType: fileHeader.fileType || 'application/octet-stream', // Use from header if available
                            chunks: [],
                            receivedSize:0,
                         };
                    }
                }
                const transfer = ft_incomingFileTransfers[fileHeader.fileId];
                transfer.isChunked = fileHeader.isChunked;
                transfer.fullFileHash = fileHeader.fullFileHash;
                if (fileHeader.fileSize) transfer.fileSize = fileHeader.fileSize; // Should match offer; header confirms.
                // fileName and fileType should primarily come from the initial file_offer_secure.
                // If they are also in file_data_header, they can be used for confirmation or if the offer was missed.
                if (fileHeader.fileName && !transfer.fileName) transfer.fileName = fileHeader.fileName;
                if (fileHeader.fileType && !transfer.fileType) transfer.fileType = fileHeader.fileType;


                if (fileHeader.isChunked) {
                    transfer.totalChunks = fileHeader.totalChunks;
                    transfer.chunks = new Array(fileHeader.totalChunks);
                    transfer.receivedChunksCount = 0;
                    transfer.status = 'receiving_chunks';
                    // For chunked, we don't set ft_isProcessingBinary until a file_chunk_header comes
                    log(`FileTransferPlugin: Received header for chunked file ${fileHeader.fileName || transfer.fileName}. Waiting for individual chunk headers.`);
                } else { // Small file
                    transfer.status = 'receiving_data';
                    ft_expectingFileId = fileHeader.fileId; // Use plugin's state variable
                    ft_expectingChunkNum = undefined;     // Use plugin's state variable
                    ft_isProcessingBinary = true;
                    log(`FileTransferPlugin: Expecting small file data for fileId: ${ft_expectingFileId}`);
                }
                break;
            case "file_chunk_header": // For receiver
                log(`FileTransferPlugin: Handling ${subType} control message.`);
                const chunkHeader = decryptedPayload;
                log(`FileTransferPlugin: Received file_chunk_header for fileId: ${chunkHeader.fileId}, chunkNum: ${chunkHeader.chunkNum}`);
                const transferChunk = ft_incomingFileTransfers[chunkHeader.fileId];
                if (transferChunk && transferChunk.status === 'receiving_chunks') {
                    ft_expectingFileId = chunkHeader.fileId;     // Use plugin's state variable
                    ft_expectingChunkNum = chunkHeader.chunkNum; // Use plugin's state variable
                    ft_isProcessingBinary = true;
                    log(`FileTransferPlugin: Expecting chunk ${ft_expectingChunkNum} for fileId: ${ft_expectingFileId}`);
                } else {
                    log(`FileTransferPlugin: Warning: Received file_chunk_header for fileId: ${chunkHeader.fileId} but conditions not met (status: ${transferChunk ? transferChunk.status : 'N/A'}).`);
                }
                break;
            default:
                log(`FileTransferPlugin: Received unhandled control message subType: ${subType}`);
        }
    });

    document.addEventListener('core-message-received', (event) => {
        log(`FileTransferPlugin: core-message-received event, type: ${event.detail.type}`);
        const msg = event.detail;
        if (msg.type === "file_offer_secure") { // This is an incoming offer (for receiver)
            log('FileTransferPlugin: Handling file_offer_secure message.');
            if (!myKeyPair) { log("FileTransferPlugin: Cannot decrypt file offer: RSA keys missing."); return; }

            try {
                const decryptedDetailsJSON = myKeyPair.decrypt(msg.encryptedDetails); // myKeyPair from core.js
                if (!decryptedDetailsJSON) { throw new Error("Failed to decrypt file offer details."); }
                const offerDetails = JSON.parse(decryptedDetailsJSON);
                log(`FileTransfer plugin: Decrypted file offer: ${JSON.stringify(offerDetails)}`);

                ft_incomingFileTransfers[msg.fileId] = {
                    fileId: msg.fileId, fileName: offerDetails.fileName, fileSize: offerDetails.fileSize,
                    fileType: offerDetails.fileType, status: 'offered', chunks: [], receivedSize: 0
                };
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Incoming file: ${offerDetails.fileName} (${(offerDetails.fileSize / 1024).toFixed(2)} KB). Auto-accepting. ---`, "system");

                const acceptMessageDetails = { fileId: msg.fileId, status: "accepted" };
                const encrypt = new JSEncrypt(); encrypt.setPublicKey(peerPublicKeyPEM); // peerPublicKeyPEM from core
                const encryptedAcceptPayload = encrypt.encrypt(JSON.stringify(acceptMessageDetails));
                if (!encryptedAcceptPayload) { throw new Error("Failed to encrypt file acceptance."); }

                sendDataChannelMessage({ type: "encrypted_control_message", subType: "file_transfer_accept", payload: encryptedAcceptPayload });
                log(`FileTransfer plugin: Sent acceptance for fileId: ${msg.fileId}`);
            } catch (error) {
                log(`FileTransfer plugin: File offer processing error: ${error}`); console.error("File Offer Error (Plugin):", error);
                if (typeof addMessageToChat === 'function') addMessageToChat("--- Error processing file offer. ---", "system");
            }
        }
    });

    document.addEventListener('core-binary-data-received', async (event) => {
        const { arrayBuffer } = event.detail; // Core.js now only sends arrayBuffer
        log(`FileTransferPlugin: core-binary-data-received event, size: ${arrayBuffer.byteLength}`);

        if (!ft_isProcessingBinary || !ft_expectingFileId) {
            log('FileTransferPlugin: Received unexpected binary data or missing fileId context. Ignoring.');
            return;
        }

        const transferInfo = ft_incomingFileTransfers[ft_expectingFileId];
        if (!transferInfo) {
            log(`FileTransferPlugin: Warning: No transfer info found for expected fileId: ${ft_expectingFileId}. Ignoring binary data.`);
            ft_isProcessingBinary = false; // Reset flag as this is an error state
            return;
        }

        if (transferInfo.isChunked) {
            // ft_expectingChunkNum should be set by file_chunk_header
            if (transferInfo.status === 'receiving_chunks' && typeof ft_expectingChunkNum !== 'undefined') {
                log(`FileTransferPlugin: Processing ArrayBuffer for CHUNK ${ft_expectingChunkNum} of fileId: ${ft_expectingFileId}. Size: ${arrayBuffer.byteLength}`);
                transferInfo.chunks[ft_expectingChunkNum] = arrayBuffer;
                transferInfo.receivedSize = (transferInfo.receivedSize || 0) + arrayBuffer.byteLength;
                transferInfo.receivedChunksCount = (transferInfo.receivedChunksCount || 0) + 1;

                if (transferInfo.receivedChunksCount === transferInfo.totalChunks) {
                    log(`FileTransferPlugin: All chunks received for fileId: ${ft_expectingFileId}. Assembling...`);
                    await ft_assembleFileFromChunks(ft_expectingFileId);
                    // ft_assembleFileFromChunks should handle final cleanup of ft_incomingFileTransfers[ft_expectingFileId]
                    // and implicitly ends the processing for this fileId.
                    ft_isProcessingBinary = false; // Done with this file
                    ft_expectingFileId = null;     // Clear expectation
                } else {
                    // More chunks expected, keep ft_isProcessingBinary = true, but clear current chunk num.
                    // The next file_chunk_header will set ft_expectingChunkNum again.
                    log(`FileTransferPlugin: Chunk ${ft_expectingChunkNum} processed. Waiting for next chunk header for ${ft_expectingFileId}.`);
                    // ft_isProcessingBinary remains true as we are in middle of chunked transfer
                }
                ft_expectingChunkNum = undefined; // Ready for the next chunk_header to set this

            } else {
                log(`FileTransferPlugin: Warning: Received chunk ArrayBuffer for fileId: ${ft_expectingFileId} but conditions not met (status: ${transferInfo.status}, expecting chunk: ${ft_expectingChunkNum}).`);
                ft_isProcessingBinary = false; // Reset if state is inconsistent
            }
        } else { // Small File Logic (not chunked)
            if (transferInfo.status === 'receiving_data') {
                log(`FileTransferPlugin: Processing ArrayBuffer for SMALL fileId: ${ft_expectingFileId}. Size: ${arrayBuffer.byteLength}`);
                transferInfo.receivedSize = arrayBuffer.byteLength; // For small files, this is the total size
                try {
                    const blob = new Blob([arrayBuffer], { type: transferInfo.fileType || 'application/octet-stream' });
                    if (blob.size !== transferInfo.fileSize) {
                         log(`FileTransferPlugin: Warning: Small file received size (${blob.size}) does not match expected size (${transferInfo.fileSize}).`);
                         if (typeof addMessageToChat === 'function') addMessageToChat(`--- Warning: File size for ${transferInfo.fileName} is ${blob.size} bytes, expected ${transferInfo.fileSize} bytes. ---`, "system");
                    }
                    displayReceivedFile(blob, transferInfo.fileName, transferInfo.fileSize, transferInfo.fileType, transferInfo.fullFileHash, !!transferInfo.fullFileHash, ft_chatArea);
                    transferInfo.status = 'received_data_complete';
                    // Cleanup for this small file transfer
                    delete ft_incomingFileTransfers[ft_expectingFileId];
                } catch (error) {
                    log(`FileTransferPlugin: Error processing small file ArrayBuffer for ${transferInfo.fileName}: ${error}`);
                    if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error processing file data for ${transferInfo.fileName}. ---`, "system");
                    transferInfo.status = 'error_processing_data';
                }
                ft_isProcessingBinary = false; // Done with this small file
                ft_expectingFileId = null;     // Clear expectation
            } else {
                log(`FileTransferPlugin: Warning: Received ArrayBuffer for small fileId: ${ft_expectingFileId} but status is wrong: ${transferInfo.status}`);
                ft_isProcessingBinary = false; // Reset if state is inconsistent
            }
        }
        // Do not reset ft_expectingFileId or ft_expectingChunkNum here generally,
        // as they are managed per header or upon completion of all chunks.
        // ft_isProcessingBinary is the main flag to reset after each binary piece if no more are immediately expected without a new header.
    });

    if (typeof addMessageToChat === 'function') addMessageToChat("--- File Transfer plugin initialized. ---", "system");

    // Make the file transfer section visible
    const ftSection = document.getElementById('file-transfer-section');
    if (ftSection) {
        ftSection.style.display = 'block'; // Or its original display style if not block
        log(`FileTransferPlugin: Attempted to show #file-transfer-section. Current display: ${ftSection.style.display}`);
    } else {
        log("FileTransferPlugin: File transfer section (#file-transfer-section) not found in DOM.");
    }

    log("FileTransferPlugin: Initialization complete.");
}

log("FileTransfer.js: Parsed. Waiting for initFileTransfer() call from main.js.");
