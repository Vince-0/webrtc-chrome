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

// Global function to handle session state changes
function handleSessionStateChange(session, newState) {
  if (!session) return;

  logWithDetails('GLOBAL_SESSION_STATE_CHANGE', {
    sessionId: session.id,
    oldState: session.state,
    newState: newState,
    direction: connectionState.callDirection,
    byeReceived: session.bye ? 'yes' : 'no',
    terminationReason: session.terminationReason || 'unknown'
  });

  // Handle terminated state (call ended)
  if (newState === 'Terminated') {
    // Check if this was due to a BYE packet
    const isBye = session.terminationReason === 'BYE' ||
                 (session.request && session.request.method === 'BYE');

    logWithDetails('CALL_TERMINATED', {
      sessionId: session.id,
      reason: session.endTime ? 'Call ended normally' : 'Call terminated unexpectedly',
      isBye: isBye,
      terminationReason: session.terminationReason || 'unknown'
    });

    // Update UI with appropriate message
    let callStatus = 'Call ended';
    if (isBye && connectionState.callDirection === 'incoming') {
      callStatus = 'Call ended by remote party';
    } else if (isBye && connectionState.callDirection === 'outgoing') {
      callStatus = 'Call ended by remote party';
    }

    updateConnectionState({
      callStatus: callStatus,
      hasActiveCall: false,
      callDirection: null
    });

    currentCall = null;

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    // Notify any open popups about the state change immediately
    chrome.runtime.sendMessage({
      action: 'stateUpdated',
      state: connectionState,
      callTerminated: true,
      byeReceived: isBye
    });
  }
}

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

