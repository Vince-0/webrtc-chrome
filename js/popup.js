// Popup script for the WebRTC SIP Client extension
import { createIncomingCallNotification, stopNotifications } from './notifications.js';
import { playDialTone, stopDialTone } from '../audio/dialtone.js';
import { playHangupSound } from '../audio/hangupsound.js';

// Enhanced logging function
function logWithDetails(action, details = {}) {
  const timestamp = new Date().toISOString();
  const logPrefix = `[SIP POPUP ${action}] [${timestamp}]`;

  // Create a formatted log message
  let logMessage = `${logPrefix}`;

  // Add details if provided
  if (Object.keys(details).length > 0) {
    console.group(logMessage);
    for (const [key, value] of Object.entries(details)) {
      if (key === 'password' || key === 'authorizationPassword') {
        console.log(`${key}: ******`);
      } else if (value instanceof Error) {
        console.log(`${key}:`, value.message);
        console.error(value);
      } else if (typeof value === 'object' && value !== null) {
        console.log(`${key}:`);
        console.dir(value);
      } else {
        console.log(`${key}:`, value);
      }
    }
    console.groupEnd();
  } else {
    console.log(logMessage);
  }
}

// DOM Elements
const elements = {
    // Settings
    sipServer: document.getElementById('sipServer'),
    wsServer: document.getElementById('wsServer'),
    sipUsername: document.getElementById('sipUsername'),
    sipPassword: document.getElementById('sipPassword'),
    sipDisplayName: document.getElementById('sipDisplayName'),
    connectBtn: document.getElementById('connectBtn'),
    disconnectBtn: document.getElementById('disconnectBtn'),
    connectionToggle: document.getElementById('connectionToggle'),
    connectionContent: document.getElementById('connectionContent'),
    usernameDisplay: document.getElementById('usernameDisplay'),

    // Call controls
    callTo: document.getElementById('callTo'),
    callBtn: document.getElementById('callBtn'),
    hangupBtn: document.getElementById('hangupBtn'),
    answerBtn: document.getElementById('answerBtn'),

    // Status elements
    status: document.getElementById('status'),
    callStatus: document.getElementById('callStatus'),
    connectionIndicator: document.getElementById('connectionIndicator'),

    // Media elements
    remoteAudio: document.getElementById('remoteAudio'),
    localAudio: document.getElementById('localAudio')
};

// Initialize the application
function init() {
    // Add event listeners for call controls
    elements.connectBtn.addEventListener('click', connect);
    elements.disconnectBtn.addEventListener('click', disconnect);
    elements.callBtn.addEventListener('click', makeCall);
    elements.hangupBtn.addEventListener('click', (event) => hangup(event));
    elements.answerBtn.addEventListener('click', answer);

    // Set default WebSocket URL if SIP server is changed
    elements.sipServer.addEventListener('change', updateDefaultWebSocketUrl);
    elements.sipServer.addEventListener('input', updateDefaultWebSocketUrl);

    // Set default display name from username
    elements.sipUsername.addEventListener('change', updateDefaultDisplayName);
    elements.sipUsername.addEventListener('input', updateDefaultDisplayName);

    // Setup collapsible sections
    setupCollapsibleSections();

    // Load saved settings from Chrome storage
    loadSavedSettings();

    // Check microphone permissions
    checkMicrophonePermission();

    // Check for incoming calls immediately
    chrome.storage.local.get(['hasIncomingCall', 'connectionState'], (result) => {
        if (result.hasIncomingCall) {
            logWithDetails('FOUND_INCOMING_CALL_FLAG', { onInit: true });
            elements.answerBtn.disabled = false;
            // Get caller from storage if available
            const caller = result.connectionState && result.connectionState.caller ?
                result.connectionState.caller : null;
            updateCallStatus('Incoming call...', caller);
        }
    });

    // Get current state from background script
    getStateFromBackground();

    // Listen for state updates from background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        logWithDetails('POPUP_MESSAGE_RECEIVED', {
            action: message.action,
            callTerminated: message.callTerminated,
            byeReceived: message.byeReceived
        });

        if (message.action === 'stateUpdated') {
            // Handle call termination specially
            if (message.callTerminated) {
                logWithDetails('CALL_TERMINATION_NOTIFICATION', {
                    byeReceived: message.byeReceived,
                    state: message.state
                });

                // Update UI with call ended status
                updateCallStatus(message.state.callStatus || 'Call ended');
                updateButtonState(message.state.isConnected, false);

                // Play hangup sound
                playHangupSound();

                // Stop local audio stream if it exists
                if (elements.localAudio.srcObject) {
                    logWithDetails('STOPPING_LOCAL_AUDIO_STREAM_ON_BYE');
                    elements.localAudio.srcObject.getTracks().forEach(track => {
                        track.stop();
                        logWithDetails('AUDIO_TRACK_STOPPED_ON_BYE', { trackId: track.id });
                    });
                    elements.localAudio.srcObject = null;
                }
            }

            // Handle hangup completion notification
            if (message.hangupCompleted) {
                logWithDetails('HANGUP_COMPLETED_NOTIFICATION', {
                    state: message.state
                });

                // Update UI with call ended status
                updateCallStatus('Call ended successfully');
                updateButtonState(message.state.isConnected, false);

                // Re-enable the hangup button
                elements.hangupBtn.disabled = false;
            }

            // Handle hangup error notification
            if (message.hangupError) {
                logWithDetails('HANGUP_ERROR_NOTIFICATION', {
                    errorMessage: message.errorMessage,
                    state: message.state
                });

                // Update UI with error status
                updateCallStatus(`Hangup issue: ${message.errorMessage}`);
                updateButtonState(message.state.isConnected, false);

                // Re-enable the hangup button
                elements.hangupBtn.disabled = false;
            }

            // Stop dialing tone if call is connected
            if (message.state.callStatus === 'Call connected') {
                stopDialTone();
            }

            // Always update the full UI state
            updateUIFromState(message.state);
        }
    });
}

