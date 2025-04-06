// Configuration
const API_URL = 'http://localhost:3000/summary';
const USAGE_API_URL = 'http://localhost:3000/usage';
const API_BASE_URL = 'http://localhost:3000';

// Stripe payment links
const STRIPE_PAYMENT_LINKS = {
  pro: 'https://buy.stripe.com/test_5kA9BFfJj6cD3PGaEF',
  premium:  'https://buy.stripe.com/test_6oEg0354F8kL5XO146'
};

// Set theme based on user preference
document.addEventListener('DOMContentLoaded', function() {
  // Check if dark mode is enabled in YouTube
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.add('light-theme');
  }
  
  // Check if there's a pending plan selection, which could happen if we're opened by background.js
  const urlParams = new URLSearchParams(window.location.search);
  const planFromUrl = urlParams.get('plan');
  
  // Initialize the UI
  initUI();
  
  // Add retry button
  addRetryButton();
  
  if (planFromUrl) {
    console.log('Plan parameter detected in URL:', planFromUrl);
    // Switch to the plans tab
    switchTab('plans');
    // Select the specified plan
    selectPlan(planFromUrl);
  } else {
    // Check storage for a pending plan selection
    chrome.storage.local.get(['selectedPlan'], function(result) {
      if (result.selectedPlan) {
        console.log('Selected plan found in storage:', result.selectedPlan);
        // Switch to the plans tab
        switchTab('plans');
        // Select the specified plan
        selectPlan(result.selectedPlan);
        // Clear the stored plan selection
        chrome.storage.local.remove('selectedPlan');
      }
    });
  }
  
  // First check if server is reachable, then load user data
  checkServerStatus().then(isOnline => {
    if (isOnline) {
      // Server is reachable, load user data which also checks subscription status
      loadUserData();
    } else {
      // Fall back to cached data if server is unreachable
      loadCachedUserData();
      // Still check subscription status from local storage
      checkSubscriptionStatus();
      showError('Server is unreachable. Using cached data.', true, 
                `Could not connect to ${API_BASE_URL}. Please check if the server is running.`);
    }
  });
});

// Initialize UI interactions
function initUI() {
  // Set up tab navigation
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', function() {
      const tabId = this.getAttribute('data-tab');
      console.log(`Tab clicked: ${tabId}`);
      switchTab(tabId);
    });
  });
  
  // Upgrade button click
  const upgradeBtn = document.getElementById('upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', () => {
      console.log('Upgrade button clicked, switching to plans tab');
      switchTab('plans');
    });
  }
  
  // Plan selection
  document.querySelectorAll('.plan-card:not([data-plan="free"])').forEach(card => {
    card.addEventListener('click', function(event) {
      // Only handle clicks directly on the card (not on child elements like buttons)
      if (event.target === this) {
        const planId = this.getAttribute('data-plan');
        selectPlan(planId);
      }
    });
  });
  
  // Plan subscribe buttons
  const proBtn = document.getElementById('pro-btn');
  if (proBtn) {
    proBtn.addEventListener('click', () => {
      selectPlan('pro');
    });
  }
  
  const premiumBtn = document.getElementById('premium-btn');
  if (premiumBtn) {
    premiumBtn.addEventListener('click', () => {
      selectPlan('premium');
    });
  }
  
  // Initially check CORS configuration
  checkCorsConfiguration().then(isValid => {
    if (!isValid) {
      console.warn('CORS configuration issue detected');
      showError('Server CORS configuration issue detected', true, 
                'The server may not allow cross-origin requests from this extension');
    }
  });
}

