// SIP.js Client Implementation for version 0.21.2

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

// SIP.js client state
let simpleUser = null;
let userAgent = null;
let currentCall = null; // Store the current call session

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

    updateStatus('Disconnected');
    console.log('SIP.js version:', SIP.version);
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
function updateButtonState(connected) {
    elements.connectBtn.disabled = connected;
    elements.disconnectBtn.disabled = !connected;
    elements.callBtn.disabled = !connected;
    elements.answerBtn.disabled = true;
    elements.rejectBtn.disabled = true;
    elements.hangupBtn.disabled = true;
}

// Create a proper SIP URI
function createSipUri(username, domain) {
    // No need to create a temporary UserAgent, just use the static method
    const uri = SIP.UserAgent.makeURI(`sip:${username}@${domain}`);
    if (!uri) {
        throw new Error(`Failed to create URI for ${username}@${domain}`);
    }
    return uri;
}

// Load saved settings from Chrome storage
function loadSavedSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
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
}

// Save settings to Chrome storage
function saveSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
        const settings = {
            sipServer: elements.sipServer.value.trim(),
            wsServer: elements.wsServer.value.trim(),
            sipUsername: elements.sipUsername.value.trim(),
            sipDisplayName: elements.sipDisplayName.value.trim()
            // We don't save the password for security reasons
        };

        chrome.storage.local.set(settings, () => {
            console.log('Settings saved');
        });
    }
}

// Check microphone permission
function checkMicrophonePermission() {
    // We'll use the standard Web API to check for microphone permission
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

        // Save settings to Chrome storage
        saveSettings();

        // Create a proper URI for the user
        userAgent = new SIP.UserAgent({
            uri: SIP.UserAgent.makeURI(`sip:${username}@${server}`),
            transportOptions: {
                server: wsServerUrl,
                // Use the actual SIP server domain for Via header instead of .invalid
                viaHost: server
            }
        });

        const options = {
            aor: `sip:${username}@${server}`,
            media: {
                constraints: { audio: true, video: false },
                remote: { audio: elements.remoteAudio },
                local: { audio: elements.localAudio }
            },
            userAgentOptions: {
                displayName: displayName || username,
                authorizationUsername: username,
                authorizationPassword: password,
                uri: SIP.UserAgent.makeURI(`sip:${username}@${server}`),
                transportOptions: {
                    server: wsServerUrl,
                    traceSip: true,
                    // Use the actual SIP server domain for Via header instead of .invalid
                    viaHost: server
                },
                sessionDescriptionHandlerFactoryOptions: {
                    peerConnectionConfiguration: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' }
                        ]
                    }
                }
            },
            registererOptions: {
                expires: 300,
                refreshFrequency: 90,
                extraHeaders: [`User-Agent: SIP.js/0.21.2 WebRTC Client`]
            }
        };

        // Create SimpleUser
        simpleUser = new SIP.Web.SimpleUser(wsServerUrl, options);

        // Add event listeners
        simpleUser.delegate = {
            onCallReceived: (session) => {
                console.log('Incoming call received', session);
                currentCall = session; // Store the actual call session
                updateCallStatus('Incoming call...');
                elements.answerBtn.disabled = false;
                elements.rejectBtn.disabled = false;
            },
            onCallAnswered: () => {
                updateCallStatus('Call connected');
                elements.hangupBtn.disabled = false;
                elements.answerBtn.disabled = true;
                elements.rejectBtn.disabled = true;
            },
            onCallHangup: () => {
                updateCallStatus('Call ended');
                currentCall = null;
                resetCallState();
            },
            onServerConnect: async () => {
                updateStatus('Connected to server, registering...');
                try {
                    await register();
                } catch (error) {
                    console.error('Registration error:', error);
                    updateStatus(`Registration failed: ${error.message}`);
                }
            },
            onServerDisconnect: () => {
                updateStatus('Disconnected from server');
                updateButtonState(false);
                resetCallState();
                currentCall = null;
            },
            onRegistered: () => {
                updateStatus('Registered');
                updateButtonState(true);
            },
            onUnregistered: () => {
                updateStatus('Unregistered');
                updateButtonState(false);
            },
            onRegistrationFailed: (error) => {
                console.error('Registration failed:', error);
                updateStatus(`Registration failed: ${error.message}`);
                updateButtonState(false);
            }
        };

        // Connect to the server
        updateStatus('Connecting...');
        await simpleUser.connect();

    } catch (error) {
        console.error('Connection error:', error);
        updateStatus(`Connection failed: ${error.message}`);
    }
}

