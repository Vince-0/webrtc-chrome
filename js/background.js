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
    terminationReason: session.terminationReason || 'unknown',
    lastResponse: session.lastResponse ? {
      statusCode: session.lastResponse.statusCode,
      reasonPhrase: session.lastResponse.reasonPhrase
    } : 'none'
  });

  // Handle terminated state (call ended)
  if (newState === 'Terminated') {
    // Check if this was due to a BYE packet
    const isBye = session.terminationReason === 'BYE' ||
                 (session.request && session.request.method === 'BYE');

    // Check for rejection responses (4xx, 5xx, 6xx)
    const isRejected = session.lastResponse &&
                      (session.lastResponse.statusCode >= 400 &&
                       session.lastResponse.statusCode < 700);

    // Specific check for 486 Busy Here
    const isBusy = isRejected && session.lastResponse.statusCode === 486;

    // Specific check for 487 Request Terminated (CANCEL)
    const isCancelled = isRejected && session.lastResponse.statusCode === 487;

    // Specific check for 480 User Not Registered
    const isNotRegistered = isRejected && session.lastResponse.statusCode === 480;

    logWithDetails('CALL_TERMINATED', {
      sessionId: session.id,
      reason: session.endTime ? 'Call ended normally' : 'Call terminated unexpectedly',
      isBye: isBye,
      isRejected: isRejected,
      isBusy: isBusy,
      isCancelled: isCancelled,
      isNotRegistered: isNotRegistered,
      statusCode: isRejected ? session.lastResponse.statusCode : 'none',
      reasonPhrase: isRejected ? session.lastResponse.reasonPhrase : 'none',
      terminationReason: session.terminationReason || 'unknown',
      callDirection: connectionState.callDirection
    });

    if (isBye) {
      // Use the centralized BYE packet handler for consistent behavior
      handleByePacket(session, { method: 'BYE' });
    } else if (isBusy) {
      // Handle 486 Busy Here specifically
      logWithDetails('BUSY_HERE_RECEIVED', {
        sessionId: session.id,
        callDirection: connectionState.callDirection
      });

      // Update UI with busy message
      updateConnectionState({
        callStatus: 'Call failed: User busy',
        hasActiveCall: false,
        callDirection: null
      });

      currentCall = null;

      // Clear the incoming call flag
      chrome.storage.local.set({ hasIncomingCall: false });

      // Notify any open popups about the busy status
      chrome.runtime.sendMessage({
        action: 'stateUpdated',
        state: connectionState,
        callTerminated: true,
        busyReceived: true
      });
    } else if (isCancelled) {
      // Handle 487 Request Terminated (CANCEL) specifically
      logWithDetails('CALL_CANCELLED_RECEIVED', {
        sessionId: session.id,
        callDirection: connectionState.callDirection
      });

      // Update UI with cancelled message
      updateConnectionState({
        callStatus: 'Call cancelled by remote party',
        hasActiveCall: false,
        callDirection: null
      });

      currentCall = null;

      // Clear the incoming call flag with extra logging
      logWithDetails('CLEARING_INCOMING_CALL_FLAG_ON_CANCEL');
      chrome.storage.local.set({ hasIncomingCall: false }, () => {
        if (chrome.runtime.lastError) {
          logWithDetails('ERROR_CLEARING_INCOMING_CALL_FLAG', { error: chrome.runtime.lastError });
        } else {
          logWithDetails('INCOMING_CALL_FLAG_CLEARED_SUCCESSFULLY');
        }
      });

      // Notify any open popups about the cancellation
      chrome.runtime.sendMessage({
        action: 'stateUpdated',
        state: connectionState,
        callTerminated: true,
        callCancelled: true
      });
    } else if (isNotRegistered) {
      // Handle 480 User Not Registered specifically
      logWithDetails('USER_NOT_REGISTERED_RECEIVED', {
        sessionId: session.id,
        callDirection: connectionState.callDirection
      });

      // Update UI with user not registered message
      updateConnectionState({
        callStatus: 'Call failed: User not registered',
        hasActiveCall: false,
        callDirection: null
      });

      currentCall = null;

      // Clear the incoming call flag
      chrome.storage.local.set({ hasIncomingCall: false });

      // Notify any open popups about the user not registered status
      chrome.runtime.sendMessage({
        action: 'stateUpdated',
        state: connectionState,
        callTerminated: true,
        userNotRegistered: true
      });
    } else if (isRejected) {
      // Handle other rejection responses
      const statusCode = session.lastResponse.statusCode;
      const reasonPhrase = session.lastResponse.reasonPhrase || 'Unknown reason';

      logWithDetails('CALL_REJECTED', {
        sessionId: session.id,
        statusCode: statusCode,
        reasonPhrase: reasonPhrase,
        callDirection: connectionState.callDirection
      });

      // Update UI with rejection message
      updateConnectionState({
        callStatus: `Call failed: ${statusCode} ${reasonPhrase}`,
        hasActiveCall: false,
        callDirection: null
      });

      currentCall = null;

      // Clear the incoming call flag
      chrome.storage.local.set({ hasIncomingCall: false });

      // Notify any open popups about the rejection
      chrome.runtime.sendMessage({
        action: 'stateUpdated',
        state: connectionState,
        callTerminated: true,
        rejectionReceived: true,
        statusCode: statusCode,
        reasonPhrase: reasonPhrase
      });
    } else {
      // For other non-BYE terminations, use a generic message
      updateConnectionState({
        callStatus: 'Call ended',
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
        byeReceived: false
      });
    }
  }
}