// Check if server is reachable
async function checkServerStatus() {
  console.log(`Checking if server at ${API_BASE_URL} is reachable...`);
  try {
    // Use a HEAD request to check server status without fetching data
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('Server status check timeout triggered');
      controller.abort();
    }, 3000); // 3 second timeout
    
    // Try the root endpoint first (health check)
    try {
      console.log('Attempting HEAD request to server root...');
      const response = await fetch(`${API_BASE_URL}`, {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      console.log(`Server root responded with status: ${response.status}`);
      return response.status < 500; // Consider server reachable if status < 500
    } catch (rootError) {
      console.error('Root endpoint check failed, trying usage endpoint...', rootError);
      
      // If root endpoint fails, try the usage endpoint with a test ID
      const usageResponse = await fetch(`${USAGE_API_URL}?userId=test_connectivity`, {
        method: 'HEAD',
        cache: 'no-cache',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      console.log(`Usage endpoint responded with status: ${usageResponse.status}`);
      return usageResponse.status < 500;
    }
  } catch (error) {
    console.error('All server connection checks failed:', error);
    console.log('Marking server as unreachable');
    return false;
  }
}

// Load cached user data from storage
function loadCachedUserData() {
  // Hide loading indicator and show subscription section
  document.getElementById('loading').style.display = 'none';
  document.getElementById('subscription-section').style.display = 'block';
  
  // Attempt to load cached data
  chrome.storage.local.get(['tldrSubscriptionData'], function(storedData) {
    if (storedData.tldrSubscriptionData) {
      console.log('Using cached subscription data:', storedData.tldrSubscriptionData);
      showSubscriptionInfo(storedData.tldrSubscriptionData);
    } else {
      // If no stored data, show default free tier data
      console.log('No cached data available, showing default free tier');
      showSubscriptionInfo({
        hasReachedLimit: false,
        usage: {
          current: 0,
          limit: 5
        }
      });
    }
  });
}

// Load user subscription data from storage and API
async function loadUserData() {
  try {
    console.log('Starting loadUserData function');
    // Show loading indicator
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('subscription-section').style.display = 'none';
    
    // First check subscription data in local storage
    chrome.storage.local.get(['subscription'], function(result) {
      if (result.subscription) {
        // We have an active subscription, check if it's still valid
        const now = new Date();
        const expiryDate = new Date(result.subscription.expiryDate);
        
        if (now < expiryDate) {
          console.log('Found active subscription in local storage');
          // Hide loading
          document.getElementById('loading').style.display = 'none';
          document.getElementById('subscription-section').style.display = 'block';
          
          // Update UI based on subscription
          checkSubscriptionStatus();
          
          // Update plan cards
          updatePlanCards(result.subscription.plan);
          
          return; // Skip API call if we have a valid subscription
        }
      }
      
      // No valid subscription found in storage, proceed with API check
      continueLoadUserData();
    });
  } catch (error) {
    console.error('Error in initial subscription check:', error);
    continueLoadUserData();
  }
}

// Continue loading user data after subscription check
async function continueLoadUserData() {
  try {
    // Set a timeout to prevent infinite loading - increased to 10 seconds
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timed out')), 10000);
    });
    
    // Get user ID from storage
    chrome.storage.local.get(['tldrUserId'], async function(result) {
      try {
        if (!result.tldrUserId) {
          console.log('No user ID found, generating a new one');
          // Generate a new user ID if not present
          const userId = 'tldr_' + Math.random().toString(36).substring(2, 15) + 
                       Math.random().toString(36).substring(2, 15);
          console.log('Generated new user ID:', userId);
          chrome.storage.local.set({ tldrUserId: userId });
          
          // Show subscription info with default values (free tier)
          console.log('Showing default free tier information');
          showSubscriptionInfo({
            hasReachedLimit: false,
            usage: {
              current: 0,
              limit: 5
            }
          });
          
          // Hide loading indicator since we're using default data
          document.getElementById('loading').style.display = 'none';
          document.getElementById('subscription-section').style.display = 'block';
          return;
        }
        
        // Fetch user data from API
        const userId = result.tldrUserId;
        console.log('User ID found:', userId);
        
        try {
          const url = `${USAGE_API_URL}?userId=${userId}`;
          console.log(`Fetching user data from ${url}`);
          
          const extensionId = chrome.runtime.id;
          console.log('Extension ID for API request:', extensionId);
          
          // Race against timeout with improved fetch options
          const fetchPromise = fetch(url, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'X-Extension-ID': extensionId
            },
            mode: 'cors',
            cache: 'no-store'
          });
          
          let response;
          
          try {
            console.log('Awaiting fetch response...');
            response = await Promise.race([fetchPromise, timeoutPromise]);
            console.log('Server response received:', response.status);
            console.log('Response headers:', [...response.headers.entries()]);
          } catch (timeoutError) {
            console.error('Request timed out:', timeoutError);
            throw new Error('Request timed out');
          }
          
          if (response && response.ok) {
            try {
              console.log('Response OK, parsing JSON...');
              const data = await response.json();
              console.log('Parsed response data:', data);
              
              // Ensure data has the expected structure
              if (!data || typeof data !== 'object') {
                console.error('Unexpected data format:', data);
                throw new Error('Invalid data format received from server');
              }
              
              showSubscriptionInfo(data);
              
              // Cache the data for offline access
              chrome.storage.local.set({ 'tldrSubscriptionData': data });
              console.log('Data cached for offline access');
              
              // Check if the user has a subscription from the server response
              if (data.subscription && data.subscription.plan) {
                updatePlanCards(data.subscription.plan);
              }
            } catch (jsonError) {
              console.error('Error parsing JSON response:', jsonError);
              throw new Error('Invalid response format');
            }
          } else {
            const errorText = await response.text().catch(() => 'No error text available');
            console.error(`Server returned error status ${response.status}: ${errorText}`);
            throw new Error(`Failed to load data: ${response ? response.status : 'Unknown error'}`);
          }
        } catch (fetchError) {
          console.error('API fetch error:', fetchError);
          
          // Determine the type of error
          let errorMessage = 'Could not connect to server. Showing cached data.';
          let errorDetails = '';
          
          if (fetchError.message.includes('timed out')) {
            errorMessage = 'Server request timed out. Showing cached data.';
            errorDetails = `Server (${USAGE_API_URL}) not responding within 10 seconds`;
          } else if (fetchError.message.includes('Failed to fetch')) {
            errorMessage = 'Server connection failed. Showing cached data.';
            errorDetails = `Could not connect to ${USAGE_API_URL}. Is the server running?`;
          } else if (fetchError.message.includes('NetworkError')) {
            errorMessage = 'Network error. Showing cached data.';
            errorDetails = 'Check your internet connection';
          } else if (fetchError.message.includes('status')) {
            const statusMatch = fetchError.message.match(/(\d{3})/);
            if (statusMatch) {
              const status = statusMatch[1];
              errorMessage = `Server returned error ${status}. Showing cached data.`;
              errorDetails = `The server responded with an error status ${status}`;
            }
          }
          
          // Show offline data from storage as fallback
          console.log('Falling back to cached data due to error');
          chrome.storage.local.get(['tldrSubscriptionData'], function(storedData) {
            if (storedData.tldrSubscriptionData) {
              console.log('Using cached subscription data:', storedData.tldrSubscriptionData);
              showSubscriptionInfo(storedData.tldrSubscriptionData);
              
              // Update plan cards if cached data contains subscription info
              if (storedData.tldrSubscriptionData.subscription && 
                  storedData.tldrSubscriptionData.subscription.plan) {
                updatePlanCards(storedData.tldrSubscriptionData.subscription.plan);
              }
            } else {
              // If no stored data, show default free tier data
              console.log('No cached data available, showing default free tier');
              showSubscriptionInfo({
                hasReachedLimit: false,
                usage: {
                  current: 0,
                  limit: 5
                }
              });
            }
          });
          
          showError(errorMessage, true, errorDetails);
        }
      } catch (chromeError) {
        console.error('Chrome storage error:', chromeError);
        // Show default view even if storage fails
        showSubscriptionInfo({
          hasReachedLimit: false,
          usage: {
            current: 0,
            limit: 5
          }
        });
        showError('Error accessing subscription data');
      }
    });
  } catch (error) {
    console.error('Error loading user data:', error);
    // Ensure the loading indicator is hidden
    document.getElementById('loading').style.display = 'none';
    document.getElementById('subscription-section').style.display = 'block';
    showError('Error loading your subscription information');
    
    // Show default free tier view
    showSubscriptionInfo({
      hasReachedLimit: false,
      usage: {
        current: 0,
        limit: 5
      }
    });
  }
  
  // Check subscription status
  checkSubscriptionStatus();
}

