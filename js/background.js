// Background script for the WebRTC SIP Client extension

// We can't use importScripts with type:module in manifest v3
// We'll need to include the SIP.js library in the HTML file

// Global state
let simpleUser = null;
let userAgent = null;
let currentCall = null;
let connectionState = {
  isConnected: false,
  isRegistered: false,
  status: 'Disconnected',
  callStatus: '',
  hasActiveCall: false
};

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebRTC SIP Client extension installed');

  // Initialize default settings if needed
  chrome.storage.local.get(['sipServer', 'wsServer', 'connectionState', 'hasIncomingCall'], (result) => {
    // Initialize hasIncomingCall flag if it doesn't exist
    if (result.hasIncomingCall === undefined) {
      chrome.storage.local.set({ hasIncomingCall: false });
    }

    if (!result.sipServer) {
      chrome.storage.local.set({
        sipServer: 'example.com',
        wsServer: 'wss://example.com:7443/ws',
        connectionState: connectionState,
        hasIncomingCall: false
      });
    } else if (result.connectionState) {
      // Restore connection state
      connectionState = result.connectionState;

      // If we were connected before, try to reconnect
      if (connectionState.isConnected) {
        chrome.storage.local.get(['sipServer', 'wsServer', 'sipUsername', 'sipPassword', 'sipDisplayName'], (settings) => {
          if (settings.sipUsername && settings.sipPassword) {
            // Reconnect in the background
            connect(settings.sipServer, settings.wsServer, settings.sipUsername, settings.sipPassword, settings.sipDisplayName);
          }
        });
      }
    }
  });
});

// Initialize when the background page loads
chrome.storage.local.get(['hasIncomingCall'], (result) => {
  if (result.hasIncomingCall === undefined) {
    chrome.storage.local.set({ hasIncomingCall: false });
  }
});

// Update connection state and save to storage
function updateConnectionState(updates) {
  connectionState = { ...connectionState, ...updates };
  chrome.storage.local.set({ connectionState });

  // Notify any open popups about the state change
  chrome.runtime.sendMessage({ action: 'stateUpdated', state: connectionState });
}

// Connect to SIP server
async function connect(server, wsServerUrl, username, password, displayName) {
  try {
    if (!server || !wsServerUrl || !username || !password) {
      updateConnectionState({ status: 'Error: Missing connection details' });
      return;
    }

    // Create a proper URI for the user
    userAgent = new SIP.UserAgent({
      uri: SIP.UserAgent.makeURI(`sip:${username}@${server}`),
      transportOptions: {
        server: wsServerUrl
      }
    });

    const options = {
      aor: `sip:${username}@${server}`,
      media: {
        constraints: { audio: true, video: false }
        // Note: We can't use audio elements in the background script
        // The popup will handle the audio
      },
      userAgentOptions: {
        displayName: displayName || username,
        authorizationUsername: username,
        authorizationPassword: password,
        uri: SIP.UserAgent.makeURI(`sip:${username}@${server}`),
        transportOptions: {
          server: wsServerUrl,
          traceSip: true
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
        currentCall = session;

        // Store the fact that we have an incoming call in a more persistent way
        chrome.storage.local.set({ hasIncomingCall: true });

        updateConnectionState({
          callStatus: 'Incoming call...',
          hasActiveCall: true,
          callDirection: 'incoming'
        });

        // Show notification for incoming call
        chrome.notifications.create('incoming-call', {
          type: 'basic',
          iconUrl: 'icons/icon16.png',
          title: 'Incoming Call',
          message: 'You have an incoming call. Open the extension to answer.',
          priority: 2
        });
      },
      onCallAnswered: () => {
        updateConnectionState({
          callStatus: 'Call connected',
          hasActiveCall: true
        });
      },
      onCallHangup: () => {
        updateConnectionState({
          callStatus: 'Call ended',
          hasActiveCall: false,
          callDirection: null
        });
        currentCall = null;

        // Clear the incoming call flag
        chrome.storage.local.set({ hasIncomingCall: false });
      },
      onServerConnect: async () => {
        updateConnectionState({
          status: 'Connected to server, registering...',
          isConnected: true
        });
        try {
          await register();
        } catch (error) {
          console.error('Registration error:', error);
          updateConnectionState({
            status: `Registration failed: ${error.message}`,
            isRegistered: false
          });
        }
      },
      onServerDisconnect: () => {
        updateConnectionState({
          status: 'Disconnected from server',
          isConnected: false,
          isRegistered: false,
          hasActiveCall: false
        });
        currentCall = null;
      },
      onRegistered: () => {
        updateConnectionState({
          status: 'Registered',
          isRegistered: true
        });
      },
      onUnregistered: () => {
        updateConnectionState({
          status: 'Unregistered',
          isRegistered: false
        });
      },
      onRegistrationFailed: (error) => {
        console.error('Registration failed:', error);
        updateConnectionState({
          status: `Registration failed: ${error.message}`,
          isRegistered: false
        });
      }
    };

    // Connect to the server
    updateConnectionState({ status: 'Connecting...' });
    await simpleUser.connect();

  } catch (error) {
    console.error('Connection error:', error);
    updateConnectionState({
      status: `Connection failed: ${error.message}`,
      isConnected: false,
      isRegistered: false
    });
  }
}

// Register with the SIP server
async function register() {
  try {
    if (!simpleUser) {
      throw new Error('SimpleUser not initialized');
    }
    await simpleUser.register();
    updateConnectionState({
      status: 'Registration successful',
      isRegistered: true
    });
  } catch (error) {
    console.error('Registration error:', error);
    updateConnectionState({
      status: `Registration failed: ${error.message}`,
      isRegistered: false
    });
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
    updateConnectionState({
      status: 'Unregistered',
      isRegistered: false
    });
  } catch (error) {
    console.error('Unregister error:', error);
    updateConnectionState({
      status: `Unregister failed: ${error.message}`
    });
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
      updateConnectionState({
        status: 'Disconnected',
        isConnected: false,
        isRegistered: false,
        hasActiveCall: false
      });
    }
  } catch (error) {
    console.error('Disconnect error:', error);
    updateConnectionState({
      status: `Disconnect failed: ${error.message}`
    });
  }
}

