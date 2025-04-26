// Call Log Module for WebRTC SIP Client

// Enhanced logging function
function logWithDetails(action, details = {}) {
  const timestamp = new Date().toISOString();
  const logPrefix = `[SIP CALL LOG ${action}] [${timestamp}]`;

  // Create a formatted log message
  let logMessage = `${logPrefix}`;

  // Add details if provided
  if (Object.keys(details).length > 0) {
    console.group(logMessage);
    for (const [key, value] of Object.entries(details)) {
      if (typeof value === 'object' && value !== null) {
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

// Call log functions
const CallLog = {
  // Maximum number of entries to keep
  MAX_ENTRIES: 10,

  // Get call log from storage
  async getCallLog() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['callLog'], (result) => {
        const callLog = result.callLog || [];
        logWithDetails('GET_CALL_LOG', { entriesCount: callLog.length });
        resolve(callLog);
      });
    });
  },

  // Save call log to storage
  async saveCallLog(callLog) {
    return new Promise((resolve) => {
      // Ensure we only keep the maximum number of entries
      const trimmedLog = callLog.slice(0, this.MAX_ENTRIES);

      chrome.storage.local.set({ callLog: trimmedLog }, () => {
        logWithDetails('SAVE_CALL_LOG', {
          entriesCount: trimmedLog.length,
          firstEntry: trimmedLog.length > 0 ? trimmedLog[0] : 'none'
        });
        resolve(trimmedLog);
      });
    });
  },

  // Add a new call entry
  async addCallEntry(entry) {
    try {
      // Get current call log
      const callLog = await this.getCallLog();

      // Add new entry at the beginning (newest first)
      callLog.unshift(entry);

      // Save updated log
      await this.saveCallLog(callLog);

      logWithDetails('ADDED_CALL_ENTRY', { entry });

      // Notify UI to refresh
      chrome.runtime.sendMessage({ action: 'callLogUpdated' });

      return true;
    } catch (error) {
      logWithDetails('ADD_CALL_ENTRY_ERROR', { error });
      return false;
    }
  },

  // Start tracking a call
  async startCall(direction, number, name) {
    const startTime = new Date();
    const callId = `call_${startTime.getTime()}`;

    // Create initial call entry
    const callEntry = {
      id: callId,
      timestamp: startTime.toISOString(),
      startTime: startTime.getTime(),
      direction,
      number: number || 'Unknown',
      name: name || 'Unknown',
      status: direction === 'outgoing' ? 'dialing' : 'ringing',
      duration: 0,
      answered: false,
      answerTime: null,
      endTime: null
    };

    // Save to storage temporarily to track the call
    await chrome.storage.local.set({ currentCall: callEntry });

    logWithDetails('STARTED_CALL_TRACKING', { callEntry });

    return callId;
  },

  // Update call when answered
  async callAnswered(callId) {
    try {
      const answerTime = new Date();

      // Get current call data
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['currentCall'], resolve);
      });

      if (!result.currentCall || result.currentCall.id !== callId) {
        logWithDetails('CALL_ANSWERED_ERROR', {
          error: 'No matching call found',
          callId,
          currentCall: result.currentCall
        });
        return false;
      }

      // Update call data
      const updatedCall = {
        ...result.currentCall,
        status: 'in-progress',
        answered: true,
        answerTime: answerTime.getTime()
      };

      // Save updated call data
      await chrome.storage.local.set({ currentCall: updatedCall });

      logWithDetails('CALL_ANSWERED', { updatedCall });

      return true;
    } catch (error) {
      logWithDetails('CALL_ANSWERED_ERROR', { error });
      return false;
    }
  },

  // End call and add to log
  async endCall(callId, finalStatus) {
    try {
      const endTime = new Date();

      // Get current call data
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['currentCall'], resolve);
      });

      if (!result.currentCall) {
        logWithDetails('END_CALL_ERROR', {
          error: 'No current call found',
          callId
        });
        return false;
      }

      const currentCall = result.currentCall;

      // Log detailed information about the call and status
      logWithDetails('END_CALL_DETAILED', {
        callId,
        providedFinalStatus: finalStatus,
        currentCallData: {
          id: currentCall.id,
          direction: currentCall.direction,
          answered: currentCall.answered,
          status: currentCall.status,
          startTime: currentCall.startTime,
          answerTime: currentCall.answerTime
        }
      });

      // Calculate duration in seconds
      let durationMs = 0;
      if (currentCall.answered && currentCall.answerTime) {
        // If call was answered, calculate from answer time to end time
        durationMs = endTime.getTime() - currentCall.answerTime;
      } else {
        // If call was not answered, calculate from start time to end time
        durationMs = endTime.getTime() - currentCall.startTime;
      }

      // Convert to seconds and round
      const durationSec = Math.round(durationMs / 1000);

      // Format duration as MM:SS
      const minutes = Math.floor(durationSec / 60);
      const seconds = durationSec % 60;
      const formattedDuration = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

      // Determine final status if not provided
      let status = finalStatus;

      // Log the status determination process
      logWithDetails('STATUS_DETERMINATION_START', {
        providedFinalStatus: finalStatus,
        callAnswered: currentCall.answered,
        callDirection: currentCall.direction,
        callStatus: currentCall.status
      });

      if (!status) {
        if (currentCall.answered) {
          status = 'completed';
          logWithDetails('STATUS_SET_TO_COMPLETED', {
            reason: 'Call was answered',
            answered: currentCall.answered,
            answerTime: currentCall.answerTime
          });
        } else if (currentCall.status === 'rejected') {
          status = 'rejected';
          logWithDetails('STATUS_SET_TO_REJECTED', {
            reason: 'Call status is rejected',
            currentStatus: currentCall.status
          });
        } else if (currentCall.status === 'unavailable') {
          status = 'unavailable';
          logWithDetails('STATUS_SET_TO_UNAVAILABLE', {
            reason: 'Call status is unavailable',
            currentStatus: currentCall.status
          });

          // Force log to console for debugging
          console.warn('CALL STATUS SET TO UNAVAILABLE', {
            callId: callId,
            currentCallStatus: currentCall.status,
            finalStatus: finalStatus
          });
        } else if (currentCall.direction === 'incoming') {
          status = 'missed';
          logWithDetails('STATUS_SET_TO_MISSED', {
            reason: 'Incoming call not answered',
            direction: currentCall.direction,
            answered: currentCall.answered
          });
        } else {
          // For outgoing calls that weren't answered
          status = 'no-answer';
          logWithDetails('STATUS_SET_TO_NO_ANSWER', {
            reason: 'Outgoing call not answered',
            direction: currentCall.direction,
            answered: currentCall.answered
          });
        }
      } else {
        logWithDetails('USING_PROVIDED_STATUS', {
          providedStatus: status
        });
      }

      // Make sure cancelled calls are properly marked
      if (finalStatus === 'cancelled') {
        status = 'cancelled';
        logWithDetails('STATUS_OVERRIDDEN_TO_CANCELLED', {
          previousStatus: status,
          finalStatus: finalStatus
        });
      }

      // Make sure unavailable calls are properly marked
      if (finalStatus === 'unavailable') {
        status = 'unavailable';
        logWithDetails('STATUS_OVERRIDDEN_TO_UNAVAILABLE', {
          previousStatus: status,
          finalStatus: finalStatus
        });

        // Force log to console for debugging
        console.warn('OVERRIDING CALL STATUS TO UNAVAILABLE FROM FINAL STATUS', {
          callId: callId,
          previousStatus: status,
          currentCallStatus: currentCall.status,
          finalStatus: finalStatus
        });
      }

      // Final status check - force completed for answered calls
      if (currentCall.answered && status !== 'completed' && finalStatus !== 'cancelled') {
        logWithDetails('STATUS_FORCED_TO_COMPLETED', {
          previousStatus: status,
          reason: 'Call was answered but status was not completed',
          answered: currentCall.answered,
          answerTime: currentCall.answerTime
        });
        status = 'completed';
      }

      // Final status check - force rejected for explicitly rejected calls
      if (currentCall.status === 'rejected' && status !== 'rejected' && finalStatus !== 'cancelled') {
        logWithDetails('STATUS_FORCED_TO_REJECTED', {
          previousStatus: status,
          reason: 'Call was rejected but status was not rejected',
          currentStatus: currentCall.status
        });
        status = 'rejected';
      }

      // Final status check - force unavailable for explicitly unavailable calls
      if (currentCall.status === 'unavailable' && status !== 'unavailable' && finalStatus !== 'cancelled') {
        logWithDetails('STATUS_FORCED_TO_UNAVAILABLE', {
          previousStatus: status,
          reason: 'Call was unavailable but status was not unavailable',
          currentStatus: currentCall.status
        });

        // Force log to console for debugging
        console.warn('FORCING CALL STATUS TO UNAVAILABLE', {
          callId: callId,
          previousStatus: status,
          currentCallStatus: currentCall.status,
          finalStatus: finalStatus
        });

        status = 'unavailable';
      }

      // Create final call entry
      const callEntry = {
        ...currentCall,
        endTime: endTime.getTime(),
        duration: durationSec,
        formattedDuration,
        status
      };

      // Add to call log
      await this.addCallEntry(callEntry);

      // Clear current call
      await chrome.storage.local.remove(['currentCall']);

      logWithDetails('ENDED_CALL', { callEntry });

      return true;
    } catch (error) {
      logWithDetails('END_CALL_ERROR', { error });
      return false;
    }
  },

  // Format timestamp for display
  formatTimestamp(isoString) {
    try {
      const date = new Date(isoString);

      // Format date as MM/DD/YYYY
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const day = date.getDate().toString().padStart(2, '0');
      const year = date.getFullYear();

      // Format time as HH:MM AM/PM
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // Convert 0 to 12

      return `${month}/${day}/${year} ${hours}:${minutes} ${ampm}`;
    } catch (error) {
      logWithDetails('FORMAT_TIMESTAMP_ERROR', { error, isoString });
      return 'Invalid Date';
    }
  }
};

export default CallLog;