// Display subscription information
function showSubscriptionInfo(data) {
  // Ensure data exists and has the expected format
  if (!data) {
    console.error('No data provided to showSubscriptionInfo, using defaults');
    data = {
      hasReachedLimit: false,
      usage: {
        current: 0,
        limit: 5
      }
    };
  }
  
  console.log("Subscription data received:", JSON.stringify(data));
  
  // Hide loading
  document.getElementById('loading').style.display = 'none';
  document.getElementById('subscription-section').style.display = 'block';
  
  // Set usage information with fallbacks for missing data
  let currentUsage = 0;
  let limit = 5;
  
  if (data.usage) {
    if (typeof data.usage === 'object') {
      // Properly structured usage object
      currentUsage = typeof data.usage.current !== 'undefined' ? data.usage.current : 0;
      limit = typeof data.usage.limit !== 'undefined' ? data.usage.limit : 5;
      console.log(`Usage data properly structured: current=${currentUsage}, limit=${limit}`);
    } else {
      // Handle case where usage might be a primitive value
      console.error('Usage data is not properly structured:', data.usage);
      currentUsage = 0;
      limit = 5;
    }
  } else {
    console.log('No usage data found, using defaults');
  }
  
  // Save the data for offline access
  chrome.storage.local.set({ 'tldrSubscriptionData': data });
  
  document.getElementById('current-usage').textContent = `${currentUsage} summaries`;
  document.getElementById('usage-limit').textContent = `of ${limit} in free tier`;
  
  // Set progress bar
  const percentage = limit > 0 ? (currentUsage / limit) * 100 : 0;
  document.getElementById('usage-bar').style.width = `${Math.min(percentage, 100)}%`;
  
  // Set plan information
  if (data.subscription && data.subscription.plan) {
    // User has a paid subscription
    const planInfo = {
      'pro': {
        name: 'Pro Plan',
        price: '$3.99/mo',
        features: [
          '400 video summaries per month',
          'Enhanced AI model',
          'Priority support'
        ]
      },
      'premium': {
        name: 'Premium Plan',
        price: '$8.99/mo',
        features: [
          '1500 video summaries per month',
          'Enhanced AI model',
          'Custom summary length',
          'Download summaries',
          'YouTube Channel analysis'
        ]
      }
    };
    
    const planId = data.subscription.plan || 'pro';
    const plan = planInfo[planId] || planInfo.pro;
    
    document.getElementById('current-plan-name').textContent = plan.name;
    document.getElementById('current-plan-price').textContent = plan.price;
    
    // Set expiry date with error handling
    if (data.subscription.expiresAt || data.subscription.expiry) {
      try {
        const expiryDate = new Date(data.subscription.expiresAt || data.subscription.expiry);
        if (!isNaN(expiryDate.getTime())) {
          document.getElementById('plan-expiry').textContent = `Renews on ${expiryDate.toLocaleDateString()}`;
        } else {
          document.getElementById('plan-expiry').textContent = 'Active subscription';
        }
      } catch (e) {
        console.error("Error parsing expiry date:", e);
        document.getElementById('plan-expiry').textContent = 'Active subscription';
      }
    } else {
      document.getElementById('plan-expiry').textContent = 'Active subscription';
    }
    
    // Set features
    const featuresEl = document.getElementById('current-plan-features');
    featuresEl.innerHTML = '';
    plan.features.forEach(feature => {
      featuresEl.innerHTML += `
        <div class="feature-item">
          <span class="feature-icon">✓</span>
          <span>${feature}</span>
        </div>
      `;
    });
    
    // Change button text to "Change Plan"
    document.getElementById('upgrade-btn').textContent = 'Change Plan';
    
    // Update plan cards
    document.querySelectorAll('.plan-card').forEach(card => {
      const cardPlan = card.getAttribute('data-plan');
      if (cardPlan === planId) {
        card.classList.add('current');
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.textContent = 'Current Plan';
          btnEl.disabled = true;
        }
      } else if (cardPlan === 'free') {
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.textContent = 'Downgrade';
        }
      } else {
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.textContent = 'Change Plan';
          btnEl.disabled = false;
        }
      }
    });
  } else {
    // User on free tier
    document.getElementById('current-plan-name').textContent = 'Free Tier';
    document.getElementById('current-plan-price').textContent = '$0/mo';
    document.getElementById('plan-expiry').textContent = 'No active subscription';
    
    const featuresEl = document.getElementById('current-plan-features');
    featuresEl.innerHTML = `
      <div class="feature-item">
        <span class="feature-icon">✓</span>
        <span>Basic AI summaries</span>
      </div>
      <div class="feature-item">
        <span class="feature-icon">✓</span>
        <span>Limited to ${limit} summaries</span>
      </div>
    `;
    
    // Set button text to "Upgrade"
    document.getElementById('upgrade-btn').textContent = 'Upgrade Plan';
    
    // Highlight the free plan card
    document.querySelectorAll('.plan-card').forEach(card => {
      const cardPlan = card.getAttribute('data-plan');
      if (cardPlan === 'free') {
        card.classList.add('current');
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.disabled = true;
        }
      } else {
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.disabled = false;
        }
      }
    });
  }
}

