// Background script for the WebRTC SIP Client extension

// We can't use importScripts with type:module in manifest v3
// We'll need to include the SIP.js library in the HTML file

// Import the call log module
import CallLog from './call-log.js';

// Global state
let simpleUser = null;
let userAgent = null;
let currentCall = null;
let currentCallId = null;
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
async function handleByePacket(session, bye) {
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

  // Log the call end in the call log
  if (currentCallId) {
    // Get the current call data to check if it was answered
    const result = await new Promise(resolve => {
      chrome.storage.local.get(['currentCall'], resolve);
    });

    // Log the current call data for debugging
    logWithDetails('CURRENT_CALL_DATA_FOR_BYE', {
      currentCallId,
      currentCallData: result.currentCall ? {
        id: result.currentCall.id,
        direction: result.currentCall.direction,
        answered: result.currentCall.answered,
        status: result.currentCall.status,
        startTime: result.currentCall.startTime,
        answerTime: result.currentCall.answerTime
      } : 'no data',
      connectionState: {
        callDirection: connectionState.callDirection,
        callStatus: connectionState.callStatus
      },
      sessionState: session ? session.state : 'unknown'
    });

    // Store the call ID we're about to process
    const callIdToProcess = currentCallId;

    // Clear the current call ID immediately to prevent duplicate processing
    currentCallId = null;

    // DIRECT FIX: Force the correct status based on call data
    let callStatus;

    // Check for SIP response codes in the session that indicate rejection
    const statusCode = session && session.lastResponse ? session.lastResponse.statusCode : null;
    const reasonPhrase = session && session.lastResponse ? session.lastResponse.reasonPhrase : null;

    // Log the SIP response information
    logWithDetails('SIP_RESPONSE_INFO_IN_BYE_HANDLER', {
      statusCode: statusCode,
      reasonPhrase: reasonPhrase,
      sessionState: session ? session.state : 'unknown',
      callDirection: result.currentCall ? result.currentCall.direction : connectionState.callDirection
    });

    // Check for rejection indicators in the SIP response
    let isRejectedBySipResponse = false;
    let isUnavailableBySipResponse = false;

    if (statusCode) {
      if (statusCode === 486 || statusCode === 603 || statusCode === 487 || statusCode >= 600) {
        isRejectedBySipResponse = true;
        logWithDetails('DETECTED_REJECTION_FROM_SIP_RESPONSE', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase
        });
      } else if (statusCode === 480) {
        isUnavailableBySipResponse = true;
        logWithDetails('DETECTED_UNAVAILABLE_FROM_SIP_RESPONSE', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase,
          sessionState: session ? session.state : 'unknown',
          callDirection: result.currentCall ? result.currentCall.direction : connectionState.callDirection,
          currentCallData: result.currentCall ? {
            id: result.currentCall.id,
            direction: result.currentCall.direction,
            answered: result.currentCall.answered,
            status: result.currentCall.status
          } : 'no data'
        });

        // Force log to console for debugging
        console.warn('SIP 480 DETECTED', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase,
          sessionState: session ? session.state : 'unknown',
          callDirection: result.currentCall ? result.currentCall.direction : connectionState.callDirection
        });
      }
    }

    if (reasonPhrase &&
        (reasonPhrase.toLowerCase().includes('reject') ||
         reasonPhrase.toLowerCase().includes('decline'))) {
      isRejectedBySipResponse = true;
      logWithDetails('DETECTED_REJECTION_FROM_REASON_PHRASE', {
        reasonPhrase: reasonPhrase
      });
    }

    if (result.currentCall && result.currentCall.answered === true) {
      // If the call was definitely answered, mark as completed
      callStatus = 'completed';
      logWithDetails('FORCE_COMPLETED_STATUS', {
        reason: 'Call was answered',
        answered: result.currentCall.answered,
        answerTime: result.currentCall.answerTime
      });
    } else if (result.currentCall && result.currentCall.status === 'rejected') {
      // If the call was explicitly rejected, mark as rejected
      callStatus = 'rejected';
      logWithDetails('FORCE_REJECTED_STATUS', {
        reason: 'Call was explicitly rejected',
        status: result.currentCall.status
      });
    } else if (result.currentCall && result.currentCall.direction === 'incoming' && !result.currentCall.answered) {
      // If it was an incoming call that wasn't answered, mark as missed
      callStatus = 'missed';
      logWithDetails('FORCE_MISSED_STATUS', {
        reason: 'Incoming call was not answered',
        direction: result.currentCall.direction,
        answered: result.currentCall.answered
      });
    } else if (result.currentCall && result.currentCall.direction === 'outgoing' && !result.currentCall.answered) {
      // If it was an outgoing call that wasn't answered, check for rejection or unavailability
      if (result.currentCall.status === 'rejected' || isRejectedBySipResponse) {
        // If the call was explicitly rejected by the remote party
        callStatus = 'rejected';

        // Update the call status in storage to ensure consistency
        if (result.currentCall.status !== 'rejected') {
          const updatedCall = {
            ...result.currentCall,
            status: 'rejected'
          };

          // Save the updated call data
          await chrome.storage.local.set({ currentCall: updatedCall });
          logWithDetails('UPDATED_OUTGOING_CALL_STATUS_TO_REJECTED_IN_BYE', {
            callId: callIdToProcess,
            previousStatus: result.currentCall.status,
            statusCode: statusCode,
            reasonPhrase: reasonPhrase
          });
        }

        logWithDetails('FORCE_REJECTED_STATUS_FOR_OUTGOING', {
          reason: 'Outgoing call was rejected by remote party',
          direction: result.currentCall.direction,
          status: 'rejected',
          sipStatusCode: statusCode,
          sipReasonPhrase: reasonPhrase
        });
      } else if (isUnavailableBySipResponse) {
        // If the remote party is temporarily unavailable (SIP 480)
        callStatus = 'unavailable';

        // Update the call status in storage to ensure consistency
        const updatedCall = {
          ...result.currentCall,
          status: 'unavailable'
        };

        // Save the updated call data
        await chrome.storage.local.set({ currentCall: updatedCall });
        logWithDetails('UPDATED_OUTGOING_CALL_STATUS_TO_UNAVAILABLE_IN_BYE', {
          callId: callIdToProcess,
          previousStatus: result.currentCall.status,
          statusCode: statusCode,
          reasonPhrase: reasonPhrase
        });

        logWithDetails('FORCE_UNAVAILABLE_STATUS_FOR_OUTGOING', {
          reason: 'Remote party is temporarily unavailable',
          direction: result.currentCall.direction,
          status: 'unavailable',
          sipStatusCode: statusCode,
          sipReasonPhrase: reasonPhrase
        });
      } else if (result.currentCall.status === 'cancelled') {
        // If the call was cancelled by the local user
        callStatus = 'cancelled';
        logWithDetails('FORCE_CANCELLED_STATUS_FOR_OUTGOING', {
          reason: 'Outgoing call was cancelled by local user',
          direction: result.currentCall.direction,
          status: result.currentCall.status
        });
      } else {
        // Default for unanswered outgoing calls
        callStatus = 'no-answer';
        logWithDetails('FORCE_NO_ANSWER_STATUS', {
          reason: 'Outgoing call was not answered',
          direction: result.currentCall.direction,
          answered: result.currentCall.answered,
          status: result.currentCall.status || 'none'
        });
      }
    } else if (session && session.state === 'Established') {
      // If the session was established, mark as completed
      callStatus = 'completed';
      logWithDetails('FORCE_COMPLETED_STATUS_FROM_SESSION', {
        reason: 'Session was established',
        sessionState: session.state
      });
    } else if (connectionState.callDirection === 'incoming') {
      // Default for incoming calls
      callStatus = 'missed';
      logWithDetails('DEFAULT_MISSED_STATUS', {
        reason: 'Default for incoming call',
        callDirection: connectionState.callDirection
      });
    } else {
      // Default for outgoing calls - check for rejection or unavailability indicators
      if (isRejectedBySipResponse) {
        callStatus = 'rejected';
        logWithDetails('DEFAULT_REJECTED_STATUS_FROM_SIP', {
          reason: 'SIP response indicates rejection',
          statusCode: statusCode,
          reasonPhrase: reasonPhrase
        });
      } else if (isUnavailableBySipResponse) {
        callStatus = 'unavailable';
        logWithDetails('DEFAULT_UNAVAILABLE_STATUS_FROM_SIP', {
          reason: 'SIP response indicates temporary unavailability',
          statusCode: statusCode,
          reasonPhrase: reasonPhrase
        });
      } else {
        callStatus = 'no-answer';
        logWithDetails('DEFAULT_NO_ANSWER_STATUS', {
          reason: 'Default for outgoing call',
          callDirection: connectionState.callDirection
        });
      }
    }

    // Log the final status decision
    logWithDetails('FINAL_CALL_STATUS_DECISION', {
      callId: callIdToProcess,
      finalStatus: callStatus,
      callData: result.currentCall ? {
        direction: result.currentCall.direction,
        answered: result.currentCall.answered,
        status: result.currentCall.status
      } : 'no data'
    });

    // End the call with the determined status
    await CallLog.endCall(callIdToProcess, callStatus);
  }

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

  // Notify any open popups about the BYE packet - ensure remoteHangup flag is set
  chrome.runtime.sendMessage({
    action: 'callHangup',
    state: connectionState,
    callTerminated: true,
    byeReceived: true,
    remoteHangup: true
  });

  // Also send a standard state update with explicit flags for remote hangup
  chrome.runtime.sendMessage({
    action: 'stateUpdated',
    state: connectionState,
    callTerminated: true,
    byeReceived: true,
    remoteHangup: true,
    forceUIUpdate: true
  });

  // Try to open the phone window to show the call ended status
  try {
    logWithDetails('ATTEMPTING_TO_OPEN_PHONE_WINDOW_FOR_BYE');
    openPhoneWindow();
  } catch (error) {
    logWithDetails('ERROR_OPENING_PHONE_WINDOW', { error });
  }

  // Force a UI refresh after a short delay to ensure the UI is updated
  setTimeout(() => {
    chrome.runtime.sendMessage({
      action: 'stateUpdated',
      state: connectionState,
      callTerminated: true,
      byeReceived: true,
      remoteHangup: true,
      forceUIUpdate: true
    });
    logWithDetails('SENT_DELAYED_UI_UPDATE_FOR_BYE');
  }, 500);

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
        server: wsServerUrl,
        // Use the actual SIP server domain for Via header instead of .invalid
        viaHost: server
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
      onCallReceived: async (session) => {
        logWithDetails('DELEGATE_CALL_RECEIVED', {
          sessionId: session ? session.id : 'unknown',
          sessionExists: !!session
        });

        // Store the session reference
        currentCall = session;

        // Extract caller information from the session
        let caller = 'Unknown';
        let callerNumber = 'Unknown';
        if (session && session.request && session.request.from) {
          // Try to get the display name or URI
          const fromHeader = session.request.from;
          if (fromHeader.displayName) {
            caller = fromHeader.displayName;
          } else if (fromHeader.uri) {
            caller = fromHeader.uri.user + '@' + fromHeader.uri.host;
          }

          // Get the caller number (SIP URI user part)
          if (fromHeader.uri && fromHeader.uri.user) {
            callerNumber = fromHeader.uri.user;
          }

          logWithDetails('CALLER_INFO', { caller, callerNumber });
        }

        // Start tracking the call in the call log
        currentCallId = await CallLog.startCall('incoming', callerNumber, caller);

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
              iconUrl: 'icons/icon48.png',
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
      onCallAnswered: async () => {
        logWithDetails('DELEGATE_CALL_ANSWERED');
        updateConnectionState({
          callStatus: 'Call connected',
          hasActiveCall: true
        });

        // Update call log to mark the call as answered
        if (currentCallId) {
          await CallLog.callAnswered(currentCallId);
        }

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

          // Verify and log all dialog parameters to ensure they're properly set
          const dialogParams = session.dialog ? {
            id: session.dialog.id,
            callId: session.dialog.callId,
            localTag: session.dialog.localTag,
            remoteTag: session.dialog.remoteTag,
            dialogState: session.dialog.state
          } : 'no dialog';

          logWithDetails('UPDATING_CURRENT_CALL_REFERENCE_AFTER_ANSWER', {
            sessionId: session.id,
            sessionState: session.state,
            dialog: dialogParams,
            userAgent: !!session.userAgent,
            remoteTarget: session.remoteTarget ? session.remoteTarget.toString() : 'none',
            callDirection: connectionState.callDirection
          });

          // Store critical dialog parameters in a more accessible location
          if (session.dialog) {
            session._dialogParams = {
              callId: session.dialog.callId,
              localTag: session.dialog.localTag,
              remoteTag: session.dialog.remoteTag
            };
            logWithDetails('DIALOG_PARAMETERS_STORED', session._dialogParams);
          }

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
          // Always ensure the BYE handler is set up properly
          if (session.delegate) {
            const originalOnBye = session.delegate.onBye;
            session.delegate.onBye = (bye) => {
              logWithDetails('BYE_RECEIVED_FOR_OUTGOING_CALL_AFTER_ANSWER', {
                sessionId: session.id,
                byeExists: !!bye,
                callDirection: 'outgoing',
                sessionState: session.state,
                dialogExists: !!session.dialog,
                dialogParams: session._dialogParams || 'none'
              });

              // Use the centralized BYE packet handler
              handleByePacket(session, bye);

              // Call original handler if it exists
              if (originalOnBye) {
                originalOnBye(bye);
              }
            };
            session._byeHandlerAdded = true;
            logWithDetails('BYE_HANDLER_ADDED_FOR_OUTGOING_AFTER_ANSWER', {
              sessionId: session.id,
              sessionState: session.state
            });
          }

          // Add specific onCallHangup handler for outgoing calls after they're answered
          session.delegate.onCallHangup = () => {
            logWithDetails('DELEGATE_CALL_HANGUP_FOR_OUTGOING_AFTER_ANSWER', {
              sessionId: session.id,
              sessionState: session.state,
              lastResponse: session.lastResponse ? {
                statusCode: session.lastResponse.statusCode,
                reasonPhrase: session.lastResponse.reasonPhrase
              } : 'none',
              dialogExists: !!session.dialog,
              dialogParams: session._dialogParams || 'none',
              remoteTarget: session.remoteTarget ? session.remoteTarget.toString() : 'none'
            });

            // Update connection state
            updateConnectionState({
              callStatus: 'Call ended',
              hasActiveCall: false,
              callDirection: null
            });

            // We used to make a local copy of the session, but it's not needed
            // since we're using async/await which maintains the reference

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
          logWithDetails('HANGUP_HANDLER_ADDED_FOR_OUTGOING_AFTER_ANSWER', {
            sessionId: session.id,
            sessionState: session.state,
            dialogExists: !!session.dialog
          });
        }
      },
      onCallHangup: async () => {
        // This is the main onCallHangup handler that gets called when a call is rejected by the remote side
        // Get the session and response information if available
        const session = simpleUser._session;
        const statusCode = session && session.lastResponse ? session.lastResponse.statusCode : null;
        const reasonPhrase = session && session.lastResponse ? session.lastResponse.reasonPhrase : null;

        logWithDetails('DELEGATE_CALL_HANGUP', {
          sessionExists: !!session,
          sessionId: session ? session.id : 'unknown',
          sessionState: session ? session.state : 'unknown',
          lastResponse: session && session.lastResponse ? {
            statusCode: statusCode,
            reasonPhrase: reasonPhrase
          } : 'none',
          callDirection: connectionState.callDirection,
          currentCallId: currentCallId
        });

        // Check if we still have a valid call ID
        if (!currentCallId) {
          logWithDetails('DELEGATE_CALL_HANGUP_SKIPPED', {
            reason: 'No current call ID - call may have already been logged',
            callDirection: connectionState.callDirection
          });

          // Still update the UI state
          updateConnectionState({
            callStatus: 'Call ended',
            hasActiveCall: false,
            callDirection: null
          });

          currentCall = null;
          chrome.storage.local.set({ hasIncomingCall: false });

          // Send notification for UI update
          chrome.runtime.sendMessage({
            action: 'callHangup',
            state: connectionState,
            callTerminated: true,
            byeReceived: true
          });

          return; // Skip the rest of the handler
        }

        // Determine the appropriate status for the call log
        let callStatus = connectionState.callDirection === 'incoming' ? 'missed' : 'no-answer';

        // Log the reason phrase to help with debugging
        logWithDetails('CALL_HANGUP_REASON', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase,
          callDirection: connectionState.callDirection
        });

        if (statusCode) {
          if (statusCode === 486) {
            callStatus = 'busy';
          } else if (statusCode === 603) {
            callStatus = 'rejected';
          } else if (statusCode === 487) {
            // 487 Request Terminated is often used for rejected calls
            callStatus = 'rejected';
          } else if (statusCode >= 600) {
            // All 6xx responses are rejections
            callStatus = 'rejected';
          } else if (statusCode >= 400) {
            callStatus = 'failed';
          }
        }

        // Check the reason phrase for rejection indicators
        if (reasonPhrase &&
            (reasonPhrase.toLowerCase().includes('reject') ||
             reasonPhrase.toLowerCase().includes('decline'))) {
          callStatus = 'rejected';
        }

        // Get the current call data to check if it was explicitly rejected
        const result = await new Promise(resolve => {
          chrome.storage.local.get(['currentCall'], resolve);
        });

        if (result.currentCall && result.currentCall.status === 'rejected') {
          callStatus = 'rejected';
          logWithDetails('USING_REJECTED_STATUS_FROM_CALL_DATA', {
            callId: currentCallId,
            currentStatus: result.currentCall.status
          });
        }

        // Log the call in the call log
        if (currentCallId) {
          logWithDetails('LOGGING_CALL_END_IN_MAIN_HANDLER', {
            callId: currentCallId,
            status: callStatus
          });

          // Store the call ID we're about to process
          const callIdToProcess = currentCallId;

          // Clear the current call ID immediately to prevent duplicate processing
          currentCallId = null;

          // Now process the call
          await CallLog.endCall(callIdToProcess, callStatus);
        } else {
          logWithDetails('NO_CURRENT_CALL_ID_IN_MAIN_HANDLER');
        }

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

    // Start tracking the call in the call log
    currentCallId = await CallLog.startCall('outgoing', target, null);

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
      session.delegate.onCallHangup = async () => {
        // Get the response status code and reason phrase if available
        const statusCode = session.lastResponse ? session.lastResponse.statusCode : null;
        const reasonPhrase = session.lastResponse ? session.lastResponse.reasonPhrase : null;

        logWithDetails('DELEGATE_CALL_HANGUP_FOR_OUTGOING', {
          sessionId: session.id,
          sessionState: session.state,
          lastResponse: session.lastResponse ? {
            statusCode: statusCode,
            reasonPhrase: reasonPhrase
          } : 'none'
        });

        // Determine the appropriate status for the call log
        let callStatus = 'no-answer';

        // Log the reason phrase to help with debugging
        logWithDetails('SESSION_CALL_HANGUP_REASON', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase,
          callDirection: 'outgoing'
        });

        // Mark the call as rejected in the call data
        const result = await new Promise(resolve => {
          chrome.storage.local.get(['currentCall'], resolve);
        });

        if (result.currentCall) {
          // Update the call status based on the response
          let updatedStatus = 'no-answer';

          if (statusCode) {
            if (statusCode === 486) {
              updatedStatus = 'busy';
            } else if (statusCode === 480) {
              // 480 Temporarily Unavailable
              updatedStatus = 'unavailable';

              // Force log to console for debugging
              console.warn('SIP 480 DETECTED IN ONCALLHANGUP', {
                statusCode: statusCode,
                reasonPhrase: reasonPhrase,
                sessionState: session ? session.state : 'unknown',
                callDirection: 'outgoing'
              });

              logWithDetails('DETECTED_UNAVAILABLE_IN_ONCALLHANGUP', {
                statusCode: statusCode,
                reasonPhrase: reasonPhrase,
                sessionState: session ? session.state : 'unknown',
                callDirection: 'outgoing',
                currentCallData: result.currentCall ? {
                  id: result.currentCall.id,
                  direction: result.currentCall.direction,
                  answered: result.currentCall.answered,
                  status: result.currentCall.status
                } : 'no data'
              });
            } else if (statusCode === 603) {
              updatedStatus = 'rejected';
            } else if (statusCode === 487) {
              // 487 Request Terminated is often used for rejected calls
              updatedStatus = 'rejected';
            } else if (statusCode >= 600) {
              // All 6xx responses are rejections
              updatedStatus = 'rejected';
            } else if (statusCode >= 400) {
              updatedStatus = 'failed';
            }
          }

          // Check the reason phrase for rejection indicators
          if (reasonPhrase &&
              (reasonPhrase.toLowerCase().includes('reject') ||
               reasonPhrase.toLowerCase().includes('decline'))) {
            updatedStatus = 'rejected';
          }

          // Update the call status in storage
          const updatedCall = {
            ...result.currentCall,
            status: updatedStatus
          };

          // Save the updated call data
          await chrome.storage.local.set({ currentCall: updatedCall });
          logWithDetails('UPDATED_OUTGOING_CALL_STATUS_FROM_HANGUP', {
            callId: currentCallId,
            newStatus: updatedStatus,
            statusCode: statusCode,
            reasonPhrase: reasonPhrase
          });

          // Use the updated status for the call log
          callStatus = updatedStatus;
        } else {
          // If we don't have call data, determine status from the response
          if (statusCode) {
            if (statusCode === 486) {
              callStatus = 'busy';
            } else if (statusCode === 480) {
              // 480 Temporarily Unavailable
              callStatus = 'unavailable';

              // Force log to console for debugging
              console.warn('SIP 480 DETECTED IN ONCALLHANGUP FALLBACK', {
                statusCode: statusCode,
                reasonPhrase: reasonPhrase,
                sessionState: session ? session.state : 'unknown',
                callDirection: 'outgoing'
              });

              logWithDetails('DETECTED_UNAVAILABLE_IN_ONCALLHANGUP_FALLBACK', {
                statusCode: statusCode,
                reasonPhrase: reasonPhrase,
                sessionState: session ? session.state : 'unknown',
                callDirection: 'outgoing'
              });
            } else if (statusCode === 603) {
              callStatus = 'rejected';
            } else if (statusCode === 487) {
              // 487 Request Terminated is often used for rejected calls
              callStatus = 'rejected';
            } else if (statusCode >= 600) {
              // All 6xx responses are rejections
              callStatus = 'rejected';
            } else if (statusCode >= 400) {
              callStatus = 'failed';
            }
          }

          // Check the reason phrase for rejection indicators
          if (reasonPhrase &&
              (reasonPhrase.toLowerCase().includes('reject') ||
               reasonPhrase.toLowerCase().includes('decline'))) {
            callStatus = 'rejected';
          }
        }

        // Log the call in the call log
        if (currentCallId) {
          await CallLog.endCall(currentCallId, callStatus);
          currentCallId = null;
        }

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

    // Update call log to mark the call as answered
    if (currentCallId) {
      await CallLog.callAnswered(currentCallId);
    }

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
      session.delegate.onCallHangup = async () => {
        // Get the response status code and reason phrase if available
        const statusCode = session.lastResponse ? session.lastResponse.statusCode : null;
        const reasonPhrase = session.lastResponse ? session.lastResponse.reasonPhrase : null;

        logWithDetails('DELEGATE_CALL_HANGUP_FOR_INCOMING', {
          sessionId: session.id,
          sessionState: session.state,
          lastResponse: session.lastResponse ? {
            statusCode: statusCode,
            reasonPhrase: reasonPhrase
          } : 'none'
        });

        // Determine the appropriate status for the call log
        let callStatus = 'missed';

        // Log the reason phrase to help with debugging
        logWithDetails('INCOMING_CALL_HANGUP_REASON', {
          statusCode: statusCode,
          reasonPhrase: reasonPhrase,
          callDirection: 'incoming'
        });

        if (statusCode) {
          if (statusCode === 486) {
            callStatus = 'busy';
          } else if (statusCode === 603) {
            callStatus = 'rejected';
          } else if (statusCode === 487) {
            // 487 Request Terminated is often used for rejected calls
            callStatus = 'rejected';
          } else if (statusCode >= 600) {
            // All 6xx responses are rejections
            callStatus = 'rejected';
          } else if (statusCode >= 400) {
            callStatus = 'failed';
          }
        }

        // Check the reason phrase for rejection indicators
        if (reasonPhrase &&
            (reasonPhrase.toLowerCase().includes('reject') ||
             reasonPhrase.toLowerCase().includes('decline'))) {
          callStatus = 'rejected';
        }

        // Log the call in the call log
        if (currentCallId) {
          await CallLog.endCall(currentCallId, callStatus);
          currentCallId = null;
        }

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

    // Mark the call as rejected in the call data
    const result = await new Promise(resolve => {
      chrome.storage.local.get(['currentCall'], resolve);
    });

    if (result.currentCall) {
      // Update the call status to rejected
      const updatedCall = {
        ...result.currentCall,
        status: 'rejected'
      };

      // Save the updated call data
      await chrome.storage.local.set({ currentCall: updatedCall });
      logWithDetails('UPDATED_CALL_STATUS_TO_REJECTED', { callId: currentCallId });
    }

    // Log the call rejection in the call log
    if (currentCallId) {
      await CallLog.endCall(currentCallId, 'rejected');
      currentCallId = null;
    }

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
    // Define session variable in the outer scope so it's available throughout the function
    let session = null;

    if (simpleUser) {
      // Log the simpleUser object structure
      logWithDetails('SIMPLE_USER_OBJECT', {
        hasSession: !!simpleUser._session,
        userAgent: !!simpleUser.userAgent,
        delegate: !!simpleUser.delegate
      });

      // Try to access the session directly
      session = simpleUser._session || simpleUser.session;

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

            // Check for stored dialog parameters
            const hasDialogParams = !!session._dialogParams;
            const hasDialog = !!session.dialog;

            logWithDetails('USING_BYE_METHOD', {
              state: session.state,
              callDirection: connectionState.callDirection,
              sessionId: session.id,
              hasDialog: hasDialog,
              hasDialogParams: hasDialogParams,
              dialogParams: session._dialogParams || 'none'
            });

            // Use the standard bye method for both inbound and outbound calls
            logWithDetails('USING_STANDARD_BYE_METHOD', {
              sessionId: session.id,
              callDirection: connectionState.callDirection,
              remoteTarget: session.remoteTarget ? session.remoteTarget.toString() : 'none'
            });

            // We used to make a local copy of the session, but it's not needed
            // since we're using async/await which maintains the reference

            // Call the standard bye method
            await session.bye();
            logWithDetails('STANDARD_BYE_SENT');

            logWithDetails('BYE_SUCCESS');
          } else if (session.state === 'Establishing' ||
                    (typeof SIP !== 'undefined' && SIP.SessionState && session.state === SIP.SessionState.Establishing)) {
            // For sessions in the process of being established
            if (callDirection === 'outgoing') {
              logWithDetails('USING_CANCEL_METHOD', { state: session.state });

              // Mark the call as cancelled in the call data
              const result = await new Promise(resolve => {
                chrome.storage.local.get(['currentCall'], resolve);
              });

              if (result.currentCall) {
                // Update the call status to cancelled
                const updatedCall = {
                  ...result.currentCall,
                  status: 'cancelled'
                };

                // Save the updated call data
                await chrome.storage.local.set({ currentCall: updatedCall });
                logWithDetails('UPDATED_OUTGOING_CALL_STATUS_TO_CANCELLED', { callId: currentCallId });
              }

              // Log the cancelled outgoing call before cancelling
              if (currentCallId) {
                await CallLog.endCall(currentCallId, 'cancelled');
                currentCallId = null;
              }

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

    // Log the call end in the call log
    if (currentCallId) {
      // Determine the appropriate status based on call direction
      let callStatus = 'completed';

      // Get the current call data to check if it was answered or explicitly rejected
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['currentCall'], resolve);
      });

      if (result.currentCall) {
        // If the call was answered, mark it as completed
        if (result.currentCall.answered) {
          callStatus = 'completed';
          logWithDetails('MARKING_CALL_AS_COMPLETED', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown',
            wasAnswered: true
          });
        }
        // If this is an incoming call that was explicitly rejected, mark it as rejected
        else if (callDirection === 'incoming' &&
                (result.currentCall.status === 'rejected' || session && session.state !== 'Established')) {
          callStatus = 'rejected';

          // Update the call status to rejected in storage
          const updatedCall = {
            ...result.currentCall,
            status: 'rejected'
          };

          // Save the updated call data
          await chrome.storage.local.set({ currentCall: updatedCall });

          logWithDetails('MARKING_INCOMING_CALL_AS_REJECTED', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown',
            wasAnswered: false,
            currentStatus: result.currentCall.status
          });
        } else {
          logWithDetails('USING_DEFAULT_CALL_STATUS', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown',
            defaultStatus: callStatus
          });
        }
      } else {
        // If we can't get the call data, use the session state as a fallback
        if (callDirection === 'incoming' && session && session.state !== 'Established') {
          callStatus = 'rejected';
          logWithDetails('FALLBACK_MARKING_INCOMING_CALL_AS_REJECTED', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown'
          });
        } else if (session && session.state === 'Established') {
          callStatus = 'completed';
          logWithDetails('FALLBACK_MARKING_CALL_AS_COMPLETED', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown'
          });
        } else {
          logWithDetails('FALLBACK_USING_DEFAULT_STATUS', {
            callDirection: callDirection,
            sessionState: session ? session.state : 'unknown',
            defaultStatus: callStatus
          });
        }
      }

      await CallLog.endCall(currentCallId, callStatus);
      currentCallId = null;
    }

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
