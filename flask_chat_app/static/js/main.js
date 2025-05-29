/**
 * Frontend JavaScript for the P2P WebRTC Chat Application.
 *
 * Handles:
 * - WebSocket connection to the Flask backend for signaling and status updates.
 * - DOM manipulation for updating the chat log, status displays, etc.
 * - Event listeners for user interactions (setting username, sending messages/files, readiness).
 * - API calls (HTTP POST) to the Flask backend for user actions.
 */
document.addEventListener('DOMContentLoaded', () => {
    // --- Global Variables & DOM Element References ---
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; // Use wss for https, ws for http
    const ws = new WebSocket(`${wsProtocol}//${location.host}/ws`); // WebSocket connection to backend

    // Username Section Elements
    const usernameSection = document.getElementById('username-section');
    const usernameInput = document.getElementById('username-input');
    const setUsernameBtn = document.getElementById('set-username-btn');

    // Chat Section Elements
    const chatSection = document.getElementById('chat-section');
    const statusDisplay = document.getElementById('status-display'); // For general status messages
    const chatLog = document.getElementById('chat-log'); // Container for chat messages
    const messageInput = document.getElementById('message-input'); // Text input for chat messages
    const sendMessageBtn = document.getElementById('send-message-btn'); // Button to send text messages
    const fileInput = document.getElementById('file-input'); // Input for selecting files
    const sendFileBtn = document.getElementById('send-file-btn'); // Button to send files
    const readyBtn = document.getElementById('ready-btn'); // Button to signal readiness for P2P
    const disconnectBtn = document.getElementById('disconnect-btn'); // Button to disconnect P2P
    const fileProgress = document.getElementById('file-progress'); // For file transfer progress updates

    let currentUsername = ''; // Stores the username set by the user

    // --- Helper Functions ---

    /**
     * Appends a message to the chat log.
     * @param {string} user - The user who sent the message (e.g., 'You', 'Peer', 'System').
     * @param {string} text - The message content.
     * @param {string} [type='text'] - The type of message, e.g., 'text', 'file_notification'.
     */
    function appendMessage(user, text, type = 'text') {
        const messageElement = document.createElement('div');
        messageElement.classList.add('chat-message');
        if (user === currentUsername || user === 'You') { // Style own messages differently
            messageElement.classList.add('own-message');
        }
        
        const timestamp = new Date().toLocaleTimeString(); // Add a timestamp
        let content = '';
        // Customize message format based on type
        if (type === 'file_notification') {
            content = `<strong>${user}</strong> [File]: ${text} <small>(${timestamp})</small>`;
        } else {
            content = `<strong>${user}:</strong> ${text} <small>(${timestamp})</small>`;
        }
        messageElement.innerHTML = content; // Use innerHTML to render strong/small tags
        chatLog.appendChild(messageElement);
        chatLog.scrollTop = chatLog.scrollHeight; // Auto-scroll to the latest message
    }

    /**
     * Updates the status display area.
     * @param {string} statusText - The text to display as status.
     */
    function updateStatus(statusText) {
        statusDisplay.textContent = `Status: ${statusText}`;
    }

    /**
     * Updates the file progress display area.
     * @param {string} progressText - The text to display for file progress.
     */
    function updateFileProgress(progressText) {
        fileProgress.textContent = progressText;
    }

    // --- WebSocket Event Handlers ---

    /**
     * Handles the WebSocket 'open' event.
     * Logs connection and updates status.
     */
    ws.onopen = () => {
        console.log('WebSocket connection established with backend.');
        updateStatus('Connected to server. Please set your username to begin chatting.');
    };

    /**
     * Handles incoming WebSocket messages from the backend.
     * Parses the JSON message and updates the UI based on `message.kind`.
     * @param {MessageEvent} event - The WebSocket message event.
     */
    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data); // Messages from backend are expected to be JSON
            console.log('Received message from server:', message);

            switch (message.kind) { // Dispatch action based on message kind
                case 'chat': // A chat message from the peer (or system)
                    appendMessage(message.data.username || 'Peer', message.data.msg);
                    break;
                case 'status': // A status update (e.g., connection status, errors)
                    updateStatus(message.data);
                    // Simple check for file progress, can be made more robust
                    if (message.data.toLowerCase().includes('receiving file') || message.data.toLowerCase().includes('sending file')) {
                        updateFileProgress(message.data);
                    } else if (message.data.toLowerCase().includes('file sent successfully') || message.data.toLowerCase().includes('successfully received')) {
                         updateFileProgress(message.data); // Show final status
                    }
                    break;
                case 'file': // This case is for direct file notifications from PeerConnector after successful transfer
                    // The chat message from peer_connector's _post("chat", file_chat_data) will cover the basic "file received" notice.
                    // This 'file' kind message is specifically for creating the download link.
                    // appendMessage(message.data.username || 'Peer', `Received file: ${message.data.name}`, 'file_notification'); // Removed to avoid duplicate
                    updateFileProgress(`Processing received file: ${message.data.name}...`); // Temp status
                    
                    // Create download link
                    const fileData = message.data; // data is like {"name": "example.txt", "ext": ".txt"}
                    const downloadLink = document.createElement('a');
                    downloadLink.href = `/download/${encodeURIComponent(fileData.name)}`;
                    downloadLink.textContent = `Download ${fileData.name}`;
                    downloadLink.setAttribute('download', fileData.name);
                    
                    const fileNotificationDiv = document.createElement('div');
                    fileNotificationDiv.classList.add('chat-message'); // Optional: style like other messages
                    fileNotificationDiv.innerHTML = `File received: `;
                    fileNotificationDiv.appendChild(downloadLink);
                    
                    chatLog.appendChild(fileNotificationDiv);
                    chatLog.scrollTop = chatLog.scrollHeight;
                    updateFileProgress(`File '${fileData.name}' is ready for download.`);
                    break;
                case 'pong': // For testing WebSocket connection from server (dev/debug)
                     console.log("Received PONG from server:", message.data);
                     appendMessage("Server", message.data); // Display PONG in chat for visibility
                     break;
                default: // Unknown message kind
                    console.warn('Unknown message kind received from server:', message.kind);
            }
        } catch (error) {
            console.error('Error parsing message from server:', error, event.data);
            appendMessage('System', 'Error: Received malformed message from server.');
        }
    };

    /**
     * Handles WebSocket 'error' events.
     * Logs the error and updates status.
     * @param {Event} error - The WebSocket error event.
     */
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateStatus('WebSocket error. Check console for details.');
        appendMessage('System', 'Error: Connection to server failed or was lost.');
    };

    /**
     * Handles the WebSocket 'close' event.
     * Logs closure, updates status, and resets UI to initial state.
     */
    ws.onclose = () => {
        console.log('WebSocket connection closed with backend.');
        updateStatus('Disconnected from server. Please refresh to reconnect.');
        // Reset UI: show username section, hide chat section
        chatSection.style.display = 'none';
        usernameSection.style.display = 'block';
        readyBtn.disabled = false; // Re-enable ready button for potential reconnection
        appendMessage('System', 'Connection to server closed.');
    };

    // --- Event Listeners for UI Elements ---

    /**
     * Handles click on "Set Username" button.
     * Sends username to backend and updates UI.
     */
    setUsernameBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        if (!username) {
            alert('Please enter a username.');
            return;
        }
        try {
            // API call to set username on the server
            const response = await fetch('/set-username', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: username })
            });
            const result = await response.json();
            if (result.status === 'username set') {
                currentUsername = result.username;
                // Switch UI from username entry to chat interface
                usernameSection.style.display = 'none';
                chatSection.style.display = 'block';
                messageInput.focus(); // Focus message input
                // Update status based on WebSocket connection state
                if (ws.readyState === WebSocket.OPEN) {
                     updateStatus(`Username: ${currentUsername}. Connected & Ready.`);
                } else if (ws.readyState === WebSocket.CONNECTING) {
                     updateStatus(`Username: ${currentUsername}. WebSocket connecting...`);
                } else {
                     updateStatus(`Username: ${currentUsername}. WebSocket not connected.`);
                }
            } else {
                alert('Failed to set username: ' + (result.message || 'Unknown server error.'));
            }
        } catch (error) {
            console.error('Error setting username:', error);
            alert('Error setting username. Check console for details.');
        }
    });

    /**
     * Handles sending a text message (via button click or Enter key).
     */
    async function sendMessageHandler() {
        const messageText = messageInput.value;
        if (messageText.trim() === '') return; // Don't send empty messages

        try {
            // API call to send message via server, which relays to PeerConnector
            const response = await fetch('/send-message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: messageText })
            });
            const result = await response.json();
            if (result.status === 'message sent') {
                appendMessage(currentUsername, messageText); // Client-side echo
                messageInput.value = '';
            } else {
                console.error('Failed to send message:', result);
                alert('Failed to send message: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending message:', error);
            alert('Error sending message. See console.');
        }
    }

    sendMessageBtn.addEventListener('click', sendMessageHandler);
    messageInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            sendMessageHandler();
        }
    });

    sendFileBtn.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) {
            alert('Please select a file to send.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        updateFileProgress(`Sending file: ${file.name}...`);
        try {
            const response = await fetch('/send-file', {
                method: 'POST',
                body: formData // No 'Content-Type' header for FormData, browser sets it
            });
            const result = await response.json();
            if (result.status === 'file upload received, attempting to send') {
                // appendMessage('You', `Attempting to send file: ${file.name}`, 'file_notification');
                updateFileProgress(`File "${file.name}" uploaded to server, attempting P2P send.`);
            } else {
                console.error('Failed to send file:', result);
                updateFileProgress(`Failed to send file: ${result.message || 'Unknown error'}`);
                alert('Failed to send file: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending file:', error);
            updateFileProgress(`Error sending file: ${error.toString()}`);
            alert('Error sending file. See console.');
        }
        fileInput.value = ''; // Clear the file input
    });

    readyBtn.addEventListener('click', async () => {
        try {
            const response = await fetch('/ready', { method: 'POST' });
            const result = await response.json();
            if (result.status === 'ready signal processed') {
                updateStatus('Ready signal sent. Waiting for peer...');
                readyBtn.disabled = true;
            } else {
                alert('Failed to send ready signal: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending ready signal:', error);
            alert('Error sending ready signal. See console.');
        }
    });

    disconnectBtn.addEventListener('click', async () => {
        try {
            const response = await fetch('/disconnect', { method: 'POST' });
            const result = await response.json();
            if (result.status === 'disconnecting') {
                updateStatus('Disconnecting...');
                // WebSocket onclose will handle UI changes
            } else {
                alert('Failed to send disconnect signal: ' + (result.message || 'Unknown error'));
            }
        } catch (error) {
            console.error('Error sending disconnect signal:', error);
            alert('Error sending disconnect signal. See console.');
        }
        // ws.close(); // Also explicitly close WS from client-side if desired
    });
});
