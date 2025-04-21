// Audio element for playing the dialing tone
let audioElement = null;

// Function to play the dialing tone
function playDialTone() {
  try {
    // Create audio element if it doesn't exist
    if (!audioElement) {
      audioElement = new Audio();

      // Use the provided dialing tone file
      // Use chrome.runtime.getURL to get the correct path in the extension
      audioElement.src = chrome.runtime.getURL('audio/dial1.ogg');
      audioElement.loop = true;
    }

    // Stop any existing sound
    stopDialTone();

    // Play the audio
    audioElement.play().catch(error => {
      console.error('Error playing dialing audio:', error);
    });

    // Return the audio element so it can be referenced later
    return audioElement;
  } catch (error) {
    console.error('Error playing dialing tone:', error);
    return null;
  }
}

// Function to stop the dialing tone
function stopDialTone() {
  try {
    // Stop the audio
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
    }
  } catch (error) {
    console.error('Error stopping dialing tone:', error);
  }
}

// Export the functions
export { playDialTone, stopDialTone };
