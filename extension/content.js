const API_URL = 'http://localhost:3000/summary';
const USAGE_API_URL = 'http://localhost:3000/usage'; // New endpoint for usage tracking
const PAYMENT_API_URL = 'http://localhost:3000/payment'; // New endpoint for payment processing

// Constants from the npm package
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

// Track if preview blocking is currently active
let previewBlockingActive = false;

// User ID for tracking usage
let userId = null;

// Helper function to check if a string is an email address
function isEmail(str) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(str);
}

// Function to clear any non-email IDs from storage
async function clearNonEmailIds() {
  try {
    const storedId = await new Promise(resolve => {
      chrome.storage.local.get(['tldrUserId'], function(result) {
        resolve(result.tldrUserId || null);
      });
    });
    
    if (storedId && !isEmail(storedId)) {
      console.log('Found non-email ID in storage, clearing it:', storedId);
      chrome.storage.local.remove(['tldrUserId'], function() {
        console.log('Cleared non-email ID from storage');
      });
    }
  } catch (error) {
    console.error('Error checking stored ID:', error);
  }
}

// Clear any non-email IDs at startup
clearNonEmailIds();

// Initialize user identification
initializeUserId();

// Function to initialize user identification
async function initializeUserId() {
  try {
    console.log('Initializing user identification');
    
    // First attempt to get email with interactive auth regardless of stored ID
    console.log('Trying to authenticate user with Chrome Identity API');
    const email = await getAuthenticatedUserEmail(true); // Set to true for interactive login
    
    if (email) {
      userId = email;
      console.log('User authenticated with email:', userId);
      
      return;
    }
    
    // Email authentication failed, try one more time with explicit interactive auth
    console.log('Authentication failed, trying explicit interactive authentication');
    try {
      const interactiveEmail = await getAuthenticatedUserEmail(true); // Force interactive authentication
      if (interactiveEmail) {
        userId = interactiveEmail;
        console.log('Successfully authenticated with interactive prompt:', userId);
        return;
      }
      
      console.log('Interactive authentication also failed');
    } catch (interactiveError) {
      console.error('Interactive authentication error:', interactiveError);
    }
    
    // If we still couldn't get an email, log the failure
    console.error('Failed to get user email after multiple attempts');
    
  } catch (error) {
    console.error('Error in user authentication:', error);
  }
}

// Helper function to get current user email - to be called when needed
async function getCurrentUserEmail() {
  try {
    // Always try to get a fresh email directly from Chrome Identity API first
    console.log('Attempting to get user email from Chrome Identity API');
    const email = await getAuthenticatedUserEmail(true); // Always use interactive authentication
    
    if (email) {
      // If we got an actual email, return it immediately without caching
      console.log('Successfully retrieved email from Chrome Identity API:', email);
      return email;
    }
    
    console.error('Failed to get email from Chrome Identity API');
    return null;
  } catch (error) {
    console.error('Error getting current user email:', error);
    return null;
  }
}

// Function to get authenticated user email using Chrome Identity API
async function getAuthenticatedUserEmail(interactive = false) {
  return new Promise((resolve, reject) => {
    // Use message passing to communicate with the background script
    chrome.runtime.sendMessage(
      { action: "getAuthToken", interactive: interactive },
      function(response) {
        if (response.error) {
          console.error("Error getting auth token:", response.error);
          reject(response.error);
        } else {
          resolve(response.email);
        }
      }
    );
  });
}

// Helper function to fetch user info with a token
async function fetchUserInfo(token) {
  // Get user info from Google
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }
  
  return await response.json();
}

// Function to check usage and update UI accordingly
async function checkUsage() {
  try {
    console.log('Checking usage status');
    
    // Get user email first
    const email = await getCurrentUserEmail();
    
    if (!email) {
      console.warn('No user email available, cannot check usage');
      return { hasReachedLimit: true, isFreeUser: true }; // Default to allowing usage if can't determine user
    }
    
    const response = await fetch(`${USAGE_API_URL}?email=${encodeURIComponent(email)}`);
    
    if (!response.ok) {
      console.error('Error checking usage:', response.status);
      return { hasReachedLimit: false, isFreeUser: true }; // Default to allowing usage if API fails
    }
    
    const data = await response.json();
    console.log('Usage data:', data);
    
    const hasSubscription = data.subscription ? true : false;
    
    // If user has reached limit, show upgrade popup
    if (data.hasReachedLimit) {
      // Find the current popup if it exists
      const currentPopup = document.querySelector('.tldr-popup[style*="display: block"]');
      if (currentPopup) {
        const content = currentPopup.querySelector('.tldr-content');
        if (content) {
          // Show usage limit message with upgrade button
          content.innerHTML = `
            <div class="upgrade-container">
              <h3>Usage Limit Reached</h3>
              <p>You've used all your free summaries for this month.</p>
              <p>Current usage: ${data.usage.current}/${data.usage.limit}</p>
              <button class="tldr-upgrade-button">Upgrade Now</button>
            </div>
          `;
          
          // Add click handler for upgrade button
          const upgradeButton = content.querySelector('.tldr-upgrade-button');
          if (upgradeButton) {
            upgradeButton.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              
              // Close current popup
              const popupContainer = content.closest('.tldr-popup');
              if (popupContainer) {
                popupContainer.style.display = 'none';
              }
              
              // Open the extension popup instead of the Chrome Web Store
              chrome.runtime.sendMessage({ action: "openPopup", plan: "pro" });
              console.log('Requested to open extension popup for plan: pro');
            });
          }
        }
      }
    }
    
    return {
      hasReachedLimit: data.hasReachedLimit,
      isFreeUser: !hasSubscription,
      usageData: data.usage,
      subscriptionData: data.subscription
    };
  } catch (error) {
    console.error('Error checking usage:', error);
    return { hasReachedLimit: false, isFreeUser: true }; // Default to allowing usage in case of error
  }
}

function isDarkTheme() {
  // YouTube adds a specific class to the html element when in dark mode
  return document.documentElement.hasAttribute('dark') || 
         document.documentElement.classList.contains('dark') ||
         document.body.classList.contains('dark-theme') ||
         document.querySelector('html[dark]') !== null;
}

