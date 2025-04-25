// Notifications module for the WebRTC SIP Client extension
import { playRingtone, stopRingtone } from '../audio/ringtone.js';

// Store the active notification
let activeNotification = null;
// Flag to track if ringtone is playing
let isRingtonePlaying = false;
// Flag to prevent multiple notifications for the same call
let notificationCreatedTimestamp = 0;

// Create a notification for an incoming call
function createIncomingCallNotification(caller = 'Unknown') {
  // Prevent multiple notifications within 3 seconds
  const now = Date.now();
  const timeSinceLastNotification = now - notificationCreatedTimestamp;

  // If we already have an active notification or it's been less than 3 seconds since the last one
  if (activeNotification || timeSinceLastNotification < 3000) {
    console.log('Notification already active or created recently, skipping duplicate');
    // Still ensure the ringtone is playing
    playRingtoneSound();
    return;
  }

  // Update the timestamp
  notificationCreatedTimestamp = now;

  // Check if notifications are supported
  if (!('Notification' in window)) {
    console.error('This browser does not support desktop notifications');
    // Still play the sound even if notifications aren't supported
    playRingtoneSound();
    return;
  }

  // Check if we have permission
  if (Notification.permission === 'granted') {
    showNotification(caller);
  } else if (Notification.permission !== 'denied') {
    // Request permission
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        showNotification(caller);
      } else {
        // Still play the sound even if notification permission is denied
        playRingtoneSound();
      }
    });
  } else {
    // Still play the sound even if notification permission is denied
    playRingtoneSound();
  }
}

// Play the ringtone sound
function playRingtoneSound() {
  if (!isRingtonePlaying) {
    try {
      // Play the ringtone and store the audio element
      const audioElement = playRingtone();
      isRingtonePlaying = true;
      console.log('Ringtone started', audioElement);
    } catch (error) {
      console.error('Failed to play ringtone:', error);
    }
  }
}

// Show the notification
function showNotification(caller) {
  // Play ringtone
  playRingtoneSound();

  // Create notification
  activeNotification = new Notification('Phone - Incoming Call', {
    body: `Incoming call from ${caller}`,
    icon: '../icons/icon128.png',
    requireInteraction: true,
    silent: true // We're handling the sound ourselves
  });

  // Add event listeners
  activeNotification.onclick = function() {
    // Focus on the extension popup
    window.focus();

    // Close the notification
    this.close();

    // Stop the ringtone
    stopRingtoneSound();
  };

  activeNotification.onclose = function() {
    // Stop the ringtone when notification is closed
    stopRingtoneSound();
    activeNotification = null;
  };

  return activeNotification;
}

// Stop the ringtone sound
function stopRingtoneSound() {
  if (isRingtonePlaying) {
    try {
      stopRingtone();
      isRingtonePlaying = false;
      console.log('Ringtone stopped');
    } catch (error) {
      console.error('Failed to stop ringtone:', error);
    }
  }
}

// Stop any active notifications and ringtones
function stopNotifications() {
  // Stop the ringtone
  stopRingtoneSound();

  // Close any active notification
  if (activeNotification) {
    activeNotification.close();
    activeNotification = null;
  }
}

// Export the functions
export { createIncomingCallNotification, stopNotifications };