// Update default WebSocket URL based on SIP server
function updateDefaultWebSocketUrl() {
    const server = elements.sipServer.value.trim();
    if (server) {
        // Always update the WebSocket URL to match the SIP server domain
        const currentWsUrl = elements.wsServer.value.trim();
        const newWsUrl = `wss://${server}:7443/ws`;

        // Update the WebSocket URL
        elements.wsServer.value = newWsUrl;

        logWithDetails('WEBSOCKET_URL_UPDATED', {
            sipServer: server,
            oldWsUrl: currentWsUrl,
            newWsUrl: newWsUrl
        });
    }
}

// Update default display name based on username
function updateDefaultDisplayName() {
    const username = elements.sipUsername.value.trim();
    // Always update the display name to match the username
    elements.sipDisplayName.value = username;

    logWithDetails('DISPLAY_NAME_UPDATED', {
        username: username,
        displayName: username
    });
}

// Update the UI status
function updateStatus(message) {
    elements.status.textContent = message;
}

// Update call status
function updateCallStatus(message, caller = null) {
    // Clear previous content
    elements.callStatus.innerHTML = '';

    // Add main status message
    const statusLine = document.createElement('div');
    statusLine.textContent = message;
    statusLine.className = 'call-status-main';
    elements.callStatus.appendChild(statusLine);

    // Add caller info on second line if provided
    if (caller) {
        const callerLine = document.createElement('div');
        callerLine.textContent = caller;
        callerLine.className = 'call-status-caller';
        elements.callStatus.appendChild(callerLine);
    }
}

