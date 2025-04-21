// Audio element for playing the hangup sound
let audioElement = null;

// Function to play the hangup sound
function playHangupSound() {
  try {
    // Create audio element if it doesn't exist
    if (!audioElement) {
      audioElement = new Audio();

      // Use the provided hangup sound file
      // Use chrome.runtime.getURL to get the correct path in the extension
      audioElement.src = chrome.runtime.getURL('audio/hangup1.ogg');
      audioElement.loop = false;
    }

    // Reset the audio if it was previously played
    if (audioElement.currentTime > 0) {
      audioElement.currentTime = 0;
    }

    // Play the audio
    audioElement.play().catch(error => {
      console.error('Error playing hangup audio:', error);
    });

    // Return the audio element so it can be referenced later
    return audioElement;
  } catch (error) {
    console.error('Error playing hangup sound:', error);
    return null;
  }
}

// Export the function
export { playHangupSound };
