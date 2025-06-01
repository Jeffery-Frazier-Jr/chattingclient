'use strict';

// Chat Plugin
// Depends on core.js for:
// - log(message)
// - sendDataChannelMessage(messageObject)
// - addMessageToChat(messageText, messageType, timestamp)
// - myKeyPair (global from core.js)
// - peerPublicKeyPEM (global from core.js)
// - USERNAME (global from chat.html)

function initChat() {
    if (typeof log !== 'function') {
        console.error("Chat plugin: Core 'log' function not available.");
        return;
    }
    log('ChatPlugin: initChat() called.');

    const messageInput = document.getElementById('message-input');
    const sendButton = document.getElementById('send-button');

    log(`ChatPlugin: message-input element: ${messageInput ? 'found' : 'NOT FOUND'}`);
    log(`ChatPlugin: send-button element: ${sendButton ? 'found' : 'NOT FOUND'}`);

    if (!messageInput || !sendButton) {
        log("ChatPlugin: Required UI elements (message-input, send-button) not found. Aborting initChat.");
        return;
    }

    // Enable chat input and send button
    messageInput.disabled = false;
    sendButton.disabled = false;
    log('ChatPlugin: Enabled message input and send button.');

    function sendMessage() {
        log('ChatPlugin: sendMessage() called.');
        const messageText = messageInput.value.trim();
        if (!messageText) return;

        // dataChannel is global from core.js
        log(`ChatPlugin: sendMessage - dataChannel status: ${typeof dataChannel !== 'undefined' && dataChannel ? dataChannel.readyState : 'null'}`);
        if (typeof dataChannel === 'undefined' || !dataChannel || dataChannel.readyState !== 'open') {
            log("ChatPlugin: Data channel not open.");
            addMessageToChat("--- Error: Data channel not open. Cannot send message. ---", "system");
            return;
        }
        if (!peerPublicKeyPEM || !myKeyPair) { // Globals from core.js
            log("Chat plugin: Encryption keys not set up.");
            addMessageToChat("--- Error: Encryption keys not set up. Cannot send secure message. ---", "system");
            return;
        }

        try {
            log(`Chat plugin: Encrypting message: "${messageText}"`);
            const encryptInstance = new JSEncrypt();
            encryptInstance.setPublicKey(peerPublicKeyPEM);
            const encryptedMessage = encryptInstance.encrypt(messageText);

            if (!encryptedMessage) {
                log("Chat plugin: Encryption failed.");
                addMessageToChat("--- Error: Encryption failed. Message not sent. ---", "system");
                return;
            }

            log(`Chat plugin: Sending encrypted message: ${encryptedMessage.substring(0, 30)}...`);
            // Assuming sendDataChannelMessage is globally available from core.js
            sendDataChannelMessage({ type: "chat_secure", ciphertext: encryptedMessage });
            // Assuming addMessageToChat is globally available from core.js
            addMessageToChat(messageText, "sent");
            messageInput.value = "";
        } catch (error) {
            log(`Chat plugin: Encryption Error: ${error}`);
            console.error("Chat Encryption Error:", error);
            addMessageToChat("--- Error: Encryption failed. Message not sent. ---", "system");
        }
    }

    sendButton.onclick = sendMessage;
    messageInput.onkeypress = (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            sendMessage();
        }
    };
    log("Chat plugin: Send button and message input event listeners attached.");

    // Listen for incoming chat messages from core.js
    document.addEventListener('core-message-received', (event) => {
        log(`ChatPlugin: core-message-received event, type: ${event.detail.type}`);
        const msg = event.detail;
        if (msg.type === "chat_secure") {
            log('ChatPlugin: Handling chat_secure message.');
            if (!myKeyPair) { // Global from core.js
                log("ChatPlugin: Private key missing for decryption.");
                addMessageToChat("--- Error: Cannot decrypt message. Key missing. ---", "system");
                return;
            }
            try {
                log(`Chat plugin: Ciphertext: ${msg.ciphertext.substring(0, 30)}...`);
                const decrypted = myKeyPair.decrypt(msg.ciphertext);
                if (!decrypted) {
                    log("Chat plugin: Decryption failed.");
                    addMessageToChat("--- Message decryption failed. ---", "system");
                    return;
                }
                log(`Chat plugin: Decrypted: "${decrypted}"`);
                addMessageToChat(decrypted, "received");
            } catch (error) {
                log(`Chat plugin: Decryption error: ${error}`);
                console.error("Chat Decryption Error:", error);
                addMessageToChat("--- Message decryption error. ---", "system");
            }
        }
    });
    log("Chat plugin: Listener for 'core-message-received' (chat_secure) attached.");

    // Check for P2P connection status to enable/disable chat functionality
    // This can be done by listening to custom events from core.js if available,
    // or checking dataChannel status periodically/on interaction.
    // For now, initial enabling is done above. If P2P drops, core.js disables inputs.
    // If P2P connects, core.js enables inputs. This plugin assumes core.js handles that.
    // This plugin's responsibility is the chat-specific logic (send/receive).

    addMessageToChat("--- Chat plugin initialized. ---", "system");
    log("Chat plugin: Initialization complete.");
}

// Self-invoking check if core is ready, or wait for an explicit call from main.js
// For this task, main.js will call initChat()
if (typeof coreReady !== 'undefined' && coreReady) {
    log("Chat.js: Core seems ready, attempting to init chat (self-invoke). This might be too early.");
    // initChat(); // Decided against self-invocation, main.js will call it.
} else {
    // This log might be confusing if log function itself isn't loaded yet when this script is initially parsed.
    // However, `log` is defined in core.js, which should be loaded and parsed before plugins.
    if (typeof log === 'function') {
        log("Chat.js: Core not ready or initChat will be called by main.js (initial parse).");
    } else {
        console.log("Chat.js: log function not available during initial parse.");
    }
}