// Show an error message
function showError(message, isConnectionError = false, details = '') {
  // Create an error box
  const errorBox = document.createElement('div');
  errorBox.className = 'error-box';
  
  if (isConnectionError) {
    errorBox.innerHTML = `
      <div><strong>${message}</strong></div>
      ${details ? `<div style="margin: 5px 0; font-size: 12px;">${details}</div>` : ''}
      <div style="display: flex; gap: 8px; margin-top: 10px;">
        <button id="retry-connection" class="button" style="margin: 0; padding: 5px 10px; font-size: 12px; flex: 1;">
          Retry Connection
        </button>
        <button id="offline-mode" class="button" style="margin: 0; padding: 5px 10px; font-size: 12px; flex: 1; background: #777;">
          Use Offline Mode
        </button>
      </div>
      <div style="margin-top: 5px;">
        <button id="reset-all-data" class="button" style="margin: 0; padding: 5px 10px; font-size: 12px; background: #ff6b6b;">
          Reset All Data
        </button>
      </div>
    `;
  } else {
    errorBox.textContent = message;
  }
  
  // Insert at the top of the subscription section
  const section = document.getElementById('subscription-section');
  
  // Remove any existing error boxes
  const existingErrorBox = section.querySelector('.error-box');
  if (existingErrorBox) {
    existingErrorBox.remove();
  }
  
  section.insertBefore(errorBox, section.firstChild);
  
  // Add event listeners for buttons
  if (isConnectionError) {
    // Retry button handler
    const retryButton = errorBox.querySelector('#retry-connection');
    if (retryButton) {
      retryButton.addEventListener('click', () => {
        errorBox.innerHTML = '<div style="text-align: center;">Reconnecting to server...</div>';
        errorBox.style.background = '#e8f4ff';
        errorBox.style.borderColor = '#4a6cf7';
        // Add a small delay before retry to make it clear something is happening
        setTimeout(() => {
          loadUserData();
        }, 500);
      });
    }
    
    // Offline mode button handler
    const offlineButton = errorBox.querySelector('#offline-mode');
    if (offlineButton) {
      offlineButton.addEventListener('click', () => {
        errorBox.remove();
        showError('Using offline mode with cached data. Some features may be limited.', false);
        // This will auto-hide after the regular timeout
      });
    }
    
    // Reset all data handler
    const resetButton = errorBox.querySelector('#reset-all-data');
    if (resetButton) {
      resetButton.addEventListener('click', () => {
        if (confirm('Are you sure you want to reset all extension data? This will clear your user ID and cached information.')) {
          resetAllData();
        }
      });
    }
  }
  
  // Auto-hide the error after a timeout (longer for connection errors)
  setTimeout(() => {
    if (errorBox.parentNode && !isConnectionError) {
      errorBox.style.opacity = '0';
      errorBox.style.transition = 'opacity 0.5s';
      setTimeout(() => {
        if (errorBox.parentNode) {
          errorBox.remove();
        }
      }, 500);
    }
  }, isConnectionError ? 30000 : 5000); // Keep connection errors visible for 30 seconds
}