// Enhanced logging function
function logWithDetails(action, details = {}) {
  const timestamp = new Date().toISOString();
  const logPrefix = `[SIP ${action}] [${timestamp}]`;

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

// Connect to SIP server
async function connect(server, wsServerUrl, username, password, displayName) {
  logWithDetails('CONNECT', { server, wsServerUrl, username, displayName });
  try {
    if (!server || !wsServerUrl || !username || !password) {
      const error = 'Error: Missing connection details';
      logWithDetails('CONNECT_ERROR', { error });
      updateConnectionState({ status: error });
      return;
    }

    // Create a proper URI for the user
    userAgent = new SIP.UserAgent({
      uri: SIP.UserAgent.makeURI(`sip:${username}@${server}`),
      transportOptions: {
        server: wsServerUrl
      }
    });

    // Add direct event listener for incoming calls at the UserAgent level
    userAgent.delegate = {
      onInvite: (invitation) => {
        logWithDetails('USER_AGENT_ON_INVITE', {
          invitationExists: !!invitation,
          invitationId: invitation ? invitation.id : 'unknown'
        });

        // If we have an invitation, set up state change listener
        if (invitation) {
          invitation.stateChange.addListener((newState) => {
            logWithDetails('INVITATION_STATE_CHANGED', {
              invitationId: invitation.id,
              oldState: invitation.state,
              newState: newState
            });

            // Use our global handler
            handleSessionStateChange(invitation, newState);
          });
        }
      }
    };

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
        logWithDetails('DELEGATE_CALL_RECEIVED', {
          sessionId: session ? session.id : 'unknown',
          sessionExists: !!session
        });

        // Store the session reference
        currentCall = session;

        // Store the fact that we have an incoming call in a more persistent way
        chrome.storage.local.set({ hasIncomingCall: true });

        updateConnectionState({
          callStatus: 'Incoming call...',
          hasActiveCall: true,
          callDirection: 'incoming'
        });

        // Add direct event listeners for BYE packets
        if (session) {
          // Add state change listener
          session.stateChange.addListener((newState) => {
            logWithDetails('INCOMING_CALL_STATE_CHANGED', {
              sessionId: session.id,
              oldState: session.state,
              newState: newState
            });

            handleSessionStateChange(session, newState);
          });

          // Add specific BYE request listener if available
          if (session.delegate && typeof session.delegate.onBye === 'function') {
            const originalOnBye = session.delegate.onBye;
            session.delegate.onBye = (bye) => {
              logWithDetails('BYE_RECEIVED_DIRECTLY', {
                sessionId: session.id,
                byeExists: !!bye
              });

              // Update UI immediately
              updateConnectionState({
                callStatus: 'Call ended by remote party',
                hasActiveCall: false,
                callDirection: null
              });

              currentCall = null;

              // Clear the incoming call flag
              chrome.storage.local.set({ hasIncomingCall: false });

              // Call original handler if it exists
              if (originalOnBye) {
                originalOnBye(bye);
              }
            };
          }
        }

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
        logWithDetails('DELEGATE_CALL_ANSWERED');
        updateConnectionState({
          callStatus: 'Call connected',
          hasActiveCall: true
        });
      },
      onCallHangup: () => {
        logWithDetails('DELEGATE_CALL_HANGUP');
        updateConnectionState({
          callStatus: 'Call ended',
          hasActiveCall: false,
          callDirection: null
        });
        currentCall = null;

        // Clear the incoming call flag
        chrome.storage.local.set({ hasIncomingCall: false });
      },
      onCallReceiveRequest: (session) => {
        // This is called when an INVITE is received
        logWithDetails('DELEGATE_CALL_RECEIVE_REQUEST', {
          sessionId: session ? session.id : 'unknown',
          sessionExists: !!session
        });

        // If we have a session, set up state change listener
        if (session) {
          session.stateChange.addListener((newState) => {
            handleSessionStateChange(session, newState);
          });
        }
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
  logWithDetails('REGISTER');
  try {
    if (!simpleUser) {
      const error = new Error('SimpleUser not initialized');
      logWithDetails('REGISTER_ERROR', { error });
      throw error;
    }
    await simpleUser.register();
    logWithDetails('REGISTER_SUCCESS');
    updateConnectionState({
      status: 'Registration successful',
      isRegistered: true
    });
  } catch (error) {
    logWithDetails('REGISTER_ERROR', { error });
    updateConnectionState({
      status: `Registration failed: ${error.message}`,
      isRegistered: false
    });
    throw error; // Re-throw to be handled by caller
  }
}

// Unregister from the SIP server
async function unregister() {
  logWithDetails('UNREGISTER');
  try {
    if (!simpleUser) {
      const error = new Error('SimpleUser not initialized');
      logWithDetails('UNREGISTER_ERROR', { error });
      throw error;
    }
    await simpleUser.unregister();
    logWithDetails('UNREGISTER_SUCCESS');
    updateConnectionState({
      status: 'Unregistered',
      isRegistered: false
    });
  } catch (error) {
    logWithDetails('UNREGISTER_ERROR', { error });
    updateConnectionState({
      status: `Unregister failed: ${error.message}`
    });
    throw error;
  }
}

// Disconnect from server
async function disconnect() {
  logWithDetails('DISCONNECT');
  try {
    if (simpleUser) {
      try {
        // Try to unregister first
        await unregister();
      } catch (error) {
        logWithDetails('UNREGISTER_DURING_DISCONNECT_ERROR', { error });
      }
      await simpleUser.disconnect();
      logWithDetails('DISCONNECT_SUCCESS');
      simpleUser = null;
      userAgent = null;
      updateConnectionState({
        status: 'Disconnected',
        isConnected: false,
        isRegistered: false,
        hasActiveCall: false
      });
    } else {
      logWithDetails('DISCONNECT_SKIPPED', { reason: 'No active SimpleUser' });
    }
  } catch (error) {
    logWithDetails('DISCONNECT_ERROR', { error });
    updateConnectionState({
      status: `Disconnect failed: ${error.message}`
    });
  }
}

// Make an outgoing call
async function makeCall(target, server) {
  logWithDetails('MAKE_CALL', { target, server });
  try {
    if (!target) {
      const error = 'Error: Please enter a destination';
      logWithDetails('MAKE_CALL_ERROR', { error });
      updateConnectionState({
        callStatus: error
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
      logWithDetails('TARGET_URI_CREATED', { uri: targetUri.toString() });
    } catch (error) {
      const uriError = new Error(`Invalid target URI: ${error.message}`);
      logWithDetails('TARGET_URI_ERROR', { error: uriError });
      throw uriError;
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
    logWithDetails('CALL_OPTIONS', { options });

    updateConnectionState({
      callStatus: 'Calling...',
      hasActiveCall: true,
      callDirection: 'outgoing'
    });

    logWithDetails('CALLING', { target: targetUri.toString() });
    const callResult = await simpleUser.call(targetUri.toString(), options);
    logWithDetails('CALL_INITIATED', { callResultExists: !!callResult });

    // Add event listeners to the session to handle remote termination
    if (simpleUser._session) {
      const session = simpleUser._session;
      logWithDetails('ADDING_STATE_CHANGE_LISTENER_TO_OUTGOING_CALL', { sessionId: session.id });

      // Listen for state changes in the session using our global handler
      session.stateChange.addListener((newState) => {
        handleSessionStateChange(session, newState);
      });

      // Store the current call reference
      currentCall = session;
    }

  } catch (error) {
    logWithDetails('MAKE_CALL_ERROR', { error });
    updateConnectionState({
      callStatus: `Call failed: ${error.message}`,
      hasActiveCall: false,
      callDirection: null
    });
  }
}

// Answer incoming call
async function answer() {
  logWithDetails('ANSWER_CALL', { currentCall: !!currentCall });
  try {
    // Check if we have an incoming call flag set
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    logWithDetails('INCOMING_CALL_CHECK', { hasIncomingCall, currentCallExists: !!currentCall });

    if (!currentCall && !hasIncomingCall) {
      const error = new Error('No incoming call to answer');
      logWithDetails('ANSWER_ERROR', { error, reason: 'No call reference or flag' });
      throw error;
    }

    // If we have the flag but lost the currentCall reference, try to reconnect
    if (!currentCall && hasIncomingCall && simpleUser) {
      logWithDetails('ANSWER_WITH_LOST_REFERENCE', {
        simpleUserExists: !!simpleUser,
        simpleUserSession: !!simpleUser._session
      });
      // We'll try to answer anyway, as the SIP.js library might still have the session internally
    }

    // Log the state of the session if available
    if (simpleUser && simpleUser._session) {
      logWithDetails('SESSION_STATE_BEFORE_ANSWER', {
        state: simpleUser._session.state,
        sessionId: simpleUser._session.id
      });
    }

    logWithDetails('ANSWERING');
    await simpleUser.answer();
    logWithDetails('ANSWER_SUCCESS');

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    updateConnectionState({
      callStatus: 'Call connected',
      hasActiveCall: true,
      callDirection: 'incoming'
    });

    // Add event listeners to the session to handle remote termination after answering
    if (simpleUser._session) {
      const session = simpleUser._session;
      logWithDetails('ADDING_STATE_CHANGE_LISTENER_AFTER_ANSWER', { sessionId: session.id });

      // Listen for state changes in the session using our global handler
      session.stateChange.addListener((newState) => {
        handleSessionStateChange(session, newState);
      });

      // Add specific BYE request listener if available
      if (session.delegate && typeof session.delegate.onBye === 'function') {
        const originalOnBye = session.delegate.onBye;
        session.delegate.onBye = (bye) => {
          logWithDetails('BYE_RECEIVED_AFTER_ANSWER', {
            sessionId: session.id,
            byeExists: !!bye
          });

          // Update UI immediately
          updateConnectionState({
            callStatus: 'Call ended by remote party',
            hasActiveCall: false,
            callDirection: null
          });

          currentCall = null;

          // Clear the incoming call flag
          chrome.storage.local.set({ hasIncomingCall: false });

          // Call original handler if it exists
          if (originalOnBye) {
            originalOnBye(bye);
          }
        };
      }

      // Make sure we have the current call reference
      currentCall = session;
    }
  } catch (error) {
    logWithDetails('ANSWER_ERROR', { error });
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
  logWithDetails('REJECT_CALL', { currentCall: !!currentCall });
  try {
    // Check if we have an incoming call flag set
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    logWithDetails('INCOMING_CALL_CHECK_REJECT', { hasIncomingCall, currentCallExists: !!currentCall });

    if (!currentCall && !hasIncomingCall) {
      const error = new Error('No incoming call to reject');
      logWithDetails('REJECT_ERROR', { error, reason: 'No call reference or flag' });
      throw error;
    }

    // Log the state of the session if available
    if (simpleUser && simpleUser._session) {
      logWithDetails('SESSION_STATE_BEFORE_REJECT', {
        state: simpleUser._session.state,
        sessionId: simpleUser._session.id
      });
    }

    logWithDetails('REJECTING');
    await simpleUser.reject();
    logWithDetails('REJECT_SUCCESS');

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });

    updateConnectionState({
      callStatus: 'Call rejected',
      hasActiveCall: false,
      callDirection: null
    });
    currentCall = null;
  } catch (error) {
    logWithDetails('REJECT_ERROR', { error });
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
  logWithDetails('HANGUP_CALL', {
    currentCall: !!currentCall,
    callDirection: connectionState.callDirection,
    hasActiveCall: connectionState.hasActiveCall
  });

  try {
    // Get the call direction from state
    const callDirection = connectionState.callDirection;

    // Check if we have an active call in storage
    const data = await new Promise(resolve => {
      chrome.storage.local.get(['hasIncomingCall'], result => resolve(result));
    });

    const hasIncomingCall = data.hasIncomingCall;
    logWithDetails('ACTIVE_CALL_CHECK_HANGUP', {
      hasIncomingCall,
      currentCallExists: !!currentCall,
      hasActiveCallInState: connectionState.hasActiveCall
    });

    // If we don't have an active call, there's nothing to hang up
    if (!currentCall && !hasIncomingCall && !connectionState.hasActiveCall) {
      logWithDetails('HANGUP_SKIPPED', { reason: 'No active call' });
      return;
    }

    // Access the underlying session if possible
    if (simpleUser) {
      // Log the simpleUser object structure
      logWithDetails('SIMPLE_USER_OBJECT', {
        hasSession: !!simpleUser._session,
        userAgent: !!simpleUser.userAgent,
        delegate: !!simpleUser.delegate
      });

      // Try to access the session directly
      const session = simpleUser._session || simpleUser.session;

      if (session) {
        logWithDetails('SESSION_OBJECT', {
          id: session.id,
          state: session.state,
          direction: callDirection
        });

        try {
          // For established sessions, use bye()
          // Check session state - SIP.SessionState might not be directly available
          // Common session states: 'Established', 'Establishing', 'Terminated'
          if (session.state === 'Established' ||
              (typeof SIP !== 'undefined' && SIP.SessionState && session.state === SIP.SessionState.Established)) {
            logWithDetails('USING_BYE_METHOD', { state: session.state });
            await session.bye();
            logWithDetails('BYE_SUCCESS');
          } else if (session.state === 'Establishing' ||
                    (typeof SIP !== 'undefined' && SIP.SessionState && session.state === SIP.SessionState.Establishing)) {
            // For sessions in the process of being established
            if (callDirection === 'outgoing') {
              logWithDetails('USING_CANCEL_METHOD', { state: session.state });
              await session.cancel();
              logWithDetails('CANCEL_SUCCESS');
            } else {
              logWithDetails('USING_REJECT_METHOD', { state: session.state });
              await session.reject();
              logWithDetails('REJECT_SUCCESS');
            }
          } else {
            // For other states, try the generic hangup
            logWithDetails('USING_HANGUP_METHOD', { state: session.state });
            await simpleUser.hangup();
            logWithDetails('HANGUP_SUCCESS');
          }
        } catch (sessionError) {
          logWithDetails('SESSION_METHOD_ERROR', { error: sessionError });
          // Fall back to simpleUser.hangup()
          logWithDetails('FALLING_BACK_TO_HANGUP');
          await simpleUser.hangup();
          logWithDetails('FALLBACK_HANGUP_SUCCESS');
        }
      } else {
        // No session object available, use the standard hangup method
        logWithDetails('NO_SESSION_OBJECT', { usingGenericHangup: true });
        await simpleUser.hangup();
        logWithDetails('GENERIC_HANGUP_SUCCESS');
      }
    } else {
      logWithDetails('NO_SIMPLE_USER_OBJECT', { cannotHangup: true });
    }

    // Clear the incoming call flag
    chrome.storage.local.set({ hasIncomingCall: false });
    logWithDetails('CLEARED_INCOMING_CALL_FLAG');

    updateConnectionState({
      callStatus: 'Call ended',
      hasActiveCall: false,
      callDirection: null
    });
    currentCall = null;
    logWithDetails('HANGUP_COMPLETE');
  } catch (error) {
    logWithDetails('HANGUP_ERROR', { error });
    updateConnectionState({
      callStatus: `Failed to hang up: ${error.message}`,
      callDirection: null
    });

    // Clear the incoming call flag on error too
    chrome.storage.local.set({ hasIncomingCall: false });

    // Even if we get an error, try to force disconnect the call
    try {
      if (simpleUser) {
        // Try to force a disconnect by calling disconnect and reconnect
        logWithDetails('FORCE_DISCONNECT_ATTEMPT');
        await simpleUser.disconnect();
        logWithDetails('FORCE_DISCONNECT_SUCCESS');

        setTimeout(async () => {
          try {
            logWithDetails('RECONNECT_ATTEMPT');
            await simpleUser.connect();
            logWithDetails('RECONNECT_SUCCESS');

            if (connectionState.isRegistered) {
              logWithDetails('REREGISTER_ATTEMPT');
              await simpleUser.register();
              logWithDetails('REREGISTER_SUCCESS');
            }
          } catch (reconnectError) {
            logWithDetails('RECONNECT_ERROR', { error: reconnectError });
          }
        }, 1000);
      }
    } catch (forceDisconnectError) {
      logWithDetails('FORCE_DISCONNECT_ERROR', { error: forceDisconnectError });
    }
  }
}

// Handle messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  logWithDetails('MESSAGE_RECEIVED', { action: message.action, sender: sender.id });

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
      // Hang up active call with high priority
      logWithDetails('BACKGROUND_RECEIVED_HANGUP_REQUEST');

      // Use Promise.race to ensure we respond quickly
      Promise.race([
        hangup(),
        new Promise((_, reject) => setTimeout(() => {
          logWithDetails('HANGUP_TIMEOUT_IN_HANDLER');
          reject(new Error('Hangup timeout'));
        }, 3000))
      ]).then(() => {
        logWithDetails('BACKGROUND_HANGUP_COMPLETED_SUCCESSFULLY');
        // Send an immediate response to keep the popup open
        sendResponse({ success: true, state: connectionState });

        // Also broadcast the state update to any open popups
        chrome.runtime.sendMessage({
          action: 'stateUpdated',
          state: connectionState,
          hangupCompleted: true
        });
      }).catch(error => {
        logWithDetails('BACKGROUND_HANGUP_ERROR_IN_HANDLER', { error });

        // Even if there's an error, update the UI state
        updateConnectionState({
          callStatus: `Attempted to hang up: ${error.message}`,
          hasActiveCall: false,
          callDirection: null
        });

        // Send response to keep popup open
        sendResponse({
          success: false,
          error: error.message,
          state: connectionState,
          forceUIUpdate: true
        });

        // Also broadcast the state update
        chrome.runtime.sendMessage({
          action: 'stateUpdated',
          state: connectionState,
          hangupError: true,
          errorMessage: error.message
        });
      });
      return true;

    case 'checkMicrophonePermission':
      // We can't directly check microphone permission from the background script
      sendResponse({ status: 'unknown' });
      break;
  }

  return false; // No async response needed for other actions
});
