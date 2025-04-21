// Audio element for playing the ringtone
let audioElement = null;
let pulseInterval = null;

// Function to play the ringtone
function playRingtone() {
  try {
    // Create audio element if it doesn't exist
    if (!audioElement) {
      audioElement = new Audio();

      // Use the provided ringtone file
      // Use chrome.runtime.getURL to get the correct path in the extension
      audioElement.src = chrome.runtime.getURL('audio/ring1.mp3');
      audioElement.loop = true;
    }

    // Stop any existing sound
    stopRingtone();

    // Play the audio
    audioElement.play().catch(error => {
      console.error('Error playing audio:', error);
    });

    // Create a pulsing effect for the ringtone volume
    // Clear any existing interval
    if (pulseInterval) {
      clearInterval(pulseInterval);
    }

    // Set up new interval for pulsing effect
    pulseInterval = setInterval(() => {
      if (audioElement) {
        // Alternate between full and lower volume for pulsing effect
        audioElement.volume = audioElement.volume > 0.5 ? 0.2 : 1.0;
      }
    }, 500); // Pulse every 500ms

    // Return the audio element so it can be referenced later
    return audioElement;
  } catch (error) {
    console.error('Error playing ringtone:', error);
    return null;
  }
}

// Function to stop the ringtone
function stopRingtone() {
  try {
    // Clear the pulse interval
    if (pulseInterval) {
      clearInterval(pulseInterval);
      pulseInterval = null;
    }

    // Stop the audio
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
  } catch (error) {
    console.error('Error stopping ringtone:', error);
  }
}

// Export the functions
export { playRingtone, stopRingtone };