// Switch between tabs
function switchTab(tabId) {
  console.log(`Switching to tab: ${tabId}`);
  
  // Update tabs
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    if (tab.getAttribute('data-tab') === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  // Find all content sections and hide them
  const contentSections = document.querySelectorAll('.content-section');
  console.log(`Found ${contentSections.length} content sections`);
  contentSections.forEach(section => {
    console.log(`Setting display:none for section: ${section.id}`);
    section.style.display = 'none';
    section.classList.remove('active');
  });
  
  // Also hide the payment section if it exists
  const paymentSection = document.getElementById('payment-section');
  if (paymentSection) {
    paymentSection.style.display = 'none';
  }
  
  // Show active section based on tabId
  const targetSection = document.getElementById(`${tabId}-section`);
  if (targetSection) {
    console.log(`Setting section ${tabId}-section to display:block`);
    targetSection.classList.add('active');
    targetSection.style.display = 'block';
  } else {
    console.error(`Could not find section with ID: ${tabId}-section`);
  }
}

// Handle plan selection and redirect to Stripe payment link
function selectPlan(plan) {
  console.log(`Selected plan: ${plan}`);
  openStripePayment(plan);
}

// Open the appropriate Stripe payment link
function openStripePayment(plan) {
  // Use the Stripe payment link for the selected plan
  let paymentUrl = STRIPE_PAYMENT_LINKS[plan] || STRIPE_PAYMENT_LINKS.pro;
  
  // Get the extension ID for later use
  const extensionId = chrome.runtime.id;
  console.log(`Extension ID for redirect handling: ${extensionId}`);
  
  // Get current user ID
  chrome.storage.local.get(['tldrUserId'], function(result) {
    if (result.tldrUserId) {
      const userId = result.tldrUserId;
      
      // Store the extension ID and plan in local storage for validation when returning from Stripe
      chrome.storage.local.set({
        'pendingPayment': {
          plan: plan,
          timestamp: Date.now()
        }
      }, function() {
        console.log('Stored pending payment information');
      });
      
      // Use a localhost redirect if in development, or a public URL in production
      // For localhost testing: http://localhost:3000/payment-success
      // For production: https://your-domain.com/payment-success
      const successUrl = encodeURIComponent(`http://localhost:3000/payment-success?plan=${plan}&extension_id=${extensionId}`);
      
      // Append parameters to the Stripe URL
      if (paymentUrl.includes('?')) {
        paymentUrl += `&client_reference_id=${userId}&success_url=${successUrl}`;
      } else {
        paymentUrl += `?client_reference_id=${userId}&success_url=${successUrl}`;
      }
      
      console.log(`Opening Stripe payment page: ${paymentUrl}`);
      
      // Check if this is a Chrome extension context
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        // We're in a Chrome extension, use the Chrome API
        chrome.tabs.create({ url: paymentUrl }, (tab) => {
          console.log('Opened Stripe payment page:', tab.id);
        });
      } else {
        // We're in a regular web context, use window.open
        window.open(paymentUrl, '_blank');
        console.log('Opened Stripe payment page with window.open');
      }
    } else {
      console.error('No user ID found when trying to open payment page');
      // Generate a new user ID
      const userId = 'tldr_' + Math.random().toString(36).substring(2, 15) + 
                   Math.random().toString(36).substring(2, 15);
      chrome.storage.local.set({ tldrUserId: userId }, function() {
        // Retry opening the payment page
        openStripePayment(plan);
      });
    }
  });
}