function extractVideoId(url) {
  try {
    // Handle standard YouTube watch URLs
    if (url.includes('youtube.com/watch')) {
      const urlParams = new URLSearchParams(new URL(url).search);
      return urlParams.get('v');
    }
    
    // Handle YouTube Shorts URLs
    if (url.includes('youtube.com/shorts/')) {
      const shortsPath = url.split('youtube.com/shorts/')[1];
      const videoId = shortsPath.split('/')[0].split('?')[0];
      return videoId;
    }
    
    // Handle youtu.be shortened URLs
    if (url.includes('youtu.be/')) {
      const shortPath = url.split('youtu.be/')[1];
      return shortPath.split('/')[0].split('?')[0];
    }
    
    // Handle direct video IDs
    if (url.match(/^[A-Za-z0-9_-]{11}$/)) {
      return url;
    }
    
    // Handle other potential formats by searching for 11-character video ID
    const match = url.match(/([A-Za-z0-9_-]{11})/);
    if (match) return match[1];
    
    console.error('Could not extract video ID from:', url);
    return null;
  } catch (error) {
    console.error('Error extracting video ID:', error, 'URL:', url);
    return null;
  }
}

function createSummaryButton() {
  const button = document.createElement('button');
  button.className = 'tldr-button';
  button.innerHTML = '🔍 AI Summary';
  
  // Prevent clicks from propagating to YouTube elements
  button.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  return button;
}

function createSummaryPopup() {
  const popup = document.createElement('div');
  popup.className = 'tldr-popup';
  popup.style.display = 'none';

  // Add close button
  const closeButton = document.createElement('button');
  closeButton.className = 'tldr-close-button';
  closeButton.innerHTML = '×';
  
  // Prevent any click events from propagating
  closeButton.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  closeButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    popup.style.display = 'none';
    if (previewBlockingActive) {
      restoreYouTubePreview();
    }
  });
  
  popup.appendChild(closeButton);

  // Add content container
  const content = document.createElement('div');
  content.className = 'tldr-content';
  popup.appendChild(content);
  
  // Prevent clicks inside popup from propagating
  popup.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  // Apply theme after all elements are added
  applyThemeToPopup(popup);

  return popup;
}

function applyThemeToPopup(popup) {
  const isDark = isDarkTheme();
  
  if (isDark) {
    // Force dark theme with !important
    popup.setAttribute('style', 'background-color: #212121 !important; color: #ffffff !important;');
    
    const closeButton = popup.querySelector('.tldr-close-button');
    if (closeButton) {
      closeButton.setAttribute('style', 'background-color: rgba(255, 255, 255, 0.2) !important; color: white !important;');
    }
  } else {
    // Force light theme with !important
    popup.setAttribute('style', 'background-color: #f9f9f9 !important; color: #0f0f0f !important;');
    
    const closeButton = popup.querySelector('.tldr-close-button');
    if (closeButton) {
      closeButton.setAttribute('style', 'background-color: rgba(0, 0, 0, 0.1) !important; color: #606060 !important;');
    }
  }
  
  // Make sure display property is preserved
  if (popup.style.display === 'block') {
    popup.style.display = 'block';
  } else {
    popup.style.display = 'none';
  }
}

// Function to format the AI summary with proper styling
function formatAISummary(summaryText, videoId) {
  if (!summaryText) return '';
  
  // Clean up the input
  summaryText = summaryText.trim();

  console.log("Original summary:", summaryText);
  
  // Skip anything before the main point marker
  const mainPointIndex = summaryText.indexOf('💡 Main Point:');
  if (mainPointIndex >= 0) {
    summaryText = summaryText.substring(mainPointIndex);
  }
  
  // Extract main point section
  const mainPointRegex = /💡\s*Main Point:\s*\n([\s\S]*?)(?=\n⏱️|$)/;
  const mainPointMatch = summaryText.match(mainPointRegex);
  
  // Extract highlights section - make sure to capture ALL content after "⏱️ Highlights:"
  const highlightsRegex = /⏱️\s*Highlights:\s*\n([\s\S]*?)$/;
  const highlightsMatch = summaryText.match(highlightsRegex);
  
  let formattedHTML = '';
  
  // Format main point section
  if (mainPointMatch && mainPointMatch[1]) {
    const mainPointContent = mainPointMatch[1].trim();
    formattedHTML += `
      <div class="summary-section main-point">
        <h3><span class="emoji">💡</span> Main Point</h3>
        <p>${mainPointContent}</p>
      </div>
    `;
  }
  
  // Format highlights section
  if (highlightsMatch && highlightsMatch[1]) {
    console.log("Highlights match:", highlightsMatch);
    const highlightsContent = highlightsMatch[1].trim();
    console.log("Highlights content:", highlightsContent);
    
    // Process bullet points - split by asterisk to ensure we get all points
    const bulletPoints = highlightsContent.split('*')
                                        .map(line => line.trim())
                                        .filter(line => line.length > 0);
    
    console.log("Bullet points:", bulletPoints);
    
    let highlightsHTML = `
      <div class="summary-section highlights">
        <h3><span class="emoji">⏱️</span> Highlights</h3>
        <div class="highlights-list">
    `;
    
    // Process each highlight with a simpler approach
    bulletPoints.forEach(point => {
      console.log("Processing highlight:", point);
      
      // Look for backtick timestamp format: `[00:00]` - Description
      const timestampMatch = point.match(/`\[([0-9]{1,2}:[0-9]{1,2}(:[0-9]{1,2})?)\]`\s*-\s*(.*)/);
      
      if (timestampMatch) {
        const timestamp = timestampMatch[1];
        
        // Format timestamp - remove hours part if it's zero
        let formattedTimestamp = timestamp;
        
        // Check if timestamp is in HH:MM:SS format
        const timeRegex = /^(\d{2}):(\d{2}):(\d{2})$/;
        const match = timestamp.match(timeRegex);
        
        if (match && match[1] === '00') {
            // If hours are 00, reduce to MM:SS format
            formattedTimestamp = `${match[2]}:${match[3]}`;
        }
        
        const description = timestampMatch[3].trim();
        const timeInSeconds = convertTimestampToSeconds(formattedTimestamp);
        const videoUrl = `https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`;
        
        console.log(`Found timestamp: ${formattedTimestamp}, description: ${description}`);
        
        highlightsHTML += `
          <div class="highlight-row">
            <a href="${videoUrl}" class="timestamp-link">
              <span class="timestamp">${formattedTimestamp}</span>
            </a>
            <span class="highlight-description">${description}</span>
          </div>
        `;
      } else {
        // Try alternate format without backticks: [00:00] - Description
        const altTimestampMatch = point.match(/\[([0-9]{1,2}:[0-9]{1,2}(:[0-9]{1,2})?)\]\s*-\s*(.*)/);
        
        if (altTimestampMatch) {
          const timestamp = altTimestampMatch[1];
          const description = altTimestampMatch[3].trim();
          const timeInSeconds = convertTimestampToSeconds(timestamp);
          const videoUrl = `https://www.youtube.com/watch?v=${videoId}&t=${timeInSeconds}s`;
          
          console.log(`Found alt timestamp: ${timestamp}, description: ${description}`);
          
          highlightsHTML += `
            <div class="highlight-row">
              <a href="${videoUrl}" class="timestamp-link">
                <span class="timestamp">${timestamp}</span>
              </a>
              <span class="highlight-description">${description}</span>
            </div>
          `;
        } else {
          // No properly formatted timestamp, just display the raw line
          console.log("No timestamp found, using raw text");
          highlightsHTML += `
            <div class="highlight-row">
              <span class="highlight-description">${point}</span>
            </div>
          `;
        }
      }
    });
    
    highlightsHTML += `
        </div>
      </div>
    `;
    
    formattedHTML += highlightsHTML;
  }
  
  // If no structured format was found, just show the raw text with minimal formatting
  if (!formattedHTML) {
    formattedHTML = `<div class="summary-raw">${summaryText.replace(/\n/g, '<br>')}</div>`;
  }
  
  console.log("Formatted HTML:", formattedHTML);
  return formattedHTML;
}