// Update button states
function updateButtonState(connected, hasActiveCall = false) {
    elements.connectBtn.disabled = connected;
    elements.disconnectBtn.disabled = !connected;
    elements.callBtn.disabled = !connected || hasActiveCall;

    if (hasActiveCall) {
        elements.hangupBtn.disabled = false;
        elements.answerBtn.disabled = true;
    } else {
        elements.hangupBtn.disabled = true;
        // Answer button is controlled by incoming calls
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

// Setup collapsible sections
function setupCollapsibleSections() {
    // Add click event to connection toggle
    elements.connectionToggle.addEventListener('click', () => {
        elements.connectionToggle.classList.toggle('active');
        const content = elements.connectionContent;

        if (content.classList.contains('open')) {
            content.classList.remove('open');
        } else {
            content.classList.add('open');
        }

        logWithDetails('TOGGLE_SETTINGS_SECTION', {
            isOpen: content.classList.contains('open')
        });
    });

    // Open settings by default when not connected
    chrome.storage.local.get(['isConnected'], (result) => {
        if (!result.isConnected) {
            elements.connectionContent.classList.add('open');
            elements.connectionToggle.classList.add('active');
        }
    });
}

// Update UI based on state from background script
function updateUIFromState(state) {
    logWithDetails('UPDATE_UI_FROM_STATE', state);

    // Update status
    updateStatus(state.status || 'Disconnected');
    updateCallStatus(state.callStatus || '', state.caller || null);

    // Update connection indicator and username display
    if (state.isConnected) {
        elements.connectionIndicator.classList.remove('disconnected');
        elements.connectionIndicator.classList.add('connected');

        // Display username when connected
        chrome.storage.local.get(['sipUsername'], (result) => {
            if (result.sipUsername) {
                elements.usernameDisplay.textContent = result.sipUsername;
            }
        });

        // Auto-collapse settings when connected
        if (elements.connectionContent.classList.contains('open')) {
            elements.connectionContent.classList.remove('open');
            elements.connectionToggle.classList.remove('active');
        }
    } else {
        elements.connectionIndicator.classList.remove('connected');
        elements.connectionIndicator.classList.add('disconnected');

        // Clear username when disconnected
        elements.usernameDisplay.textContent = '';

        // Auto-expand settings when disconnected
        if (!elements.connectionContent.classList.contains('open')) {
            elements.connectionContent.classList.add('open');
            elements.connectionToggle.classList.add('active');
        }
    }

    // Update button states
    updateButtonState(state.isConnected, state.hasActiveCall);

    // Handle incoming calls
    if (state.hasActiveCall && state.callStatus === 'Incoming call...') {
        logWithDetails('INCOMING_CALL_DETECTED', { fromState: true });
        elements.answerBtn.disabled = false;

        // Show notification with audio alert
        const caller = state.caller || 'Unknown';
        createIncomingCallNotification(caller);
    }

    // Also check storage for incoming call flag
    chrome.storage.local.get(['hasIncomingCall', 'connectionState'], (result) => {
        if (result.hasIncomingCall) {
            logWithDetails('INCOMING_CALL_FLAG_FOUND', { fromStorage: true });
            elements.answerBtn.disabled = false;
            if (!state.callStatus || state.callStatus !== 'Incoming call...') {
                // Get caller from storage if available
                const caller = result.connectionState && result.connectionState.caller ?
                    result.connectionState.caller : null;
                updateCallStatus('Incoming call...', caller);
            }
        }
    });

    // Save connection state to storage
    chrome.storage.local.set({ isConnected: state.isConnected });
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
            sipDisplayName: displayName,
            isConnected: false // Will be updated when connection is successful
        });

        // Display username immediately
        elements.usernameDisplay.textContent = username;

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
        // Clear username display
        elements.usernameDisplay.textContent = '';

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
    logWithDetails('MAKE_CALL_POPUP');
    try {
        let target = elements.callTo.value.trim();
        if (!target) {
            const error = 'Error: Please enter a destination';
            logWithDetails('MAKE_CALL_ERROR_POPUP', { error });
            updateCallStatus(error);
            return;
        }

        // Request microphone permission before making the call
        try {
            logWithDetails('REQUESTING_MIC_PERMISSION');
            const stream = await requestMicrophonePermission();
            // Connect the stream to the audio element
            elements.localAudio.srcObject = stream;
            logWithDetails('MIC_PERMISSION_GRANTED', { hasStream: !!stream });
        } catch (error) {
            const micError = 'Error: Microphone access is required for making calls';
            logWithDetails('MIC_PERMISSION_ERROR', { error });
            updateCallStatus(micError);
            return;
        }

        const server = elements.sipServer.value.trim();

        // Play dialing tone
        playDialTone();

        // Send makeCall message to background script
        updateCallStatus('Calling...');
        logWithDetails('SENDING_MAKE_CALL_MESSAGE', { target, server });
        chrome.runtime.sendMessage({
            action: 'makeCall',
            target,
            server
        }, (response) => {
            if (response) {
                logWithDetails('MAKE_CALL_RESPONSE', { success: response.success });
                updateUIFromState(response.state);

                // If call failed, stop the dialing tone
                if (!response.success) {
                    stopDialTone();
                }
            } else {
                logWithDetails('MAKE_CALL_NO_RESPONSE');
                stopDialTone();
            }
        });
    } catch (error) {
        logWithDetails('MAKE_CALL_ERROR_POPUP', { error });
        updateCallStatus(`Call failed: ${error.message}`);
    }
}