// Variables to track the standalone window
let phoneWindow = null;
let phoneWindowId = null;

// Function to open the standalone window
function openPhoneWindow() {
  // Check if window already exists
  if (phoneWindow && !chrome.runtime.lastError) {
    // Focus the existing window
    chrome.windows.update(phoneWindowId, { focused: true }, (_) => {
      if (chrome.runtime.lastError) {
        // Window doesn't exist anymore, create a new one
        createNewPhoneWindow();
      }
    });
  } else {
    // Create a new window
    createNewPhoneWindow();
  }
}

// Function to create a new phone window
function createNewPhoneWindow() {
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 340, /* Reduced by 15% from 400 */
    height: 330 /* Reduced by 45% from 600 */
  }, (window) => {
    phoneWindow = window;
    phoneWindowId = window.id;

    // Listen for window close event
    chrome.windows.onRemoved.addListener((windowId) => {
      if (windowId === phoneWindowId) {
        phoneWindow = null;
        phoneWindowId = null;
      }
    });
  });
}

// Listen for browser action click
chrome.browserAction.onClicked.addListener(() => {
  openPhoneWindow();
});

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

// Centralized function to handle BYE packets
function handleByePacket(session, bye) {
  logWithDetails('HANDLE_BYE_PACKET', {
    sessionId: session ? session.id : 'unknown',
    sessionExists: !!session,
    sessionState: session ? session.state : 'unknown',
    byeExists: !!bye,
    byeMethod: bye ? bye.method : 'unknown',
    callDirection: connectionState.callDirection,
    hasActiveCall: connectionState.hasActiveCall,
    currentCallExists: !!currentCall,
    currentCallMatchesSession: currentCall === session
  });

  // Update UI immediately with consistent message
  updateConnectionState({
    callStatus: 'Call ended by remote party',
    hasActiveCall: false,
    callDirection: null
  });

  // Clear the current call reference
  if (currentCall === session) {
    logWithDetails('CLEARING_CURRENT_CALL_REFERENCE', { sessionId: session ? session.id : 'unknown' });
    currentCall = null;
  } else if (currentCall) {
    logWithDetails('CURRENT_CALL_MISMATCH', {
      currentCallId: currentCall.id,
      byeSessionId: session ? session.id : 'unknown'
    });
    // Still clear it to be safe
    currentCall = null;
  }

  // Clear the incoming call flag
  chrome.storage.local.set({ hasIncomingCall: false });
  logWithDetails('CLEARED_INCOMING_CALL_FLAG_ON_BYE');

  // Notify any open popups about the BYE packet
  chrome.runtime.sendMessage({
    action: 'callHangup',
    state: connectionState,
    callTerminated: true,
    byeReceived: true,
    remoteHangup: true
  });

  // Also send a standard state update for backward compatibility
  chrome.runtime.sendMessage({
    action: 'stateUpdated',
    state: connectionState,
    callTerminated: true,
    byeReceived: true
  });

  // Try to open the phone window to show the call ended status
  try {
    logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_BYE');
    openPhoneWindow();
  } catch (error) {
    logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
  }

  logWithDetails('BYE_PACKET_HANDLED', {
    callDirection: connectionState.callDirection,
    callStatus: connectionState.callStatus,
    hasActiveCall: connectionState.hasActiveCall
  });
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

        // Extract caller information from the session
        let caller = 'Unknown';
        if (session && session.request && session.request.from) {
          // Try to get the display name or URI
          const fromHeader = session.request.from;
          if (fromHeader.displayName) {
            caller = fromHeader.displayName;
          } else if (fromHeader.uri) {
            caller = fromHeader.uri.user + '@' + fromHeader.uri.host;
          }
          logWithDetails('CALLER_INFO', { caller });
        }

        // Store the fact that we have an incoming call in a more persistent way
        chrome.storage.local.set({ hasIncomingCall: true }, () => {
          logWithDetails('INCOMING_CALL_FLAG_SET', {
            caller: caller,
            storageError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
          });

          // Try to open the phone window for incoming calls
          try {
            logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_INCOMING_CALL');
            openPhoneWindow();
          } catch (error) {
            logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
          }
        });

        updateConnectionState({
          callStatus: 'Incoming call...',
          hasActiveCall: true,
          callDirection: 'incoming',
          caller: caller
        });

        // Send an additional notification to ensure the UI is updated
        chrome.runtime.sendMessage({
          action: 'incomingCall',
          caller: caller,
          state: connectionState
        });

        // Add direct event listeners for BYE packets
        if (session) {
          // Add state change listener
          if (!session._stateChangeListenerAdded) {
            session.stateChange.addListener((newState) => {
              logWithDetails('INCOMING_CALL_STATE_CHANGED', {
                sessionId: session.id,
                oldState: session.state,
                newState: newState
              });

              handleSessionStateChange(session, newState);
            });
            session._stateChangeListenerAdded = true;
            logWithDetails('STATE_CHANGE_LISTENER_ADDED_FOR_INCOMING_CALL', { sessionId: session.id });
          } else {
            logWithDetails('STATE_CHANGE_LISTENER_ALREADY_EXISTS_FOR_INCOMING_CALL', { sessionId: session.id });
          }

          // Add specific BYE request listener if available
          if (session.delegate && typeof session.delegate.onBye === 'function') {
            // Only override if not already done
            if (!session._byeHandlerAdded) {
              const originalOnBye = session.delegate.onBye;
              session.delegate.onBye = (bye) => {
                logWithDetails('BYE_RECEIVED_DIRECTLY', {
                  sessionId: session.id,
                  byeExists: !!bye,
                  callDirection: 'incoming', // Explicitly log that this is for an incoming call
                  sessionState: session.state
                });

                // Use the centralized BYE packet handler
                handleByePacket(session, bye);

                // Call original handler if it exists
                if (originalOnBye) {
                  originalOnBye(bye);
                }
              };
              session._byeHandlerAdded = true;
              logWithDetails('BYE_HANDLER_ADDED_FOR_INCOMING', { sessionId: session.id });
            } else {
              logWithDetails('BYE_HANDLER_ALREADY_EXISTS_FOR_INCOMING', { sessionId: session.id });
            }
          } else {
            logWithDetails('NO_BYE_HANDLER_AVAILABLE_FOR_INCOMING', { sessionId: session.id });
          }

          // Add specific onCallHangup handler for incoming calls
          // Always override the onCallHangup handler to ensure it works properly
          session.delegate.onCallHangup = () => {
            logWithDetails('DELEGATE_CALL_HANGUP_FOR_INCOMING_INITIAL', {
              sessionId: session.id,
              sessionState: session.state,
              lastResponse: session.lastResponse ? {
                statusCode: session.lastResponse.statusCode,
                reasonPhrase: session.lastResponse.reasonPhrase
              } : 'none'
            });

            // Update connection state
            updateConnectionState({
              callStatus: 'Call ended by remote party',
              hasActiveCall: false,
              callDirection: null
            });

            // Clear the current call reference
            currentCall = null;

            // Clear the incoming call flag
            chrome.storage.local.set({ hasIncomingCall: false });

            // Send a specific notification for call hangup
            chrome.runtime.sendMessage({
              action: 'callHangup',
              state: connectionState,
              callTerminated: true,
              byeReceived: true,
              remoteHangup: true
            });

            // Try to open the phone window to show the call ended status
            try {
              logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_INCOMING_INITIAL_HANGUP');
              openPhoneWindow();
            } catch (error) {
              logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
            }
          };
          logWithDetails('HANGUP_HANDLER_ADDED_FOR_INCOMING_INITIAL', { sessionId: session.id });
        }

        // Show notification for incoming call - only if we haven't shown one recently
        // Check if we've shown a notification in the last 3 seconds
        chrome.storage.local.get(['lastNotificationTime'], (result) => {
          const now = Date.now();
          const lastTime = result.lastNotificationTime || 0;
          const timeSinceLastNotification = now - lastTime;

          // Only show notification if it's been more than 3 seconds since the last one
          if (timeSinceLastNotification > 3000) {
            // Update the last notification time
            chrome.storage.local.set({ lastNotificationTime: now });

            // Create the notification
            chrome.notifications.create('incoming-call', {
              type: 'basic',
              iconUrl: 'icons/icon16.png',
              title: 'Incoming Call',
              message: 'You have an incoming call. Open the extension to answer.',
              priority: 2
            });

            logWithDetails('CHROME_NOTIFICATION_CREATED', {
              caller: caller,
              timeSinceLastNotification: timeSinceLastNotification
            });
          } else {
            logWithDetails('CHROME_NOTIFICATION_SKIPPED', {
              reason: 'Recent notification exists',
              timeSinceLastNotification: timeSinceLastNotification
            });
          }
        });
      },
      onCallAnswered: () => {
        logWithDetails('DELEGATE_CALL_ANSWERED');
        updateConnectionState({
          callStatus: 'Call connected',
          hasActiveCall: true
        });

        // Send an additional notification to ensure the UI is updated
        chrome.runtime.sendMessage({
          action: 'callAnswered',
          state: connectionState
        });

        // Try to open the phone window for answered calls
        try {
          logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_ANSWERED_CALL');
          openPhoneWindow();
        } catch (error) {
          logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
        }

        // After a call is answered, make sure we have the correct session reference
        if (simpleUser._session) {
          const session = simpleUser._session;
          logWithDetails('UPDATING_CURRENT_CALL_REFERENCE_AFTER_ANSWER', {
            sessionId: session.id,
            sessionState: session.state,
            dialog: !!session.dialog,
            userAgent: !!session.userAgent,
            remoteTarget: session.remoteTarget ? session.remoteTarget.toString() : 'none'
          });

          // Update the current call reference
          currentCall = session;

          // Make sure we have state change listeners attached
          if (!session._stateChangeListenerAdded) {
            session.stateChange.addListener((newState) => {
              handleSessionStateChange(session, newState);
            });
            session._stateChangeListenerAdded = true;
            logWithDetails('STATE_CHANGE_LISTENER_ADDED_AFTER_ANSWER_FOR_OUTGOING', { sessionId: session.id });
          }

          // Add specific BYE request listener for outgoing calls after they're answered
          if (session.delegate && typeof session.delegate.onBye === 'function') {
            // Always override the BYE handler to ensure it works properly
            const originalOnBye = session.delegate.onBye;
            session.delegate.onBye = (bye) => {
              logWithDetails('BYE_RECEIVED_FOR_OUTGOING_CALL_AFTER_ANSWER', {
                sessionId: session.id,
                byeExists: !!bye,
                callDirection: 'outgoing',
                sessionState: session.state
              });

              // Use the centralized BYE packet handler
              handleByePacket(session, bye);

              // Call original handler if it exists
              if (originalOnBye) {
                originalOnBye(bye);
              }
            };
            session._byeHandlerAdded = true;
            logWithDetails('BYE_HANDLER_ADDED_FOR_OUTGOING_AFTER_ANSWER', { sessionId: session.id });
          }

          // Add specific onCallHangup handler for outgoing calls after they're answered
          session.delegate.onCallHangup = () => {
            logWithDetails('DELEGATE_CALL_HANGUP_FOR_OUTGOING_AFTER_ANSWER', {
              sessionId: session.id,
              sessionState: session.state,
              lastResponse: session.lastResponse ? {
                statusCode: session.lastResponse.statusCode,
                reasonPhrase: session.lastResponse.reasonPhrase
              } : 'none'
            });

            // Update connection state
            updateConnectionState({
              callStatus: 'Call ended',
              hasActiveCall: false,
              callDirection: null
            });

            // Clear the current call reference
            currentCall = null;

            // Send a specific notification for call hangup
            chrome.runtime.sendMessage({
              action: 'callHangup',
              state: connectionState,
              callTerminated: true,
              byeReceived: true
            });

            // Try to open the phone window to show the call ended status
            try {
              logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_OUTGOING_HANGUP_AFTER_ANSWER');
              openPhoneWindow();
            } catch (error) {
              logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
            }
          };
          logWithDetails('HANGUP_HANDLER_ADDED_FOR_OUTGOING_AFTER_ANSWER', { sessionId: session.id });
        }
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

        // Send a specific notification for call hangup
        chrome.runtime.sendMessage({
          action: 'callHangup',
          state: connectionState,
          callTerminated: true,
          byeReceived: true
        });

        // Try to open the phone window to show the call ended status
        try {
          logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_HANGUP');
          openPhoneWindow();
        } catch (error) {
          logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
        }
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
      logWithDetails('ADDING_STATE_CHANGE_LISTENER_TO_OUTGOING_CALL', {
        sessionId: session.id,
        sessionState: session.state
      });

      // Listen for state changes in the session using our global handler
      if (!session._stateChangeListenerAdded) {
        session.stateChange.addListener((newState) => {
          handleSessionStateChange(session, newState);
        });
        session._stateChangeListenerAdded = true;
        logWithDetails('STATE_CHANGE_LISTENER_ADDED_FOR_OUTGOING', { sessionId: session.id });
      }

      // Add specific BYE request listener for outgoing calls
      if (session.delegate && typeof session.delegate.onBye === 'function') {
        // Only override if not already done
        if (!session._byeHandlerAdded) {
          const originalOnBye = session.delegate.onBye;
          session.delegate.onBye = (bye) => {
            logWithDetails('BYE_RECEIVED_FOR_OUTGOING_CALL', {
              sessionId: session.id,
              byeExists: !!bye,
              callDirection: 'outgoing', // Explicitly log that this is for an outgoing call
              sessionState: session.state
            });

            // Use the centralized BYE packet handler
            handleByePacket(session, bye);

            // Call original handler if it exists
            if (originalOnBye) {
              originalOnBye(bye);
            }
          };
          session._byeHandlerAdded = true;
          logWithDetails('BYE_HANDLER_ADDED_FOR_OUTGOING', { sessionId: session.id });
        } else {
          logWithDetails('BYE_HANDLER_ALREADY_EXISTS_FOR_OUTGOING', { sessionId: session.id });
        }
      } else {
        logWithDetails('NO_BYE_HANDLER_AVAILABLE_FOR_OUTGOING', { sessionId: session.id });
      }

      // Add response event listener to catch SIP responses like 486 Busy Here
      // Always override the onCallHangup handler to ensure it works properly
      session.delegate.onCallHangup = () => {
        logWithDetails('DELEGATE_CALL_HANGUP_FOR_OUTGOING', {
          sessionId: session.id,
          sessionState: session.state,
          lastResponse: session.lastResponse ? {
            statusCode: session.lastResponse.statusCode,
            reasonPhrase: session.lastResponse.reasonPhrase
          } : 'none'
        });

        // Update connection state
        updateConnectionState({
          callStatus: 'Call ended',
          hasActiveCall: false,
          callDirection: null
        });

        // Clear the current call reference
        currentCall = null;

        // Send a specific notification for call hangup
        chrome.runtime.sendMessage({
          action: 'callHangup',
          state: connectionState,
          callTerminated: true,
          byeReceived: true
        });

        // Try to open the phone window to show the call ended status
        try {
          logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_OUTGOING_HANGUP');
          openPhoneWindow();
        } catch (error) {
          logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
        }
      };
      logWithDetails('HANGUP_HANDLER_ADDED_FOR_OUTGOING', { sessionId: session.id });

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
      if (!session._stateChangeListenerAdded) {
        session.stateChange.addListener((newState) => {
          handleSessionStateChange(session, newState);
        });
        session._stateChangeListenerAdded = true;
        logWithDetails('STATE_CHANGE_LISTENER_ADDED_AFTER_ANSWER', { sessionId: session.id });
      } else {
        logWithDetails('STATE_CHANGE_LISTENER_ALREADY_EXISTS', { sessionId: session.id });
      }

      // Add specific BYE request listener if available
      if (session.delegate && typeof session.delegate.onBye === 'function') {
        // Only override if not already done
        if (!session._byeHandlerAdded) {
          const originalOnBye = session.delegate.onBye;
          session.delegate.onBye = (bye) => {
            logWithDetails('BYE_RECEIVED_AFTER_ANSWER', {
              sessionId: session.id,
              byeExists: !!bye,
              callDirection: 'incoming', // Explicitly log that this is for an answered incoming call
              sessionState: session.state
            });

            // Use the centralized BYE packet handler
            handleByePacket(session, bye);

            // Call original handler if it exists
            if (originalOnBye) {
              originalOnBye(bye);
            }
          };
          session._byeHandlerAdded = true;
          logWithDetails('BYE_HANDLER_ADDED_AFTER_ANSWER', { sessionId: session.id });
        } else {
          logWithDetails('BYE_HANDLER_ALREADY_EXISTS', { sessionId: session.id });
        }
      } else {
        logWithDetails('NO_BYE_HANDLER_AVAILABLE', { sessionId: session.id });
      }

      // Add specific onCallHangup handler for incoming calls
      // Always override the onCallHangup handler to ensure it works properly
      session.delegate.onCallHangup = () => {
        logWithDetails('DELEGATE_CALL_HANGUP_FOR_INCOMING', {
          sessionId: session.id,
          sessionState: session.state,
          lastResponse: session.lastResponse ? {
            statusCode: session.lastResponse.statusCode,
            reasonPhrase: session.lastResponse.reasonPhrase
          } : 'none'
        });

        // Update connection state
        updateConnectionState({
          callStatus: 'Call ended by remote party',
          hasActiveCall: false,
          callDirection: null
        });

        // Clear the current call reference
        currentCall = null;

        // Clear the incoming call flag
        chrome.storage.local.set({ hasIncomingCall: false });

        // Send a specific notification for call hangup
        chrome.runtime.sendMessage({
          action: 'callHangup',
          state: connectionState,
          callTerminated: true,
          byeReceived: true,
          remoteHangup: true
        });

        // Try to open the phone window to show the call ended status
        try {
          logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_INCOMING_HANGUP');
          openPhoneWindow();
        } catch (error) {
          logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
        }
      };
      logWithDetails('HANGUP_HANDLER_ADDED_FOR_INCOMING', { sessionId: session.id });

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
            logWithDetails('USING_BYE_METHOD', {
              state: session.state,
              callDirection: connectionState.callDirection,
              sessionId: session.id
            });

            // Use the standard bye method for both inbound and outbound calls
            logWithDetails('USING_STANDARD_BYE_METHOD', {
              sessionId: session.id,
              callDirection: connectionState.callDirection
            });

            // Call the standard bye method
            await session.bye();
            logWithDetails('STANDARD_BYE_SENT');

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

    case 'transfer':
      // Transfer the current call
      transferCall(message.target).then(() => {
        sendResponse({
          success: true,
          state: connectionState,
          message: 'Call transferred successfully'
        });
      }).catch(error => {
        sendResponse({
          success: false,
          error: error.message,
          state: connectionState,
          message: error.message
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