// Function to make timestamps clickable while preserving original styling
function makeTimestampsClickable(summaryContainer, videoId) {
  // Check if we're on a video page with this videoId
  const isVideoPage = window.location.href.includes(`watch?v=${videoId}`);
  
  // Find all timestamp elements
  const timestampElements = summaryContainer.querySelectorAll('.timestamp-link, .timestamp');
  
  timestampElements.forEach(element => {
    // Skip if already processed to avoid style changes
    if (element.hasAttribute('data-timestamp-processed')) {
      return;
    }
    
    // Mark as processed
    element.setAttribute('data-timestamp-processed', 'true');
    
    // Get the timestamp text
    const timestampText = element.textContent.trim();
    const seconds = convertTimestampToSeconds(timestampText);
    
    if (isVideoPage) {
      // We're on the video page - use JavaScript to control the player
      if (element.tagName === 'A') {
        // Convert links to spans but preserve class for CSS styling
        const span = document.createElement('span');
        span.className = element.className; // Keep all original classes
        span.textContent = timestampText;
        
        // Only add minimal inline styles needed for interaction
        span.style.cursor = 'pointer';
        span.style.color = '#3ea6ff';
        
        // Mark as processed
        span.setAttribute('data-timestamp-processed', 'true');
        
        element.parentNode.replaceChild(span, element);
        element = span;
      } else {
        // For spans, only add minimal styles for interaction
        element.style.cursor = 'pointer';
        element.style.color = '#3ea6ff';
      }
      
      // Add click handler to control video player
      element.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Try multiple methods to control the player
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = seconds;
          video.play().catch(err => console.error('Could not play video:', err));
          console.log(`Jumped to ${timestampText} (${seconds}s)`);
        } else if (window.yt && window.yt.player && window.yt.player.getPlayerByElement) {
          // Try using YouTube's player API
          const playerElement = document.querySelector('#movie_player');
          if (playerElement) {
            const player = window.yt.player.getPlayerByElement(playerElement);
            if (player && player.seekTo) {
              player.seekTo(seconds, true);
              console.log(`Used yt.player API to jump to ${timestampText}`);
            }
          }
        } else {
          console.error('Could not find video player to control');
        }
      });
    } else {
      // Not on video page - use normal links but preserve styling
      if (element.tagName !== 'A') {
        // Convert to proper link with minimal style changes
        const link = document.createElement('a');
        link.href = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
        link.className = element.className; // Keep all original classes
        link.textContent = timestampText;
        link.target = '_blank';
        
        // Only add minimal inline styles needed for links
        link.style.color = '#3ea6ff';
        link.style.textDecoration = 'none';
        
        // Mark as processed
        link.setAttribute('data-timestamp-processed', 'true');
        
        element.parentNode.replaceChild(link, element);
      } else {
        // Just update the href but keep original styling
        element.href = `https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`;
        element.target = '_blank';
        
        // Only add minimal link styles
        element.style.color = '#3ea6ff';
        element.style.textDecoration = 'none';
      }
    }
  });
}

// Update the getSummary function to use the formatter
async function getSummary(videoId, transcript, content) {
  try {
    // Check usage limits before generating summary
    const usageStatus = await checkUsage();
    console.log("usageStatus", usageStatus)
    
    if (usageStatus.hasReachedLimit) {
      // Show upgrade popup if user has reached limit
      content.innerHTML = `
        <div class="upgrade-container">
          <h3>Usage Limit Reached</h3>
          <p>You've used all your free summaries for this month.</p>
          <p>Current usage: ${usageStatus.usageData?.current || 0}/${usageStatus.usageData?.limit || 0}</p>
          <button class="tldr-upgrade-button">Upgrade Now</button>
        </div>
      `;
      
      // Add click handler for upgrade button
      const upgradeButton = content.querySelector('.tldr-upgrade-button');
      if (upgradeButton) {
        upgradeButton.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          // Close current popup
          const popupContainer = content.closest('.tldr-popup');
          if (popupContainer) {
            popupContainer.style.display = 'none';
          }
          
          // Open the extension popup instead of the Chrome Web Store
          chrome.runtime.sendMessage({ action: "openPopup", plan: "pro" });
          console.log('Requested to open extension popup for plan: pro');
        });
      }
      return;
    }
    
    content.innerHTML = `
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <p>Generating summary...</p>
      </div>
    `;

    // Get current user email directly from Chrome Identity API
    const userIdentifier = await getCurrentUserEmail();

    // Simple request with just the necessary data
    const requestData = { videoId, transcript, userId: userIdentifier };

    // Create a container for the summary before making the fetch
    content.innerHTML = `
      <div class="summary-container">
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <p>Generating summary...</p>
        </div>
      </div>
    `;
    const summaryContainer = content.querySelector('.summary-container');

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60-second timeout
      
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // Get the error response as JSON
        const errorData = await response.json();
        console.error('API Error:', errorData);
        throw new Error(errorData.details || errorData.error || 'Request failed');
      }
      
      // Set up the reader for the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullSummary = '';
      
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          
          // Decode the chunk and split by newlines
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.trim());
          
          // Process each line
          for (const line of lines) {
            try {
              const data = JSON.parse(line);
              
              if (data.cached) {
                // Handle cached response
                fullSummary = data.summary;
                if (summaryContainer) {
                  summaryContainer.innerHTML = formatAISummary(fullSummary, videoId);
                  makeTimestampsClickable(summaryContainer, videoId);
                }
                break;
              } else if (data.chunk) {
                // Append new chunk to the summary
                fullSummary += data.chunk;
                // Update the formatted display
                if (summaryContainer) {
                  // Remove the loading animation when we get the first chunk
                  if (summaryContainer.querySelector('.loading-container')) {
                    summaryContainer.innerHTML = '';
                  }
                  summaryContainer.innerHTML = formatAISummary(fullSummary, videoId);
                  makeTimestampsClickable(summaryContainer, videoId);
                }
              }
              
              if (data.done) {
                // Summary is complete
                // Remove redundant tracking - backend already tracks usage in the /summary endpoint
                break;
              }
            } catch (e) {
              console.error('Error parsing stream chunk:', e, 'Line:', line);
            }
          }
        }
      } catch (streamError) {
        // Handle errors during streaming specifically
        console.error('Stream processing error:', streamError);
        
        if (streamError.message.includes('Extension context invalidated')) {
          // Handle extension context invalidation gracefully
          if (fullSummary) {
            // If we have partial data, show it anyway
            if (summaryContainer) {
              summaryContainer.innerHTML = formatAISummary(fullSummary, videoId);
              makeTimestampsClickable(summaryContainer, videoId);
              
              // Add a note about the partial data
              const noteDiv = document.createElement('div');
              noteDiv.className = 'error-note';
              noteDiv.innerHTML = '<p><em>Note: The summary may be incomplete due to an extension reload.</em></p>';
              summaryContainer.appendChild(noteDiv);
            }
          } else {
            // If we have no data at all, show a more specific error
            throw new Error('Extension was reloaded. Please try again.');
          }
        } else {
          // Rethrow other streaming errors
          throw streamError;
        }
      }
    } catch (fetchError) {
      console.error('Fetch error:', fetchError);
      
      if (fetchError.name === 'AbortError') {
        throw new Error('Request timed out. The server took too long to respond.');
      } else {
        throw fetchError;
      }
    }
  } catch (error) {
    content.innerHTML = `
      <div class="error-container">
        <h3>❌ Summary Error</h3>
        <p>${error.message || 'Failed to generate summary'}</p>
        <button class="tldr-retry-button">Retry</button>
      </div>
    `;
    
    // Add retry button functionality
    const retryButton = content.querySelector('.tldr-retry-button');
    if (retryButton) {
      retryButton.addEventListener('click', async () => {
        try {
          await getSummary(videoId, transcript, content);
        } catch (retryError) {
          console.error('Retry failed:', retryError);
        }
      });
    }
    
    console.error('Summary error:', error);
  }
}