// Answer incoming call
async function answer() {
    logWithDetails('ANSWER_CALL_POPUP');
    try {
        // Stop any active notifications, ringtones, and dialing tones
        stopNotifications();
        stopDialTone();
        // Request microphone permission before answering the call
        try {
            logWithDetails('REQUESTING_MIC_PERMISSION_FOR_ANSWER');
            const stream = await requestMicrophonePermission();
            // Connect the stream to the audio element
            elements.localAudio.srcObject = stream;
            logWithDetails('MIC_PERMISSION_GRANTED_FOR_ANSWER', { hasStream: !!stream });
        } catch (error) {
            const micError = 'Error: Microphone access is required for answering calls';
            logWithDetails('MIC_PERMISSION_ERROR_FOR_ANSWER', { error });
            updateCallStatus(micError);
            return;
        }

        // Send answer message to background script
        logWithDetails('SENDING_ANSWER_MESSAGE');
        chrome.runtime.sendMessage({ action: 'answer' }, (response) => {
            if (response) {
                logWithDetails('ANSWER_RESPONSE', {
                    success: response.success,
                    state: response.state
                });
                updateUIFromState(response.state);
            } else {
                logWithDetails('ANSWER_NO_RESPONSE');
            }
        });
    } catch (error) {
        logWithDetails('ANSWER_ERROR_POPUP', { error });
        updateCallStatus(`Failed to answer: ${error.message}`);
    }
}

// Note: Reject functionality removed as it was not working properly

// Hang up active call
async function hangup(event) {
    // Prevent the default button click behavior which might close the popup
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }

    logWithDetails('HANGUP_CALL_POPUP');
    try {
        // Stop any active notifications, ringtones, and dialing tones
        stopNotifications();
        stopDialTone();

        // Disable the hangup button to prevent multiple clicks
        elements.hangupBtn.disabled = true;
        updateCallStatus('Hanging up...');

        // Play hangup sound
        playHangupSound();

        // Create a promise to track the hangup completion
        const hangupPromise = new Promise((resolve) => {
            // Send hangup message to background script
            logWithDetails('SENDING_HANGUP_MESSAGE');
            chrome.runtime.sendMessage({ action: 'hangup' }, (response) => {
                if (response) {
                    logWithDetails('HANGUP_RESPONSE', {
                        success: response.success,
                        state: response.state
                    });
                    updateUIFromState(response.state);
                    resolve(true);
                } else {
                    logWithDetails('HANGUP_NO_RESPONSE');
                    resolve(false);
                }
            });
        });

        // Wait for the hangup to complete with a timeout
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve('timeout'), 2000);
        });

        // Race the hangup promise against the timeout
        const result = await Promise.race([hangupPromise, timeoutPromise]);

        if (result === 'timeout') {
            logWithDetails('HANGUP_TIMEOUT', { message: 'Hangup operation timed out' });
            updateCallStatus('Hangup may be delayed. Please wait...');
        }

        // Stop local audio stream
        if (elements.localAudio.srcObject) {
            logWithDetails('STOPPING_LOCAL_AUDIO_STREAM');
            elements.localAudio.srcObject.getTracks().forEach(track => {
                track.stop();
                logWithDetails('AUDIO_TRACK_STOPPED', { trackId: track.id });
            });
            elements.localAudio.srcObject = null;
        }

        // Re-enable the hangup button after a delay
        setTimeout(() => {
            elements.hangupBtn.disabled = false;
        }, 2000);

    } catch (error) {
        logWithDetails('HANGUP_ERROR_POPUP', { error });
        updateCallStatus(`Failed to hang up: ${error.message}`);
        // Re-enable the hangup button
        elements.hangupBtn.disabled = false;
    }
}

// Initialize the application when the page loads
window.addEventListener('load', init);