// Register with the SIP server
async function register() {
    try {
        if (!simpleUser) {
            throw new Error('SimpleUser not initialized');
        }
        await simpleUser.register();
        updateStatus('Registration successful');
    } catch (error) {
        console.error('Registration error:', error);
        updateStatus(`Registration failed: ${error.message}`);
        throw error; // Re-throw to be handled by caller
    }
}

// Unregister from the SIP server
async function unregister() {
    try {
        if (!simpleUser) {
            throw new Error('SimpleUser not initialized');
        }
        await simpleUser.unregister();
        updateStatus('Unregistered');
    } catch (error) {
        console.error('Unregister error:', error);
        updateStatus(`Unregister failed: ${error.message}`);
        throw error;
    }
}

// Disconnect from server
async function disconnect() {
    try {
        if (simpleUser) {
            try {
                // Try to unregister first
                await unregister();
            } catch (error) {
                console.warn('Unregister failed during disconnect:', error);
            }
            await simpleUser.disconnect();
            simpleUser = null;
            userAgent = null;
            updateButtonState(false);
            updateStatus('Disconnected');
        }
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
                // Stop the tracks immediately, we just needed the permission
                stream.getTracks().forEach(track => track.stop());
                resolve(true);
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
            await requestMicrophonePermission();
        } catch (error) {
            updateCallStatus('Error: Microphone access is required for making calls');
            console.error('Microphone permission error:', error);
            return;
        }

        const server = elements.sipServer.value.trim();

        // Create a proper target URI
        let targetUri;
        try {
            if (target.includes('@')) {
                targetUri = SIP.UserAgent.makeURI(`sip:${target}`);
            } else {
                targetUri = SIP.UserAgent.makeURI(`sip:${target}@${server}`);
            }

            if (!targetUri) {
                throw new Error('Failed to create target URI');
            }
        } catch (error) {
            throw new Error(`Invalid target URI: ${error.message}`);
        }

        // Call options
        const options = {
            sessionDescriptionHandlerOptions: {
                constraints: {
                    audio: true,
                    video: false
                }
            }
        };

        updateCallStatus('Calling...');
        await simpleUser.call(targetUri.toString(), options);
        elements.hangupBtn.disabled = false;
        elements.callBtn.disabled = true;

    } catch (error) {
        console.error('Call error:', error);
        updateCallStatus(`Call failed: ${error.message}`);
        resetCallState();
    }
}

// Answer incoming call
async function answer() {
    try {
        console.log('Answering call, currentCall:', currentCall);
        if (!currentCall) {
            throw new Error('No incoming call to answer');
        }

        // Request microphone permission before answering the call
        try {
            await requestMicrophonePermission();
        } catch (error) {
            updateCallStatus('Error: Microphone access is required for answering calls');
            console.error('Microphone permission error:', error);
            return;
        }

        await simpleUser.answer();
        updateCallStatus('Call connected');
        elements.hangupBtn.disabled = false;
        elements.answerBtn.disabled = true;
        elements.rejectBtn.disabled = true;
    } catch (error) {
        console.error('Answer error:', error);
        updateCallStatus(`Failed to answer: ${error.message}`);
        resetCallState();
        currentCall = null;
    }
}

// Reject incoming call
async function reject() {
    try {
        if (!currentCall) {
            throw new Error('No incoming call to reject');
        }
        await simpleUser.reject();
        updateCallStatus('Call rejected');
        resetCallState();
        currentCall = null;
    } catch (error) {
        console.error('Reject error:', error);
        updateCallStatus(`Failed to reject: ${error.message}`);
    }
}

// Hang up active call
async function hangup() {
    try {
        // Always use simpleUser.hangup() which handles both incoming and outgoing calls
        await simpleUser.hangup();
        updateCallStatus('Call ended');
        resetCallState();
        currentCall = null;
    } catch (error) {
        console.error('Hangup error:', error);
        updateCallStatus(`Failed to hang up: ${error.message}`);
    }
}

// Reset call-related state
function resetCallState() {
    elements.callBtn.disabled = false;
    elements.hangupBtn.disabled = true;
    elements.answerBtn.disabled = true;
    elements.rejectBtn.disabled = true;
}

// Initialize the application when the page loads
window.addEventListener('load', init);