// Add this debugging function to trace the video ID extraction process
function getYouTubeVideoId() {
  const currentUrl = window.location.href;
  console.log("Current page URL:", currentUrl);
  
  const extractedId = extractVideoId(currentUrl);
  console.log("Extracted video ID:", extractedId);
  
  // Try alternative methods to verify
  // 1. Check video element directly
  const videoElement = document.querySelector('video');
  if (videoElement && videoElement.src) {
    console.log("Video element src:", videoElement.src);
  }
  
  // 2. Check YouTube's own data
  if (window.ytplayer && window.ytplayer.config) {
    console.log("ytplayer video ID:", window.ytplayer.config.args.video_id);
  }
  
  return extractedId;
}

function addSummaryButtons() {
  // Original code for thumbnails
  const thumbnails = document.querySelectorAll('ytd-thumbnail:not([tldr-processed])');
  
  thumbnails.forEach(thumbnail => {
    const container = thumbnail.closest('ytd-rich-item-renderer');
    if (!container) return;

    const link = thumbnail.querySelector('a#thumbnail');
    if (!link) return;

    const videoId = extractVideoId(link.href);
    if (!videoId) return;

    const button = createSummaryButton();
    const popup = createSummaryPopup();
    
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Get current video ID with enhanced debugging
      console.log("Button clicked - getting video ID");
      const videoId = getYouTubeVideoId();
      console.log('Final video ID being used:', videoId);
      
      // Toggle popup visibility
      const isVisible = popup.style.display === 'block';
      
      // Hide any other open popups
      document.querySelectorAll('.tldr-popup').forEach(p => {
        if (p !== popup) p.style.display = 'none';
      });
      
      // If popup was already visible, hide it and exit
      if (isVisible) {
        popup.style.display = 'none';
        return;
      }
      
      // Show popup immediately with loading indicator
      const content = popup.querySelector('.tldr-content');
      content.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <p>Summarizing video...</p>
        </div>
      `;
      popup.style.display = 'block';
      
      // Double-check videoId before using it
      if (!videoId || !videoId.match(/^[A-Za-z0-9_-]{11}$/)) {
        console.error('Invalid video ID in click handler:', videoId);
        
        // Try to re-extract it from the link
        const updatedLink = thumbnail.querySelector('a#thumbnail');
        if (updatedLink) {
          const freshVideoId = extractVideoId(updatedLink.href);
          if (freshVideoId) {
            console.log('Re-extracted video ID:', freshVideoId);
            const validVideoId = freshVideoId;
            
            // Continue with the valid video ID
            try {
              // Fetch transcript
              let transcript = [];
              try {
                transcript = await getYouTubeTranscript(validVideoId);
              } catch (error) {
                console.error('Transcript fetch failed:', error);
                content.innerHTML = `
                  <div class="error-container">
                    <h3>❌ Transcript Error</h3>
                    <p>${error.message || 'Failed to load transcript'}</p>
                    <p>Attempting to generate summary without transcript...</p>
                  </div>
                `;
                // We'll still try to get the summary with an empty transcript
              }

              await getSummary(validVideoId, transcript, content);
            } catch (error) {
              console.error('Summary generation failed:', error);
              content.innerHTML = `
                <div class="error-container">
                  <h3>❌ Summary Error</h3>
                  <p>${error.message || 'Failed to generate summary'}</p>
                </div>
              `;
            }
            
            return;
          }
        }
        
        content.innerHTML = `
          <div class="error-container">
            <h3>❌ Error</h3>
            <p>Could not determine video ID</p>
          </div>
        `;
        return;
      }
      
      // Proceed with the valid video ID
      try {
        // Fetch transcript
        let transcript = [];
        try {
          transcript = await getYouTubeTranscript(videoId);
          console.log('Transcript fetched:', transcript);
        } catch (error) {
          console.error('Transcript fetch failed:', error);
          content.innerHTML = `
            <div class="error-container">
              <h3>❌ Transcript Error</h3>
              <p>${error.message || 'Failed to load transcript'}</p>
              <p>Attempting to generate summary without transcript...</p>
            </div>
          `;
          // We'll still try to get the summary with an empty transcript
        }

        await getSummary(videoId, transcript, content);
      } catch (error) {
        console.error('Summary generation failed:', error);
        content.innerHTML = `
          <div class="error-container">
            <h3>❌ Summary Error</h3>
            <p>${error.message || 'Failed to generate summary'}</p>
          </div>
        `;
      }
    });

    // Add click outside to close
    document.addEventListener('click', (e) => {
      if (!popup.contains(e.target) && !button.contains(e.target)) {
        popup.style.display = 'none';
      }
    });

    // Position the popup over the thumbnail
    thumbnail.style.position = 'relative';
    thumbnail.appendChild(popup);
    
    // Append the button to the container (not the thumbnail)
    container.appendChild(button);
    thumbnail.setAttribute('tldr-processed', 'true');
  });
  
  // NEW CODE: Add buttons to search results page
  const searchResults = document.querySelectorAll('ytd-video-renderer:not([tldr-processed])');
  
  searchResults.forEach(result => {
    // Mark as processed
    result.setAttribute('tldr-processed', 'true');
    
    // Find the dismissible container
    const dismissible = result.querySelector('#dismissible');
    if (!dismissible) return;
    
    // Find the video ID from the title link or thumbnail
    const titleLink = result.querySelector('a#video-title-link');
    const thumbnailLink = result.querySelector('a#thumbnail');
    const link = titleLink || thumbnailLink;
    if (!link) return;
    
    const videoId = extractVideoId(link.href);
    if (!videoId) return;
    
    // Create button and popup (same as in the original code)
    const button = createSummaryButton();
    const popup = createSummaryPopup();
    
    // Set position for the button - bottom right of dismissible
    if (window.getComputedStyle(dismissible).position === 'static') {
      dismissible.style.position = 'relative';
    }
    
    button.style.position = 'absolute';
    button.style.bottom = '8px';
    button.style.right = '8px';
    button.style.zIndex = '100';
    
    // Same click handler as in the original code
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!previewBlockingActive) {
        nukeYouTubePreview();
      } else {
        restoreYouTubePreview();
      }
      
      console.log("Search result button clicked - getting video ID");
      
      // Toggle popup visibility
      const isVisible = popup.style.display === 'block';
      
      // Hide any other open popups
      document.querySelectorAll('.tldr-popup').forEach(p => {
        if (p !== popup) p.style.display = 'none';
      });
      
      // If popup was already visible, hide it and exit
      if (isVisible) {
        popup.style.display = 'none';
        return;
      }
      
      // Show popup immediately with loading indicator
      const content = popup.querySelector('.tldr-content');
      content.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <p>Summarizing video...</p>
        </div>
      `;
      popup.style.display = 'block';
      
      // Use the extracted videoId directly since we know it's valid
      try {
        // Fetch transcript
        let transcript = [];
        try {
          transcript = await getYouTubeTranscript(videoId);
          console.log('Transcript fetched for search result:', transcript);
        } catch (error) {
          console.error('Transcript fetch failed:', error);
          content.innerHTML = `
            <div class="error-container">
              <h3>❌ Transcript Error</h3>
              <p>${error.message || 'Failed to load transcript'}</p>
              <p>Attempting to generate summary without transcript...</p>
            </div>
          `;
        }

        await getSummary(videoId, transcript, content);
      } catch (error) {
        console.error('Summary generation failed:', error);
        content.innerHTML = `
          <div class="error-container">
            <h3>❌ Summary Error</h3>
            <p>${error.message || 'Failed to generate summary'}</p>
          </div>
        `;
      }
    });
    
    // Add click outside to close
    document.addEventListener('click', (e) => {
      if (!popup.contains(e.target) && !button.contains(e.target)) {
        popup.style.display = 'none';
        if (previewBlockingActive) {
          restoreYouTubePreview();
        }
      }
    });
    
    // Position the popup over the thumbnail instead of in dismissible
    const thumbnail = result.querySelector('ytd-thumbnail');
    if (thumbnail) {
      // Make thumbnail position relative
      if (window.getComputedStyle(thumbnail).position === 'static') {
        thumbnail.style.position = 'relative';
      }
      
      // Add popup to thumbnail
      thumbnail.appendChild(popup);
      
      // Style popup to appear over the thumbnail properly
      popup.style.position = 'absolute';
      popup.style.top = '0';
      popup.style.left = '0';
      popup.style.right = '0';
      popup.style.bottom = '0';
      popup.style.zIndex = '101';
    } else {
      // Fallback to dismissible if thumbnail not found
      dismissible.appendChild(popup);
    }
    
    // Add button to dismissible container
    dismissible.appendChild(button);
  });
  
  // NEW CODE: Add summary button to video page sidebar
  const sidebarContainer = document.querySelector('#secondary-inner');
  if (sidebarContainer && !sidebarContainer.querySelector('.tldr-sidebar-button')) {
    // Get current video ID from the page URL
    const videoId = extractVideoId(window.location.href);
    if (!videoId) return;
    
    console.log('Adding summary button to video sidebar for:', videoId);
    
    // Create sidebar button with EXACTLY the same style as defined in CSS
    const sidebarButton = document.createElement('button');
    sidebarButton.className = 'tldr-summary-button tldr-sidebar-button';
    sidebarButton.innerHTML = '🔍 AI Summary';
    sidebarButton.style.cssText = `
      background: rgba(40, 40, 40, 0.9);
      color: white;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      font-family: Roboto, Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      z-index: 2000;
      transition: all 0.2s;
      box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
      padding: 8px 14px;
      width: 100%;
      margin: 10px 0;
    `;
    
    // Add hover effect exactly as in CSS
    sidebarButton.addEventListener('mouseenter', () => {
      sidebarButton.style.background = 'rgba(60, 60, 60, 0.95)';
      sidebarButton.style.transform = 'scale(1.05)';
    });
    
    sidebarButton.addEventListener('mouseleave', () => {
      sidebarButton.style.background = 'rgba(40, 40, 40, 0.9)';
      sidebarButton.style.transform = 'scale(1)';
    });
    
    // Create popup using existing function, but with position:relative
    const sidebarPopup = createSummaryPopup();
    
    // Explicitly set display: none and other styles
    sidebarPopup.style.cssText += `
      position: relative;
      margin: 8px 0 16px 0;
      max-height: 600px;
      overflow-y: auto;
      overscroll-behavior: contain;
      display: none;
      flex-direction: column;
    `;
    
    // Add event listener to prevent scroll propagation
    sidebarPopup.addEventListener('wheel', (e) => {
      // Check if popup needs scrolling
      const { scrollTop, scrollHeight, clientHeight } = sidebarPopup;
      const isAtTop = scrollTop === 0;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight;
      
      // Only prevent default if scrolling would be effective
      if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
        // At the boundary, let the page scroll
        return;
      } else {
        // Within content, prevent page scrolling
        e.stopPropagation();
      }
    }, { passive: false });
    
    // Ensure the content area also has proper overflow handling
    const popupContent = sidebarPopup.querySelector('.tldr-content');
    if (popupContent) {
      popupContent.style.cssText += `
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        max-height: none; /* Remove fixed height constraint */
      `;
    }
    
    // Add click handler
    sidebarButton.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      // Toggle popup visibility
      const isVisible = sidebarPopup.style.display === 'block';
      
      if (isVisible) {
        sidebarPopup.style.display = 'none';
        return;
      }
      
      // Get the CURRENT video ID right when the button is clicked
      const currentVideoId = extractVideoId(window.location.href);
      console.log('Current video ID when sidebar button clicked:', currentVideoId);
      
      if (!currentVideoId) {
        console.error('Could not determine current video ID');
        return;
      }
      
      // Show popup with loading indicator
      const content = sidebarPopup.querySelector('.tldr-content');
      content.innerHTML = `
        <div class="loading-container">
          <div class="loading-spinner"></div>
          <p>Generating summary...</p>
        </div>
      `;
      sidebarPopup.style.display = 'block';
      
      try {
        // Fetch transcript using current video ID, not the stored one
        let transcript = [];
        try {
          transcript = await getYouTubeTranscript(currentVideoId);
          console.log('Transcript fetched for sidebar summary:', transcript.length, 'segments');
        } catch (error) {
          console.error('Transcript fetch failed:', error);
          content.innerHTML = `
            <div class="error-container">
              <h3>❌ Transcript Error</h3>
              <p>${error.message || 'Failed to load transcript'}</p>
              <p>Attempting to generate summary without transcript...</p>
            </div>
          `;
        }

        await getSummary(currentVideoId, transcript, content);
      } catch (error) {
        console.error('Summary generation failed:', error);
        content.innerHTML = `
          <div class="error-container">
            <h3>❌ Summary Error</h3>
            <p>${error.message || 'Failed to generate summary'}</p>
          </div>
        `;
      }
    });
    
    // Create a wrapper div to hold both button and popup
    const wrapper = document.createElement('div');
    wrapper.className = 'tldr-sidebar-wrapper';
    wrapper.style.cssText = `
      width: 100%;
      position: relative;
    `;
    
    // Add elements to wrapper
    wrapper.appendChild(sidebarButton);
    wrapper.appendChild(sidebarPopup);
    
    // Find the first child in sidebar to insert before
    const firstSidebarElement = sidebarContainer.firstChild;
    sidebarContainer.insertBefore(wrapper, firstSidebarElement);
  }
}