// Make an outgoing call
async function makeCall(target, server) {
  try {
    if (!target) {
      updateConnectionState({
        callStatus: 'Error: Please enter a destination'
      });
      return;
    }

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

    updateConnectionState({
      callStatus: 'Calling...',
      hasActiveCall: true,
      callDirection: 'outgoing'
    });
    await simpleUser.call(targetUri.toString(), options);

  } catch (error) {
    console.error('Call error:', error);
    updateConnectionState({
      callStatus: `Call failed: ${error.message}`,
      hasActiveCall: false,
      callDirection: null
    });
  }
}

// Answer incoming call
async function answer() {
  try {
    console.log('Answering call, currentCall:', currentCall);

    // Check if we have an incoming call flag set
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    console.log('hasIncomingCall flag from storage:', hasIncomingCall);

    if (!currentCall && !hasIncomingCall) {
      throw new Error('No incoming call to answer');
    }

    // If we have the flag but lost the currentCall reference, try to reconnect
    if (!currentCall && hasIncomingCall && simpleUser) {
      console.log('Attempting to answer call with lost reference');
      // We'll try to answer anyway, as the SIP.js library might still have the session internally
    }

    await simpleUser.answer();

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    updateConnectionState({
      callStatus: 'Call connected',
      hasActiveCall: true,
      callDirection: 'incoming'
    });
  } catch (error) {
    console.error('Answer error:', error);
    updateConnectionState({
      callStatus: `Failed to answer: ${error.message}`,
      hasActiveCall: false,
      callDirection: null
    });
    currentCall = null;

    // Clear the incoming call flag on error too
    chrome.storage.local.set({ hasIncomingCall: false });
  }
}

// Reject incoming call
async function reject() {
  try {
    // Check if we have an incoming call flag set
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    console.log('hasIncomingCall flag from storage (reject):', hasIncomingCall);

    if (!currentCall && !hasIncomingCall) {
      throw new Error('No incoming call to reject');
    }

    await simpleUser.reject();

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    updateConnectionState({
      callStatus: 'Call rejected',
      hasActiveCall: false,
      callDirection: null
    });
    currentCall = null;
  } catch (error) {
    console.error('Reject error:', error);
    updateConnectionState({
      callStatus: `Failed to reject: ${error.message}`,
      callDirection: null
    });

    // Clear the incoming call flag on error too
    chrome.storage.local.set({ hasIncomingCall: false });
  }
}

// Hang up active call
async function hangup() {
  try {
    console.log('Hanging up call, currentCall:', currentCall, 'callDirection:', connectionState.callDirection);

    // Get the call direction from state
    const callDirection = connectionState.callDirection;

    // Check if we have an active call in storage
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    console.log('hasIncomingCall flag from storage (hangup):', hasIncomingCall);

    // If we don't have an active call, there's nothing to hang up
    if (!currentCall && !hasIncomingCall && !connectionState.hasActiveCall) {
      console.log('No active call to hang up');
      return;
    }

    // For incoming calls that have been answered, we need to use bye()
    // For outgoing calls, we can use hangup()
    if (callDirection === 'incoming' && simpleUser) {
      // Try to access the session directly if possible
      if (simpleUser._session) {
        console.log('Using session.bye() for incoming call');
        await simpleUser._session.bye();
      } else {
        // Fallback to the standard hangup method
        console.log('Falling back to simpleUser.hangup() for incoming call');
        await simpleUser.hangup();
      }
    } else {
      // For outgoing calls or when we're not sure
      console.log('Using simpleUser.hangup() for outgoing call');
      await simpleUser.hangup();
    }

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    updateConnectionState({
      callStatus: 'Call ended',
      hasActiveCall: false,
      callDirection: null
    });
    currentCall = null;
  } catch (error) {
    console.error('Hangup error:', error);
    updateConnectionState({
      callStatus: `Failed to hang up: ${error.message}`,
      callDirection: null
    });

    // Clear the incoming call flag on error too
    chrome.storage.local.set({ hasIncomingCall: false });
  }
}

// Handle messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message);

  switch (message.action) {
    case 'getState':
      // Send the current state to the popup
      sendResponse({ state: connectionState });
      break;

    case 'connect':
      // Connect to SIP server
      connect(
        message.server,
        message.wsServerUrl,
        message.username,
        message.password,
        message.displayName
      ).then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true; // Indicates we'll respond asynchronously

    case 'disconnect':
      // Disconnect from SIP server
      disconnect().then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true;

    case 'makeCall':
      // Make outgoing call
      makeCall(message.target, message.server).then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true;

    case 'answer':
      // Answer incoming call
      answer().then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true;

    case 'reject':
      // Reject incoming call
      reject().then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true;

    case 'hangup':
      // Hang up active call
      hangup().then(() => {
        sendResponse({ success: true, state: connectionState });
      }).catch(error => {
        sendResponse({ success: false, error: error.message, state: connectionState });
      });
      return true;

    case 'checkMicrophonePermission':
      // We can't directly check microphone permission from the background script
      sendResponse({ status: 'unknown' });
      break;
  }

  return false; // No async response needed for other actions
});