// Check if CORS is properly configured
async function checkCorsConfiguration() {
  console.log('Testing CORS configuration...');
  try {
    // Use an OPTIONS request to check CORS headers
    const response = await fetch(USAGE_API_URL, {
      method: 'OPTIONS',
      headers: {
        'Origin': chrome.runtime.getURL(''),
        'Access-Control-Request-Method': 'GET'
      }
    });
    
    console.log('CORS preflight response:', response);
    
    // Check if the response contains the necessary CORS headers
    const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
    const allowMethods = response.headers.get('Access-Control-Allow-Methods');
    const allowHeaders = response.headers.get('Access-Control-Allow-Headers');
    
    console.log('CORS headers:', {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': allowMethods,
      'Access-Control-Allow-Headers': allowHeaders
    });
    
    // Check if our extension's origin is allowed or if '*' is allowed
    const hasValidOrigin = allowOrigin === '*' || 
                          allowOrigin === chrome.runtime.getURL('') ||
                          allowOrigin?.includes(window.location.origin);
                          
    // Check if GET method is allowed
    const hasGetMethod = allowMethods?.includes('GET') || allowMethods === '*';
    
    // Check if our request headers are allowed
    const hasValidHeaders = allowHeaders?.includes('Content-Type') || 
                          allowHeaders?.includes('Authorization') ||
                          allowHeaders === '*';
    
    const isValid = hasValidOrigin && hasGetMethod && hasValidHeaders;
    console.log('CORS configuration valid:', isValid);
    
    return isValid;
  } catch (error) {
    console.error('Error checking CORS configuration:', error);
    return false;
  }
}

// Retry button to manually refresh data
function addRetryButton() {
  // Check if retry button already exists
  if (document.getElementById('manual-retry')) {
    return;
  }
  
  const usageSection = document.querySelector('.usage-section');
  if (!usageSection) return;
  
  const retryButton = document.createElement('button');
  retryButton.id = 'manual-retry';
  retryButton.className = 'retry-button';
  retryButton.innerHTML = '🔄 Retry';
  retryButton.style.cssText = `
    margin-top: 10px;
    padding: 5px 10px;
    background-color: #f0f0f0;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  `;
  
  retryButton.addEventListener('click', function() {
    console.log('Manual retry button clicked');
    this.disabled = true;
    this.innerHTML = '⏳ Loading...';
    
    // Clear any existing error messages
    const existingError = document.querySelector('.error-box');
    if (existingError) existingError.remove();
    
    // Force reload user data
    forceRefreshData();
    
    // Re-enable after delay
    setTimeout(() => {
      this.disabled = false;
      this.innerHTML = '🔄 Retry';
    }, 3000);
  });
  
  usageSection.appendChild(retryButton);
}

// Force refresh the usage data
async function forceRefreshData() {
  console.log('Forcing refresh of usage data');
  
  // Clear cached data to force a fresh fetch
  chrome.storage.local.remove(['tldrSubscriptionData'], function() {
    console.log('Cleared cached subscription data');
    
    // Check server status and reload
    checkServerStatus().then(isOnline => {
      if (isOnline) {
        console.log('Server is online, testing CORS and loading fresh data');
        testServerConnection();
      } else {
        console.log('Server is offline, showing error');
        loadCachedUserData();
        showError('Server is unreachable. Using cached data.', true, 
                 `Could not connect to ${API_BASE_URL}. Please check if the server is running.`);
      }
    });
  });
}

