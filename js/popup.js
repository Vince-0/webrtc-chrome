// Popup script for the WebRTC SIP Client extension

// DOM Elements
const elements = {
    // Connection settings
    sipServer: document.getElementById('sipServer'),
    wsServer: document.getElementById('wsServer'),
    sipUsername: document.getElementById('sipUsername'),
    sipPassword: document.getElementById('sipPassword'),
    sipDisplayName: document.getElementById('sipDisplayName'),
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),

    // Call controls
    callTo: document.getElementById('callTo'),
    callBtn: document.getElementById('callBtn'),
    hangupBtn: document.getElementById('hangupBtn'),
    answerBtn: document.getElementById('answerBtn'),
    rejectBtn: document.getElementById('rejectBtn'),

    // Status elements
    status: document.getElementById('status'),
    callStatus: document.getElementById('callStatus'),

    // Media elements
    remoteAudio: document.getElementById('remoteAudio'),
    localAudio: document.getElementById('localAudio')
};

// Initialize the application
function init() {
    // Add event listeners
    elements.connectBtn.addEventListener('click', connect);
    elements.disconnectBtn.addEventListener('click', disconnect);
    elements.callBtn.addEventListener('click', makeCall);
    elements.hangupBtn.addEventListener('click', hangup);
    elements.answerBtn.addEventListener('click', answer);
    elements.rejectBtn.addEventListener('click', reject);

    // Set default WebSocket URL if SIP server is changed
    elements.sipServer.addEventListener('change', updateDefaultWebSocketUrl);
    elements.sipServer.addEventListener('input', updateDefaultWebSocketUrl);

    // Load saved settings from Chrome storage
    loadSavedSettings();

    // Check microphone permissions
    checkMicrophonePermission();

    // Check for incoming calls immediately
    chrome.storage.local.get(['hasIncomingCall'], (result) => {
        if (result.hasIncomingCall) {
            console.log('Found incoming call flag on popup init');
            elements.answerBtn.disabled = false;
            elements.rejectBtn.disabled = false;
            updateCallStatus('Incoming call...');
        }
    });

    // Get current state from background script
    getStateFromBackground();

    // Listen for state updates from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'stateUpdated') {
            updateUIFromState(message.state);
        }
    });
}

// Update default WebSocket URL based on SIP server
function updateDefaultWebSocketUrl() {
    const server = elements.sipServer.value.trim();
    if (server && !elements.wsServer.value.trim()) {
        elements.wsServer.value = `wss://${server}:7443/ws`;
    }
}

// Update the UI status
function updateStatus(message) {
    elements.status.textContent = message;
}

// Update call status
function updateCallStatus(message) {
    elements.callStatus.textContent = message;
}

// Update button states
function updateButtonState(connected, hasActiveCall = false) {
    elements.connectBtn.disabled = connected;
    elements.disconnectBtn.disabled = !connected;
    elements.callBtn.disabled = !connected || hasActiveCall;

    if (hasActiveCall) {
        elements.hangupBtn.disabled = false;
        elements.answerBtn.disabled = true;
        elements.rejectBtn.disabled = true;
    } else {
        elements.hangupBtn.disabled = true;
        // Answer and reject buttons are controlled by incoming calls
    }
}

// Load saved settings from Chrome storage
function loadSavedSettings() {
    chrome.storage.local.get(
        ['sipServer', 'wsServer', 'sipUsername', 'sipDisplayName'],
        (result) => {
            if (result.sipServer) elements.sipServer.value = result.sipServer;
            if (result.wsServer) elements.wsServer.value = result.wsServer;
            if (result.sipUsername) elements.sipUsername.value = result.sipUsername;
            if (result.sipDisplayName) elements.sipDisplayName.value = result.sipDisplayName;
        }
    );
}

// Check microphone permission
function checkMicrophonePermission() {
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
            console.log('Microphone permission granted');
            // Stop the tracks immediately, we just needed the permission
            stream.getTracks().forEach(track => track.stop());
        })
        .catch(error => {
            console.error('Microphone permission denied:', error);
            updateStatus('Warning: Microphone access is required for calls');
        });
}

// Get current state from background script
function getStateFromBackground() {
    chrome.runtime.sendMessage({ action: 'getState' }, (response) => {
        if (response && response.state) {
            updateUIFromState(response.state);
        }
    });
}

