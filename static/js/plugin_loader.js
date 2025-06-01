'use strict';

// USERNAME, ROOM_NAME, DEBUG are globally available from chat.html

// plugin_loader.js - Acts as the entry point after core.js
// It will be responsible for loading and initializing plugins.

// This log confirms the script is parsed and starts attaching listeners.
// It's important that 'log' function is available globally from core.js,
// which should be the case due to script execution order with 'defer'.
if (typeof log === 'function') {
    log('PluginLoader: Parsed and executed initial script block. Attaching core-ready listener.');
} else {
    // Fallback if core.js's log isn't ready (shouldn't happen with defer but good for sanity)
    console.log('PluginLoader: Parsed and executed initial script block. Attaching core-ready listener. (log function not yet available)');
}

document.addEventListener('core-ready', () => {
    // Use a more specific log source identifier for PluginLoader
    const plLog = (message) => { if (typeof log === 'function') log(`PluginLoader: ${message}`); };

    plLog('core-ready event received. Starting plugin loading.');

    // Function to load a single plugin
    function loadPlugin(pluginPath, initFunctionName, pluginName) {
        plLog(`Attempting to load plugin '${pluginName}' from ${pluginPath}`);
        const script = document.createElement('script');
        script.src = pluginPath; // Script URLs should be relative to the HTML file or absolute.
                                 // Flask's url_for would generate correct paths if this was in HTML,
                                 // but here we assume static/js/ is the base for these paths.
        script.onload = () => {
            plLog(`Script for '${pluginName}' loaded. Checking for init function '${initFunctionName}'.`);
            if (typeof window[initFunctionName] === 'function') {
                plLog(`Initializing plugin '${pluginName}' by calling ${initFunctionName}().`);
                window[initFunctionName]();
            } else {
                plLog(`ERROR - Init function '${initFunctionName}' not found for plugin '${pluginName}'.`);
                if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error: Could not initialize ${pluginName} plugin. Init function missing. ---`, "system");
            }
        };
        script.onerror = () => {
            plLog(`ERROR - Failed to load script for plugin '${pluginName}' from ${pluginPath}.`);
            if (typeof addMessageToChat === 'function') addMessageToChat(`--- Error: ${pluginName} plugin script not found at ${pluginPath}. ---`, "system");
        };
        document.body.appendChild(script);
    }

    // Load all plugins
    plLog('Core-ready: About to start loading individual plugins.');

    plLog('Core-ready: Attempting to initiate loading for Chat');
    loadPlugin('static/js/plugins/chat/chat.js', 'initChat', 'Chat');
    plLog('Core-ready: Call to loadPlugin for Chat completed.');

    plLog('Core-ready: Attempting to initiate loading for FileTransfer');
    loadPlugin('static/js/plugins/file_transfer/file_transfer.js', 'initFileTransfer', 'FileTransfer');
    plLog('Core-ready: Call to loadPlugin for FileTransfer completed.');

    plLog('Core-ready: Attempting to initiate loading for VoiceChat');
    loadPlugin('static/js/plugins/voice_chat/voice_chat.js', 'initVoiceChat', 'VoiceChat');
    plLog('Core-ready: Call to loadPlugin for VoiceChat completed.');

    plLog('Core-ready: Attempting to initiate loading for ScreenShare');
    loadPlugin('static/js/plugins/screen_share/screen_share.js', 'initScreenShare', 'ScreenShare');
    plLog('Core-ready: Call to loadPlugin for ScreenShare completed.');

    plLog('Core-ready: All loadPlugin calls have been made.');
    // All UI element event handlers and direct manipulations previously in main.js
    // for specific features (chat, file transfer, voice call) have been moved
    // to their respective plugin files. plugin_loader.js is now only a loader.
    plLog('Core-ready: Event listener callback execution finished.');
});

// The old "DOMContentLoaded setup complete. Waiting for core-ready..." log is removed
// as the core-ready listener is now attached directly.

// The console.log at the end can be removed or kept for basic script execution confirmation if needed.
// console.log("PluginLoader: End of script execution (core-ready listener attached).");
// For consistency with previous logging, let's use the log function if available.
if (typeof log === 'function') {
    log("PluginLoader: End of script execution (core-ready listener attached).");
} else {
    console.log("PluginLoader: End of script execution (core-ready listener attached, log function not available).");
}
