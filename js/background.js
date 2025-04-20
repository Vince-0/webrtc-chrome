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
    // We can't directly check microphone permission from the background script
    // So we'll just inform the popup to check it directly
    sendResponse({ status: 'unknown' });
    return true;
  }
});