// Test server connectivity and CORS 
async function testServerConnection() {
  try {
    console.log('Testing server connectivity and CORS...');
    const corsTestUrl = `${API_BASE_URL}/cors-test`;
    
    // Get the extension ID
    const extensionId = chrome.runtime.id;
    console.log('Extension ID:', extensionId);
    
    // First, try a standard fetch to the test endpoint
    console.log('Attempting to fetch:', corsTestUrl);
    
    let response = await fetch(corsTestUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Extension-ID': extensionId  // Add extension ID as custom header
      },
      mode: 'cors',
      cache: 'no-store'  // Bypass cache completely
    });
    
    console.log('CORS test response status:', response.status);
    
    if (response.ok) {
      try {
        const data = await response.json();
        console.log('CORS test successful:', data);
        
        // Test passed, load user data
        console.log('CORS test passed, loading user data...');
        loadUserData();
        return true;
      } catch (jsonError) {
        console.error('Error parsing CORS test response:', jsonError);
        showError('Server returned invalid JSON', true, 'The server response could not be parsed.');
        loadCachedUserData();
        return false;
      }
    } else {
      console.error('CORS test failed with status:', response.status);
      let errorText;
      try {
        errorText = await response.text();
      } catch (e) {
        errorText = 'No error details available';
      }
      console.error('Error details:', errorText);
      
      // Show CORS error with more detailed information
      showError('Server CORS error detected', true, 
                `Status: ${response.status}. The server responded but rejected the request. This is likely a CORS configuration issue.`);
      
      // Fall back to cached data
      loadCachedUserData();
      return false;
    }
  } catch (error) {
    console.error('CORS test error:', error);
    
    // Check if this is a CORS error
    if (error.message.includes('Failed to fetch') || 
        error.message.includes('NetworkError') || 
        error.name === 'TypeError' ||
        error.name === 'AbortError') {
      showError('CORS configuration error detected', true, 
                `Error: ${error.message}. The browser blocked the request due to CORS policy. Please check server configuration.`);
      
      // Show a more helpful message about how to fix CORS
      showCorsHelpMessage();
    } else {
      showError('Server connection test failed', true, error.message);
    }
    
    // Fall back to cached data
    loadCachedUserData();
    return false;
  }
}

// Show a helpful message about fixing CORS issues
function showCorsHelpMessage() {
  const section = document.getElementById('subscription-section');
  if (!section) return;
  
  const helpBox = document.createElement('div');
  helpBox.className = 'help-box';
  helpBox.innerHTML = `
    <h3>CORS Troubleshooting Steps</h3>
    <p>This issue happens because Chrome extensions have special security rules for making network requests.</p>
    <ol>
      <li><strong>Make sure your server is running</strong> on port 3000</li>
      <li><strong>Restart your server</strong> after making any configuration changes</li>
      <li><strong>Try accessing</strong> <a href="http://localhost:3000/cors-test" target="_blank">http://localhost:3000/cors-test</a> directly in your browser to verify the server is responding</li>
    </ol>
    <p><strong>Add these lines to your server's app.py:</strong></p>
    <pre style="background: #f5f5f5; padding: 8px; overflow: auto; font-size: 12px;">
@app.after_request
def add_cors_headers(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
    return response
    </pre>
    <p><strong>Then restart the server with:</strong></p>
    <pre style="background: #f5f5f5; padding: 8px; overflow: auto; font-size: 12px;">python -m flask run --host=0.0.0.0 --port=3000</pre>
  `;
  
  helpBox.style.cssText = `
    background-color: #e8f4ff;
    border: 1px solid #4a6cf7;
    border-radius: 4px;
    padding: 15px;
    margin: 15px 0;
    font-size: 13px;
  `;
  
  // Remove existing help box if any
  const existingHelpBox = section.querySelector('.help-box');
  if (existingHelpBox) {
    existingHelpBox.remove();
  }
  
  // Insert after error box
  const errorBox = section.querySelector('.error-box');
  if (errorBox) {
    errorBox.after(helpBox);
  } else {
    section.insertBefore(helpBox, section.firstChild);
  }
}

// Force refresh all data and reset caches
function resetAllData() {
  console.log('Performing a complete data reset...');
  
  // Clear all cached data
  chrome.storage.local.remove(['tldrSubscriptionData', 'tldrUserId'], function() {
    console.log('Cleared all cached data');
    
    // Hide loading indicator
    document.getElementById('loading').style.display = 'none';
    
    // Show subscription section with default data
    document.getElementById('subscription-section').style.display = 'block';
    
    // Show a message about the reset
    showError('All data has been reset. Reloading...');
    
    // Reload the page after a brief delay
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  });
}