// Add transcript logging to getYouTubeTranscript
async function getYouTubeTranscript(videoId) {
    try {
        console.log("Fetching transcript for video ID:", videoId);
        
        const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        const html = await response.text();

        // Extract ytInitialPlayerResponse
        const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (!playerResponseMatch) {
            throw new Error('Could not find transcript data');
        }

        const playerResponse = JSON.parse(playerResponseMatch[1]);

        // Find captions data
        const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer;
        if (!captions || !captions.captionTracks || captions.captionTracks.length === 0) {
            throw new Error('No captions available');
        }

        // Categorize captions as manual or auto-generated
        const manualCaptions = [];
        const autoCaptions = [];
        
        captions.captionTracks.forEach(track => {
            const isAuto = track.kind === 'asr';
            if (isAuto) {
                autoCaptions.push(track);
            } else {
                manualCaptions.push(track);
            }
        });
        
        // Select best caption track (prioritize English manual > English auto > any manual > any auto)
        const preferredLanguages = ['en', 'en-US', 'en-GB'];
        let captionTrack = null;
        
        // Try to find manual caption in preferred language
        for (const langCode of preferredLanguages) {
            const found = manualCaptions.find(track => 
                track.languageCode.startsWith(langCode)
            );
            if (found) {
                captionTrack = found;
                break;
            }
        }
        
        // If not found, try auto-generated in preferred language
        if (!captionTrack) {
            for (const langCode of preferredLanguages) {
                const found = autoCaptions.find(track => 
                    track.languageCode.startsWith(langCode)
                );
                if (found) {
                    captionTrack = found;
                    break;
                }
            }
        }
        
        // If still not found, use first available caption
        if (!captionTrack) {
            captionTrack = manualCaptions[0] || autoCaptions[0];
        }

        if (!captionTrack) {
            throw new Error('No suitable caption track found');
        }

        // Try to get JSON format for more reliable parsing
        const jsonUrl = `${captionTrack.baseUrl}&fmt=json3`;
        const jsonResponse = await fetch(jsonUrl);
        const jsonText = await jsonResponse.text();
        
        // Parse JSON format
        let transcript = [];
        if (jsonText.startsWith('{')) {
            try {
                const jsonData = JSON.parse(jsonText);
                if (jsonData.events) {
                    transcript = jsonData.events
                        .filter(event => event.segs && event.segs.length > 0)
                        .map(event => ({
                            text: event.segs.map(seg => seg.utf8).join(' ').trim(),
                            start: event.tStartMs / 1000,
                            duration: (event.dDurationMs || 1000) / 1000
                        }))
                        .filter(item => item.text);
                }
            } catch (e) {
                console.error('Error parsing JSON transcript:', e);
            }
        }
        
        // If JSON parsing failed or returned too few entries, try XML format
        if (transcript.length < 10) {
            console.log(`JSON parsing returned only ${transcript.length} entries, trying XML format...`);
            
            // Fetch the XML format
            const xmlUrl = captionTrack.baseUrl;
            const xmlResponse = await fetch(xmlUrl);
            const xmlText = await xmlResponse.text();
            
            // Parse XML using the improved method
            const xmlDoc = xmlText.replace(/>\s+</g, '><'); // Remove whitespace between tags
            const parts = xmlDoc.split('<text ').slice(1); // Skip the first split result (before first tag)
            
            const xmlTranscript = parts.map(part => {
                // Extract attributes and content
                const endOfTag = part.indexOf('>');
                if (endOfTag === -1) return null;
                
                const attributes = part.substring(0, endOfTag);
                const content = part.substring(endOfTag + 1, part.indexOf('</text>'));
                
                // Extract start and duration
                const startMatch = attributes.match(/start="([\d.]+)"/);
                const durationMatch = attributes.match(/dur="([\d.]+)"/);
                
                if (!startMatch || !durationMatch) return null;
                
                return {
                    text: content.replace(/&amp;/g, '&')
                        .replace(/&quot;/g, '"')
                        .replace(/&#39;/g, "'"),
                    start: parseFloat(startMatch[1]),
                    duration: parseFloat(durationMatch[1])
                };
            }).filter(Boolean);
            
            // If XML has more entries, use it instead
            if (xmlTranscript.length > transcript.length) {
                transcript = xmlTranscript;
            }
        }
        
        // Log the final transcript length for debugging
        console.log(`Final transcript has ${transcript.length} entries`);
        console.log("First 3 transcript entries:", transcript.slice(0, 3));
        console.log("Last 3 transcript entries:", transcript.slice(-3));
        
        return transcript;
    } catch (error) {
        console.error('Transcript fetch failed:', error);
        throw error;
    }
}

function formatTranscript(transcriptData) {
  if (!Array.isArray(transcriptData)) return 'Invalid transcript data';
  
  // Format each transcript segment with timestamp and text
  return transcriptData.map(segment => {
    // Format timestamp as minutes:seconds
    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    
    return `<div class="transcript-segment">
      <span class="timestamp">${timestamp}</span>
      <span class="text">${segment.text}</span>
    </div>`;
  }).join('');
}

// Run on page load and when content updates
addSummaryButtons();
new MutationObserver(addSummaryButtons).observe(document.body, {
  childList: true,
  subtree: true
});

// Update the theme observer to use our new function
const themeObserver = new MutationObserver(() => {
  document.querySelectorAll('.tldr-popup').forEach(popup => {
    applyThemeToPopup(popup);
  });
});

// Observe both document and body for theme changes
themeObserver.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['dark', 'class']
});

