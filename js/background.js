// Background script for the WebRTC SIP Client extension

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('WebRTC SIP Client extension installed');

  // Initialize default settings if needed
  chrome.storage.local.get(['sipServer', 'wsServer'], (result) => {
    if (!result.sipServer) {
      chrome.storage.local.set({
        sipServer: 'example.com',
        wsServer: 'wss://example.com:7443/ws'
      });
    }
  });
});

// Handle messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'checkMicrophonePermission') {
    // Check if we have microphone permission
    chrome.permissions.contains({ permissions: ['microphone'] })
      .then((result) => {
        if (result) {
          sendResponse({ status: 'granted' });
        } else {
          sendResponse({ status: 'denied' });
        }
      })
      .catch((error) => {
        console.error('Error checking microphone permission:', error);
        sendResponse({ status: 'error', error: error.message });
      });
    return true; // Required for async sendResponse
  } else if (message.action === 'requestMicrophonePermission') {
    // Request microphone permission
    chrome.permissions.request({ permissions: ['microphone'] })
      .then((granted) => {
        sendResponse({ granted });
      })
      .catch((error) => {
        console.error('Error requesting microphone permission:', error);
        sendResponse({ granted: false, error: error.message });
      });
    return true; // Required for async sendResponse
  }
});