// Update UI based on state from background script
function updateUIFromState(state) {
    console.log('Updating UI from state:', state);

    // Update status
    updateStatus(state.status || 'Disconnected');
    updateCallStatus(state.callStatus || '');

    // Update button states
    updateButtonState(state.isConnected, state.hasActiveCall);

    // Handle incoming calls
    if (state.hasActiveCall && state.callStatus === 'Incoming call...') {
        elements.answerBtn.disabled = false;
        elements.rejectBtn.disabled = false;
    }

    // Also check storage for incoming call flag
    chrome.storage.local.get(['hasIncomingCall'], (result) => {
        if (result.hasIncomingCall) {
            console.log('Found incoming call flag in storage');
            elements.answerBtn.disabled = false;
            elements.rejectBtn.disabled = false;
            if (!state.callStatus || state.callStatus !== 'Incoming call...') {
                updateCallStatus('Incoming call...');
            }
        }
    });
}

// Connect to SIP server
async function connect() {
    try {
        const server = elements.sipServer.value.trim();
        const wsServerUrl = elements.wsServer.value.trim();
        const username = elements.sipUsername.value.trim();
        const password = elements.sipPassword.value.trim();
        const displayName = elements.sipDisplayName.value.trim();

        if (!server || !wsServerUrl || !username || !password) {
            updateStatus('Error: Please fill in all required fields');
            return;
        }

        // Save settings to Chrome storage (except password)
        chrome.storage.local.set({
            sipServer: server,
            wsServer: wsServerUrl,
            sipUsername: username,
            sipDisplayName: displayName
        });

        // Send connect message to background script
        updateStatus('Connecting...');
        chrome.runtime.sendMessage({
            action: 'connect',
            server,
            wsServerUrl,
            username,
            password,
            displayName
        }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });
    } catch (error) {
        console.error('Connection error:', error);
        updateStatus(`Connection failed: ${error.message}`);
    }
}

// Disconnect from server
async function disconnect() {
    try {
        updateStatus('Disconnecting...');
        chrome.runtime.sendMessage({ action: 'disconnect' }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });
    } catch (error) {
        console.error('Disconnect error:', error);
        updateStatus(`Disconnect failed: ${error.message}`);
    }
}

// Request microphone permission if needed
async function requestMicrophonePermission() {
    return new Promise((resolve, reject) => {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                // Keep the stream active for the call
                resolve(stream);
            })
            .catch(error => {
                reject(error);
            });
    });
}

// Make an outgoing call
async function makeCall() {
    try {
        let target = elements.callTo.value.trim();
        if (!target) {
            updateCallStatus('Error: Please enter a destination');
            return;
        }

        // Request microphone permission before making the call
        try {
            const stream = await requestMicrophonePermission();
            // Connect the stream to the audio element
            elements.localAudio.srcObject = stream;
        } catch (error) {
            updateCallStatus('Error: Microphone access is required for making calls');
            console.error('Microphone permission error:', error);
            return;
        }

        const server = elements.sipServer.value.trim();

        // Send makeCall message to background script
        updateCallStatus('Calling...');
        chrome.runtime.sendMessage({
            action: 'makeCall',
            target,
            server
        }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });
    } catch (error) {
        console.error('Call error:', error);
        updateCallStatus(`Call failed: ${error.message}`);
    }
}

// Answer incoming call
async function answer() {
    try {
        // Request microphone permission before answering the call
        try {
            const stream = await requestMicrophonePermission();
            // Connect the stream to the audio element
            elements.localAudio.srcObject = stream;
        } catch (error) {
            updateCallStatus('Error: Microphone access is required for answering calls');
            console.error('Microphone permission error:', error);
            return;
        }

        // Send answer message to background script
        chrome.runtime.sendMessage({ action: 'answer' }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });
    } catch (error) {
        console.error('Answer error:', error);
        updateCallStatus(`Failed to answer: ${error.message}`);
    }
}

// Reject incoming call
async function reject() {
    try {
        // Send reject message to background script
        chrome.runtime.sendMessage({ action: 'reject' }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });
    } catch (error) {
        console.error('Reject error:', error);
        updateCallStatus(`Failed to reject: ${error.message}`);
    }
}

// Hang up active call
async function hangup() {
    try {
        // Send hangup message to background script
        chrome.runtime.sendMessage({ action: 'hangup' }, (response) => {
            if (response) {
                updateUIFromState(response.state);
            }
        });

        // Stop local audio stream
        if (elements.localAudio.srcObject) {
            elements.localAudio.srcObject.getTracks().forEach(track => track.stop());
            elements.localAudio.srcObject = null;
        }
    } catch (error) {
        console.error('Hangup error:', error);
        updateCallStatus(`Failed to hang up: ${error.message}`);
    }
}

// Initialize the application when the page loads
window.addEventListener('load', init);