// Function to check and display subscription status
function checkSubscriptionStatus() {
  chrome.storage.local.get(['subscription'], function(result) {
    if (result.subscription) {
      const subscription = result.subscription;
      
      // Check if subscription is active
      const now = new Date();
      const expiryDate = new Date(subscription.expiryDate);
      
      if (now < expiryDate) {
        // Subscription is active
        const daysRemaining = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
        
        // Hide the redundant subscription info header since we're showing the info in the main section
        const subscriptionInfoDiv = document.getElementById('subscription-info');
        if (subscriptionInfoDiv) {
          subscriptionInfoDiv.style.display = 'none';
        }
        
        // Update the main subscription section with plan details
        const planInfo = {
          'pro': {
            name: 'Pro Plan',
            price: '$3.99/mo',
            features: [
              '400 video summaries per month',
              'Enhanced AI model',
              'Priority support'
            ]
          },
          'premium': {
            name: 'Premium Plan',
            price: '$8.99/mo',
            features: [
              '1500 video summaries per month',
              'Enhanced AI model',
              'Custom summary length',
              'Download summaries',
              'YouTube Channel analysis'
            ]
          }
        };
        
        const plan = planInfo[subscription.plan] || planInfo.pro;
        
        // Update the main subscription info
        document.getElementById('current-plan-name').textContent = plan.name;
        document.getElementById('current-plan-price').textContent = plan.price;
        document.getElementById('plan-expiry').textContent = `Renews on ${expiryDate.toLocaleDateString()}`;
        
        // Update features
        const featuresEl = document.getElementById('current-plan-features');
        if (featuresEl) {
          featuresEl.innerHTML = '';
          plan.features.forEach(feature => {
            featuresEl.innerHTML += `
              <div class="feature-item">
                <span class="feature-icon">✓</span>
                <span>${feature}</span>
              </div>
            `;
          });
        }
        
        // Show "Manage Subscription" button instead of "Upgrade"
        const upgradeBtn = document.getElementById('upgrade-btn');
        if (upgradeBtn) {
          upgradeBtn.textContent = 'Manage Subscription';
          upgradeBtn.classList.add('manage-subscription');
        }
        
        // Get the limit based on the plan
        const videoLimit = subscription.plan === 'premium' ? 1500 : 400;
        
        // Update usage display with correct limit instead of "unlimited"
        document.getElementById('current-usage').textContent = '0 summaries';
        document.getElementById('usage-limit').textContent = `of ${videoLimit}`;
        document.getElementById('usage-bar').style.width = '0%';
        document.getElementById('usage-bar').style.background = '#4a6cf7';
        
        // Update usage display in any other areas
        updateUsageDisplay(true, videoLimit);
      } else {
        // Subscription expired
        console.log('Subscription expired');
        chrome.storage.local.set({ subscription: null });
        
        // Update the UI to show expired subscription
        const subscriptionInfoDiv = document.getElementById('subscription-info');
        if (subscriptionInfoDiv) {
          subscriptionInfoDiv.innerHTML = `
            <div class="subscription-expired">
              <h3>Subscription Expired</h3>
              <p>Your subscription has expired. Please renew to continue enjoying premium features.</p>
            </div>
          `;
          subscriptionInfoDiv.style.display = 'block';
        }
      }
    }
  });
}

// Call this function after loading user data - update to support limits
function updateUsageDisplay(isPremium, videoLimit) {
  // Update the usage display based on subscription status
  const usageElement = document.getElementById('usage-display');
  if (usageElement && isPremium) {
    usageElement.innerHTML = `
      <div class="premium-badge">
        <span class="checkmark">✓</span>
        <span>Premium</span>
      </div>
      <p>${videoLimit} video summarizations with your subscription!</p>
    `;
  }
}

// Function to update plan cards based on active subscription
function updatePlanCards(activePlan) {
  document.querySelectorAll('.plan-card').forEach(card => {
    const cardPlan = card.getAttribute('data-plan');
    const btnEl = card.querySelector('.subscribe-btn');
    
    // Reset classes first
    card.classList.remove('current');
    if (btnEl) btnEl.disabled = false;
    
    if (cardPlan === activePlan) {
      // This is the active plan
      card.classList.add('current');
      if (btnEl) {
        btnEl.textContent = 'Current Plan';
        btnEl.disabled = true;
      }
    } else if (cardPlan === 'free') {
      // Free plan when user has paid subscription
      if (btnEl) {
        btnEl.textContent = 'Downgrade';
      }
    } else {
      // Other paid plans
      if (btnEl) {
        btnEl.textContent = 'Change Plan';
      }
    }
  });
} 