themeObserver.observe(document.body, {
  attributes: true,
  attributeFilter: ['class']
});

// Add CSS for the loading spinner with centering styles
function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .loading-spinner {
      width: 40px;
      height: 40px;
      margin: 10px auto;
      border: 4px solid rgba(0, 0, 0, 0.1);
      border-radius: 50%;
      border-top: 4px solid #3498db;
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    .loading-container {
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      padding: 20px;
      height: 100%;
      width: 100%;
      box-sizing: border-box;
    }
    
    .tldr-content {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
    }
    
    .dark-theme .loading-spinner,
    html[dark] .loading-spinner {
      border: 4px solid rgba(255, 255, 255, 0.1);
      border-top: 4px solid #3498db;
    }
    
    .summary-section {
      margin-bottom: 15px;
      width: 100%;
    }
    
    .summary-section h3 {
      font-size: 14px;
      margin-bottom: 6px;
      font-weight: 600;
      display: flex;
      align-items: center;
    }
    
    .emoji {
      margin-right: 6px;
    }
    
    .main-point p {
      font-size: 13px;
      line-height: 1.4;
      margin: 0;
    }
    
    .highlights ul {
      margin: 0;
      padding-left: 20px;
    }
    
    .highlights li {
      font-size: 12px;
      margin-bottom: 8px;
      line-height: 1.3;
    }
    
    .highlight-row {
      display: flex;
      align-items: flex-start;
    }
    
    .timestamp-link {
      font-family: monospace;
      background: rgba(0, 0, 0, 0.05);
      padding: 2px 3px;
      border-radius: 3px;
      margin-right: 5px;
      font-size: 11px;
      white-space: nowrap;
      flex-shrink: 0;
      margin-bottom: 3px;
    }
    
    .highlight-description {
      padding-left: 4px;
      text-indent: -2px;
    }
    
    html[dark] .timestamp-link,
    .dark-theme .timestamp-link {
      background: rgba(255, 255, 255, 0.1);
    }
    
    .summary-container {
      width: 100%;
      padding: 5px;
      box-sizing: border-box;
    }
    
    .error-container {
      text-align: center;
      padding: 15px;
    }
    
    .error-container h3 {
      color: #e74c3c;
      margin-bottom: 10px;
    }
    
    .error-note {
      background: rgba(255, 193, 7, 0.1);
      border-left: 3px solid #ffca28;
      padding: 8px 12px;
      margin-top: 15px;
      font-size: 12px;
    }
    
    .tldr-retry-button {
      background: #3ea6ff;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 5px 15px;
      margin-top: 10px;
      cursor: pointer;
      font-size: 13px;
      transition: background 0.2s;
    }
    
    .tldr-retry-button:hover {
      background: #2196f3;
    }
    
    html[dark] .tldr-retry-button,
    .dark-theme .tldr-retry-button {
      background: #2979ff;
    }
    
    html[dark] .tldr-retry-button:hover,
    .dark-theme .tldr-retry-button:hover {
      background: #2962ff;
    }
    
    /* Upgrade popup styles */
    .tldr-upgrade-container {
      width: 100%;
      text-align: center;
      padding: 20px;
    }
    
    .tldr-upgrade-container h2 {
      font-size: 18px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    
    .tldr-upgrade-container p {
      font-size: 14px;
      margin-bottom: 20px;
    }
    
    .tldr-plan-options {
      display: flex;
      justify-content: space-around;
      flex-wrap: wrap;
      gap: 20px;
    }
    
    .tldr-plan {
      background: rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 20px;
      min-width: 180px;
      flex: 1;
      max-width: 220px;
      transition: transform 0.2s;
    }
    
    html[dark] .tldr-plan {
      background: rgba(255, 255, 255, 0.05);
    }
    
    html:not([dark]) .tldr-plan {
      background: rgba(0, 0, 0, 0.05);
    }
    
    .tldr-plan.highlighted {
      transform: scale(1.05);
      border: 2px solid #3ea6ff;
    }
    
    .tldr-plan h3 {
      font-size: 16px;
      margin: 0 0 10px 0;
    }
    
    .tldr-price {
      font-size: 18px;
      font-weight: bold;
      color: #3ea6ff;
      margin: 10px 0;
    }
    
    .tldr-plan ul {
      text-align: left;
      padding-left: 20px;
      margin: 15px 0;
      font-size: 12px;
    }
    
    .tldr-plan ul li {
      margin-bottom: 5px;
    }
    
    .tldr-upgrade-button {
      background: #3ea6ff;
      color: white;
      border: none;
      border-radius: 4px;
      padding: 8px 16px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    .tldr-upgrade-button:hover {
      background: #2196f3;
      transform: scale(1.05);
    }
    
    .tldr-upgrade-content {
      flex-direction: column;
      overflow-y: auto;
    }
  `;
  document.head.appendChild(style);
}

// Call the style injection on page load
injectStyles();

// Helper function to convert timestamp to seconds
function convertTimestampToSeconds(timestamp) {
  const parts = timestamp.split(':').map(Number);
  let seconds = 0;
  
  if (parts.length === 3) {
    // HH:MM:SS format
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    // MM:SS format
    seconds = parts[0] * 60 + parts[1];
  }
  
  return seconds;
}

// Function to get current video ID from URL
function getVideoId() {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('v');
}

// Add this CSS to the document to style the timestamp links
const timestampStyles = `
  .timestamp-link {
    text-decoration: none;  /* Remove the underline */
    cursor: pointer;
  }
  
  .timestamp-link {
    color: #3ea6ff;  /* YouTube blue color */
    font-weight: bold;
    min-width: 40px;
    margin-right: 8px;
  }
  
  .timestamp-link:hover {
    color: #2196f3;  /* Slightly darker blue on hover */
    text-decoration: underline;  /* Add underline only on hover */
  }
`;

// Insert the styles into the document
function insertTimestampStyles() {
  const styleElement = document.createElement('style');
  styleElement.textContent = timestampStyles;
  document.head.appendChild(styleElement);
}

// Call this function when your extension initializes
insertTimestampStyles();

// Function to disable YouTube preview functionality
function nukeYouTubePreview() {
  console.log('🔥 Nuking YouTube preview...');
  previewBlockingActive = true;
  
  // Create or update the style element for blocking previews
  let styleEl = document.getElementById('tldr-preview-blocker');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'tldr-preview-blocker';
    document.head.appendChild(styleEl);
  }
  
  // Add CSS that prevents previews from appearing
  styleEl.textContent = `
    /* Hide video preview */
    #video-preview {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    
    /* Block hover events on thumbnails */
    ytd-thumbnail {
      pointer-events: none !important;
    }
    
    /* Re-enable pointer events for our buttons and popups */
    .tldr-summary-button,
    .tldr-popup,
    .tldr-popup * {
      pointer-events: auto !important;
    }
  `;
  
  console.log('YouTube preview nuking complete');
}

// Function to restore YouTube preview functionality
function restoreYouTubePreview() {
  console.log('🔄 Restoring YouTube preview functionality');
  previewBlockingActive = false;
  
  // Remove our blocking CSS
  const blockingStyle = document.getElementById('tldr-preview-blocker');
  if (blockingStyle) {
    blockingStyle.remove();
    console.log('Removed preview blocking CSS');
  }
  
  // Trigger mouse events on thumbnails to help YouTube recreate previews
  const thumbnails = document.querySelectorAll('ytd-thumbnail');
  thumbnails.forEach(thumbnail => {
    try {
      // Create and dispatch mouse events
      ['mouseover', 'mouseenter', 'mousemove'].forEach(eventType => {
        const event = new MouseEvent(eventType, {
          bubbles: true,
          cancelable: true,
          view: window
        });
        thumbnail.dispatchEvent(event);
      });
    } catch (e) {
      console.error('Error dispatching mouse events:', e);
    }
  });
  
  console.log('Preview functionality should now be restored');
}

// Create an upgrade popup
function createUpgradePopup() {
  // Create a popup to show the upgrade message
  const popup = document.createElement('div');
  popup.className = 'tldr-popup tldr-upgrade-popup';
  
  // Add close button
  const closeButton = document.createElement('button');
  closeButton.className = 'tldr-close-button';
  closeButton.innerHTML = '×';
  
  closeButton.addEventListener('click', () => {
    popup.style.display = 'none';
  });
  
  popup.appendChild(closeButton);
  
  // Create content directly based on free tier limit
  let content = document.createElement('div');
  content.className = 'tldr-content tldr-upgrade-content';
  
  content.innerHTML = `
    <div class="tldr-upgrade-container">
      <h2>Free Limit Reached</h2>
      <p>You've used all your free AI summaries.</p>
      <button class="tldr-upgrade-button-primary">Upgrade Now</button>
    </div>
  `;
  
  popup.appendChild(content);
  
  // Prevent clicks inside popup from propagating
  popup.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  
  // Add button click handler
  const upgradeButton = popup.querySelector('.tldr-upgrade-button-primary');
  if (upgradeButton) {
    upgradeButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Open the extension popup instead of the payment page
      chrome.runtime.sendMessage({ action: "openPopup" });
    });
  }
  
  // Apply theme after all elements are added
  applyThemeToPopup(popup);

  return popup;
}

// Stripe payment links
const STRIPE_PAYMENT_LINKS = {
  pro: 'https://buy.stripe.com/test_5kA9BFfJj6cD3PGaEF',
  premium: 'https://buy.stripe.com/test_6oEg0354F8kL5XO146'
};

function openPaymentPage(plan = 'pro') {
  // Send message to open extension popup
  chrome.runtime.sendMessage({ action: "openPopup", plan: plan });
  console.log(`Requested to open extension popup for plan: ${plan}`);
}

function handleUpgradeClick() {
  console.log('Upgrade button clicked');
  
  // Create a popup explaining the user has reached their limit
  const popup = document.createElement('div');
  popup.className = 'tldr-upgrade-popup';
  popup.innerHTML = `
    <div class="tldr-upgrade-popup-header">
      <span>YouTube TLDR</span>
      <button class="tldr-upgrade-close">&times;</button>
    </div>
    <div class="tldr-upgrade-popup-content">
      <h3>You've reached your free limit</h3>
      <p>You've used all your free summaries for this month.</p>
      <p>Upgrade to Pro for unlimited summaries and enhanced features.</p>
      <div class="tldr-upgrade-buttons">
        <button class="tldr-upgrade-button tldr-pro-button">Upgrade to Pro</button>
        <button class="tldr-upgrade-button tldr-premium-button">Upgrade to Premium</button>
      </div>
      <p class="tldr-upgrade-manage">
        <a href="#" class="tldr-manage-subscription">Manage subscription</a>
      </p>
    </div>
  `;
  
  // Apply theme after all elements are added
  applyThemeToPopup(popup);
  
  // Add to page
  document.body.appendChild(popup);
  
  // Add event listeners
  popup.querySelector('.tldr-upgrade-close').addEventListener('click', () => {
    popup.remove();
  });
  
  popup.querySelector('.tldr-pro-button').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "openPopup", plan: "pro" });
    popup.remove();
  });
  
  popup.querySelector('.tldr-premium-button').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "openPopup", plan: "premium" });
    popup.remove();
  });
  
  popup.querySelector('.tldr-manage-subscription').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.sendMessage({ action: "openPopup" });
    popup.remove();
  });
}

// Add a function to track URL changes and close popup when navigating to new videos
function setupURLChangeDetection(sidebarPopup) {
  let lastUrl = location.href;
  
  // Create an observer to watch for URL changes
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      console.log('URL changed from', lastUrl, 'to', location.href);
      lastUrl = location.href;
      
      // Close the popup when navigating to a new page
      if (sidebarPopup && sidebarPopup.style.display === 'block') {
        console.log('Closing sidebar popup due to navigation');
        sidebarPopup.style.display = 'none';
      }
    }
  });
  
  // Start observing
  urlObserver.observe(document, { subtree: true, childList: true });
  
  return urlObserver;
}

// After creating the sidebarPopup element
setupURLChangeDetection(sidebarPopup);
