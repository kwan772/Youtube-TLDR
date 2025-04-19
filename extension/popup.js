// Configuration
const API_URL = 'http://localhost:3000/summary';
const USAGE_API_URL = 'http://localhost:3000/usage';
const API_BASE_URL = 'http://localhost:3000';

// Stripe payment links
const STRIPE_PAYMENT_LINKS = {
  pro: 'https://buy.stripe.com/test_dR6g03gNngRh9a0004',
  premium:  'https://buy.stripe.com/test_8wM29dfJj44v71S9AD'
};

// Stripe customer portal link for managing subscriptions
const STRIPE_CUSTOMER_PORTAL = 'https://billing.stripe.com/p/login/test_eVa4iQej91HvaGYbII';

// Global state to track active tab
window.activeTab = 'subscription'; // Default tab
// Store whether user has active subscription
window.hasActiveSubscription = false;

// Set theme based on user preference
document.addEventListener('DOMContentLoaded', function() {
  // Check if dark mode is enabled in YouTube
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.add('light-theme');
  }
  
  console.log('Popup loaded, starting initialization...');
  
  // Initialize the UI
  initUI();
  
  // Add retry button
  addRetryButton();
  
  // Check storage for displayTab preference first
  chrome.storage.local.get(['displayTab'], function(result) {
    if (result.displayTab) {
      console.log('Display tab preference found in storage:', result.displayTab);
      // Switch to the specified tab
      switchTab(result.displayTab);
      
      // Clear the stored display tab preference
      chrome.storage.local.remove('displayTab');
      
      // Continue with other checks
      checkForPlanSelection();
    } else {
      // No display tab preference, continue with other checks
      checkForPlanSelection();
    }
  });
  
  // Add more detailed server connection checking
  console.log('Checking server connection status...');
  checkServerStatus().then(isOnline => {
    console.log(`Server connection check result: ${isOnline ? 'ONLINE' : 'OFFLINE'}`);
    
    if (isOnline) {
      // Server is reachable, load user data
      console.log('Server is reachable, proceeding to load user data');
      loadUserData();
    } else {
      // Server is unreachable
      console.error('Server is unreachable');
      document.getElementById('loading').style.display = 'none';
      showError('Could not connect to server. Please check your internet connection and try again.', true, 
                `Server at ${API_BASE_URL} is unreachable. Check if the server is running.`);
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
      console.log('Upgrade button clicked');
      
      if (window.hasActiveSubscription) {
        // If user has subscription, open the customer portal
        console.log('User has active subscription, opening customer portal');
        openStripeCustomerPortal();
        return;
      }
      
      console.log('Switching to plans tab');
      // NUCLEAR OPTION: Completely remove subscription section from DOM
      const subscriptionSection = document.getElementById('subscription-section');
      if (subscriptionSection && subscriptionSection.parentNode) {
        // Remember where it was in the DOM
        const parentNode = subscriptionSection.parentNode;
        const nextSibling = subscriptionSection.nextSibling;
        
        // Store reference in a variable to reattach later if needed
        window._removedSubscriptionSection = subscriptionSection;
        window._subscriptionSectionParent = parentNode;
        window._subscriptionSectionNextSibling = nextSibling;
        
        // Completely remove it from the DOM
        subscriptionSection.remove();
        console.log('Subscription section completely removed from DOM');
      }
      
      // Then show plans tab
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
  
  // Add event listeners for ALL subscribe buttons, including the "Downgrade" button
  document.querySelectorAll('.subscribe-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const planCard = this.closest('.plan-card');
      if (planCard) {
        const planId = planCard.getAttribute('data-plan');
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

// Improve server status check with better timeout handling and retry logic
async function checkServerStatus() {
  console.log(`Checking if server at ${API_BASE_URL} is reachable...`);
  
  // Try up to 3 times to connect to the server
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Connection attempt ${attempt} of 3...`);
      
      // Use a HEAD request with a shorter timeout for each retry
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout
      
      // Try the usage endpoint with options request first (most reliable)
      const response = await fetch(`${USAGE_API_URL}?email=connection_test`, {
        method: 'HEAD',
        mode: 'cors',
        cache: 'no-cache',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json'
        }
      });
      
      clearTimeout(timeoutId);
      
      if (response.ok || response.status === 204) {
        console.log(`Server is reachable! Status: ${response.status}`);
        return true;
      } else {
        console.warn(`Server responded with status: ${response.status}`);
        // If we got any response at all, the server is probably reachable
        // but might have returned an error, try to continue
        return response.status < 500;
      }
    } catch (error) {
      console.warn(`Connection attempt ${attempt} failed:`, error.name === 'AbortError' ? 'timeout' : error);
      
      if (attempt === 3) {
        console.error('All server connection attempts failed');
        return false;
      }
      
      // Wait a bit longer between each retry
      await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  
  return false;
}

// User email retrieval with NO storage
async function getUserEmail() {
  try {
    console.log('getUserEmail: Getting user identity with no storage');
    
    // First attempt: Try to use getProfileUserInfo (non-interactive)
    console.log('getUserEmail: Trying getProfileUserInfo method...');
    try {
      const userInfo = await new Promise((resolve, reject) => {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (userInfo) => {
          if (chrome.runtime.lastError) {
            console.error('getUserEmail: Error getting profile info:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(userInfo);
          }
        });
      });
      
      if (userInfo && userInfo.email) {
        console.log(`getUserEmail: Successfully got email: ${userInfo.email}`);
        return userInfo.email;
      }
    } catch (error) {
      console.log('getUserEmail: Non-interactive method failed, will try interactive mode');
    }
    
    // Second attempt: Try to get token interactively
    console.log('getUserEmail: Trying interactive mode...');
    try {
      const token = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: true }, (token) => {
          if (chrome.runtime.lastError) {
            console.error('getUserEmail: Error getting auth token:', chrome.runtime.lastError);
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(token);
          }
        });
      });
      
      if (token) {
        // Get user info using the token
        const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
          headers: { Authorization: `Bearer ${token}` }
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.email) {
            console.log(`getUserEmail: Successfully got email via interactive mode: ${data.email}`);
            return data.email;
          }
        }
      }
    } catch (error) {
      console.log('getUserEmail: Interactive mode failed:', error);
    }
    
    // If we get here, both methods have failed
    console.error('getUserEmail: CRITICAL - Could not retrieve user email through any method');
    throw new Error('Could not retrieve user email. Please ensure you are logged into Chrome and have granted the necessary permissions.');
    
  } catch (error) {
    console.error('getUserEmail: Failed to get user identity:', error);
    throw error;
  }
}

// Improved loadUserData function with NO caching
async function loadUserData() {
  console.log('loadUserData: Starting to load user data from backend only');
  
  // Always show loading indicator when starting data load
  document.getElementById('loading').style.display = 'flex';
  if (window.activeTab === 'subscription') {
    document.getElementById('subscription-section').style.display = 'none';
  }
  
  try {
    // Get user identifier
    const email = await getUserEmail();
    console.log(`loadUserData: Using identifier: ${email}`);
    
    // Fetch fresh data from server - never use cache
    const data = await fetchServerUsageData(email);
    
    // Hide loading and show subscription section
    document.getElementById('loading').style.display = 'none';
    if (window.activeTab === 'subscription') {
      document.getElementById('subscription-section').style.display = 'block';
    }
    
    // Update UI with the data
    showSubscriptionInfo(data);
    
  } catch (error) {
    console.error('loadUserData: Error:', error);
    document.getElementById('loading').style.display = 'none';
    
    // Show error message
    showError(`Failed to load user data: ${error.message}. Please try again.`, true);
  }
}

// Fetch server data with NO caching
async function fetchServerUsageData(email) {
  if (!email) {
    console.error('fetchServerUsageData: No email provided');
    throw new Error('Email is required');
  }
  
  console.log(`fetchServerUsageData: Fetching fresh data for ${email}`);
  
  // Use a timeout and AbortController for better timeout handling
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout
  
  try {
    // Make the API call
    console.log(`fetchServerUsageData: Sending request to ${USAGE_API_URL}?email=${encodeURIComponent(email)}`);
    
    const response = await fetch(`${USAGE_API_URL}?email=${encodeURIComponent(email)}`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store', // Never use HTTP cache
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    console.log(`fetchServerUsageData: Received response with status ${response.status}`);
    
    if (!response.ok) {
      console.error(`fetchServerUsageData: Server returned error status ${response.status}`);
      let errorText = await response.text();
      console.error('fetchServerUsageData: Error response body:', errorText);
      throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }
    
    // Parse the JSON data
    const data = await response.json();
    console.log('fetchServerUsageData: Successfully parsed response data:', data);
    
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('fetchServerUsageData: Error fetching server data:', error);
    throw error;
  }
}

// Make sure showSubscriptionInfo handles all cases properly
function showSubscriptionInfo(data) {
  console.log('showSubscriptionInfo: Updating UI with data:', data);
  
  // Ensure data exists and has the expected format
  if (!data) {
    console.error('showSubscriptionInfo: No data provided, using defaults');
    data = {
      hasReachedLimit: false,
      usage: {
        current: 0,
        limit: 5
      }
    };
  }
  
  // Set usage information with fallbacks for missing data
  let currentUsage = 0;
  let limit = 5;
  
  if (data.usage) {
    if (typeof data.usage === 'object') {
      print(data.usage)
      // Debug output for troubleshooting
      console.log('Raw usage data received:', JSON.stringify(data.usage));
      
      // Properly structured usage object with strict type checking
      currentUsage = typeof data.usage.current === 'number' ? data.usage.current : 0;
      limit = typeof data.usage.limit === 'number' ? data.usage.limit : 5;
      console.log(`showSubscriptionInfo: Parsed usage data: current=${currentUsage}, limit=${limit}`);
    } else {
      // Handle case where usage might be a primitive value
      console.error('showSubscriptionInfo: Usage data is not properly structured:', data.usage);
      currentUsage = 0;
      limit = 5;
    }
  } else {
    console.log('showSubscriptionInfo: No usage data found, using defaults');
  }
  
  console.log('showSubscriptionInfo: Updating usage display');
  document.getElementById('current-usage').textContent = `${currentUsage} summaries`;
  document.getElementById('usage-limit').textContent = `of ${limit} in free tier`;
  
  // Set progress bar
  const percentage = limit > 0 ? (currentUsage / limit) * 100 : 0;
  document.getElementById('usage-bar').style.width = `${Math.min(percentage, 100)}%`;
  
  // Set plan information
  console.log('showSubscriptionInfo: Updating plan information');
  if (data.subscription && data.subscription.plan) {
    console.log(`showSubscriptionInfo: Found subscription plan: ${data.subscription.plan}`);
    // User has a paid subscription
    window.hasActiveSubscription = true; // Mark that user has active subscription
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
        console.error("showSubscriptionInfo: Error parsing expiry date:", e);
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
    
    // Change button text to "Manage Subscription"
    document.getElementById('upgrade-btn').textContent = 'Manage Subscription';
    
    console.log('showSubscriptionInfo: Updating plan cards');
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
          btnEl.disabled = false;
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
    console.log('showSubscriptionInfo: No subscription found, showing free tier');
    // User on free tier
    window.hasActiveSubscription = false; // Mark that user does not have active subscription
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
        <span>5 free summaries</span>
      </div>
    `;
    
    // Set button text to "Upgrade"
    document.getElementById('upgrade-btn').textContent = 'Upgrade';
    
    // Update plan cards
    document.querySelectorAll('.plan-card').forEach(card => {
      const cardPlan = card.getAttribute('data-plan');
      if (cardPlan === 'free') {
        card.classList.add('current');
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.textContent = 'Current Plan';
          btnEl.disabled = true;
        }
      } else {
        card.classList.remove('current');
        const btnEl = card.querySelector('.subscribe-btn');
        if (btnEl) {
          btnEl.textContent = 'Subscribe';
          btnEl.disabled = false;
        }
      }
    });
  }
  
  console.log('showSubscriptionInfo: UI update complete');
}

// Modified show error to not offer "Use Offline Mode" option since we don't use cache
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
  
  // Add event listeners for retry button
  if (isConnectionError) {
    // Retry button handler
    const retryButton = errorBox.querySelector('#retry-connection');
    if (retryButton) {
      retryButton.addEventListener('click', async () => {
        console.log('Retry button clicked, attempting to reconnect...');
        
        // Clear error messages
        const errorBox = document.querySelector('.error-box');
        if (errorBox) {
          errorBox.innerHTML = '';
          errorBox.style.display = 'none';
        }
        
        // Show loading indicator
        if (window.activeTab === 'subscription') {
          document.getElementById('loading').style.display = 'flex';
          document.getElementById('subscription-section').style.display = 'none';
        }
        
        // Try to connect to server again
        const isOnline = await checkServerStatus();
        if (isOnline) {
          // Server is back online, reload data
          await loadUserData();
          showMessage('Connection restored! Using live data.');
        } else {
          // Still offline
          showError('Server is still unreachable. Please try again later.', true,
                    `Could not connect to ${API_BASE_URL}. Please check if the server is running.`);
        }
      });
    }
  }
}

// Completely revamped function to switch tabs with proper component visibility
function switchTab(tabId) {
  console.log(`Switching to tab: ${tabId}`);
  window.activeTab = tabId;
  
  // RESTORE subscription section if it was removed and we're switching to it
  if (tabId === 'subscription' && !document.getElementById('subscription-section') && window._removedSubscriptionSection) {
    console.log('Restoring previously removed subscription section');
    if (window._subscriptionSectionParent) {
      if (window._subscriptionSectionNextSibling) {
        window._subscriptionSectionParent.insertBefore(window._removedSubscriptionSection, window._subscriptionSectionNextSibling);
      } else {
        window._subscriptionSectionParent.appendChild(window._removedSubscriptionSection);
      }
      console.log('Subscription section restored to DOM');
    }
  }
  
  // 1. Update tab button highlighting
  document.querySelectorAll('.tab').forEach(tab => {
    if (tab.getAttribute('data-tab') === tabId) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });
  
  // 2. Hide ALL content sections first - ensure all section types are included
  document.querySelectorAll('[id$="-section"]').forEach(section => {
    section.style.display = 'none';
    console.log(`Hidden section: ${section.id}`);
  });
  
  // 3. IMPORTANT: If switching to plans tab, specifically hide ALL subscription info elements 
  if (tabId === 'plans') {
    // Direct targeting of all elements containing subscription info
    const elementsToHide = [
      document.getElementById('current-plan-status'),
      document.getElementById('usage-container'),
      document.getElementById('current-plan-features'),
      document.getElementById('current-usage'),
      document.getElementById('usage-limit'),
      document.getElementById('usage-bar'),
      document.getElementById('current-plan-name'),
      document.getElementById('current-plan-price'),
      document.getElementById('plan-expiry'),
      document.querySelector('.current-plan'),  
      document.querySelector('.plan-info')
    ];
    
    // Hide each element if it exists
    elementsToHide.forEach(element => {
      if (element) {
        element.style.display = 'none';
        console.log(`Explicitly hidden element:`, element.id || element.className);
      }
    });
    
    // Also try to find and hide any subscription-related container
    const containers = document.querySelectorAll('.subscription-container, .status-container, .usage-section');
    containers.forEach(container => {
      container.style.display = 'none';
      console.log(`Hidden container: ${container.className}`);
    });
    
    // Hide any feature items with check marks
    const featureItems = document.querySelectorAll('.feature-item');
    featureItems.forEach(item => {
      item.style.display = 'none';
      console.log('Hidden feature item');
    });
  }
  
  // 4. Show ONLY the selected section
  const selectedSection = document.getElementById(`${tabId}-section`);
  if (selectedSection) {
    selectedSection.style.display = 'block';
    console.log(`Showing section: ${tabId}-section`);
    
    // Make sure elements specific to this tab are visible
    if (tabId === 'plans') {
      // Ensure plan cards are visible
      const planCards = document.querySelectorAll('.plan-card');
      planCards.forEach(card => {
        card.style.display = 'block';
        console.log(`Made plan card visible: ${card.getAttribute('data-plan')}`);
      });
    } 
    else if (tabId === 'subscription') {
      // Make subscription elements visible again - EXPLICITLY LIST ALL ELEMENTS
      const subscriptionElements = [
        document.getElementById('current-plan-status'),
        document.getElementById('usage-container'),
        document.getElementById('current-plan-features'),
        document.getElementById('current-usage'),
        document.getElementById('usage-limit'),
        document.getElementById('usage-bar'),
        document.getElementById('current-plan-name'),
        document.getElementById('plan-expiry'),
        document.querySelector('.current-plan'),  
        document.querySelector('.plan-info'),
        document.querySelector('.usage-section'),
        document.querySelector('.subscription-container'),
        document.querySelector('.status-container')
      ];
      
      // Show each element if it exists
      subscriptionElements.forEach(element => {
        if (element) {
          element.style.display = 'block';
          console.log(`Made visible:`, element.id || element.className);
        }
      });
      
      // Show feature items with flex display
      const featureItems = document.querySelectorAll('.feature-item');
      featureItems.forEach(item => {
        item.style.display = 'flex';
        console.log('Made feature item visible');
      });
      
      // Show progress bar with block
      const progressBar = document.getElementById('usage-bar');
      if (progressBar) {
        progressBar.style.display = 'block';
      }
      
      // Explicitly hide the pricing information in subscription tab
      const pricingElement = document.getElementById('current-plan-price');
      if (pricingElement) {
        pricingElement.style.display = 'none';
        console.log('Hidden pricing information in subscription tab');
      }
      
      // Force redraw of all subscription info
      const subscriptionContent = document.getElementById('subscription-section');
      if (subscriptionContent) {
        // Trigger DOM reflow
        void subscriptionContent.offsetHeight;
      }
    }
  } else {
    console.error(`Section not found: ${tabId}-section`);
  }
  
  console.log(`Tab switch to "${tabId}" complete`);
}

// Handle plan selection and redirect to Stripe payment link
function selectPlan(plan) {
  console.log(`Selected plan: ${plan}`);
  
  // Check if user already has a subscription
  if (window.hasActiveSubscription) {
    // Open customer portal for existing subscribers
    openStripeCustomerPortal();
    return;
  }
  
  // Only proceed with payment for explicit user interactions
  openStripePayment(plan);
}

// Open the appropriate Stripe payment link - no storage
async function openStripePayment(plan) {
  try {
    // If user already has a subscription, direct them to the customer portal
    if (window.hasActiveSubscription) {
      openStripeCustomerPortal();
      return;
    }
    
    // Get the base Stripe payment link for the selected plan
    let paymentUrl = STRIPE_PAYMENT_LINKS[plan] || STRIPE_PAYMENT_LINKS.pro;
    
    // Get extension ID for later use
    const extensionId = chrome.runtime.id;
    console.log(`Extension ID for redirect handling: ${extensionId}`);
    
    // Get user email
    const email = await getUserEmail();
    
    // Add email parameter directly to the payment URL for prefilling
    if (paymentUrl.includes('?')) {
      paymentUrl += `&prefilled_email=${encodeURIComponent(email)}`;
    } else {
      paymentUrl += `?prefilled_email=${encodeURIComponent(email)}`;
    }
    
    // Generate a local client reference ID
    // This ID will help track this specific checkout session
    const timestamp = new Date().getTime();
    const clientRef = `${email.replace('@', '_at_')}_${timestamp}_${Math.random().toString(36).substring(2, 10)}`;
    console.log(`Generated local client_reference_id: ${clientRef}`);
    
    // Get client_reference_id from backend if available
    let finalClientRef = clientRef;
    try {
      console.log('Requesting client_reference_id from server for email:', email);
      const response = await fetch(`${API_BASE_URL}/generate-client-id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          email: email,
          extensionId: extensionId,
          plan: plan
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.clientReferenceId) {
          finalClientRef = data.clientReferenceId;
          console.log(`Received client_reference_id from server: ${finalClientRef}`);
        }
      }
    } catch (error) {
      console.warn('Error getting client_reference_id from server, using local ID instead:', error);
    }
    
    // Append parameters to the Stripe URL
    if (paymentUrl.includes('?')) {
      paymentUrl += `&utm_source=${encodeURIComponent(finalClientRef)}`;
    } else {
      paymentUrl += `?utm_source=${encodeURIComponent(finalClientRef)}`;
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
  } catch (error) {
    console.error('Error opening payment page:', error);
    showError(`Could not open payment page: ${error.message}. Please try again.`);
  }
}

// Modified function to open Stripe customer portal with prefilled email
async function openStripeCustomerPortal() {
  console.log('Opening Stripe customer portal');
  
  try {
    // Get user email
    const email = await getUserEmail();
    
    // Add email parameter to the portal URL
    let portalUrl = STRIPE_CUSTOMER_PORTAL;
    if (portalUrl.includes('?')) {
      portalUrl += `&prefilled_email=${encodeURIComponent(email)}`;
    } else {
      portalUrl += `?prefilled_email=${encodeURIComponent(email)}`;
    }
    
    console.log(`Opening Stripe customer portal with prefilled email: ${portalUrl}`);
    
    // Check if this is a Chrome extension context
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      // We're in a Chrome extension, use the Chrome API
      chrome.tabs.create({ url: portalUrl }, (tab) => {
        console.log('Opened Stripe customer portal:', tab.id);
      });
    } else {
      // We're in a regular web context, use window.open
      window.open(portalUrl, '_blank');
      console.log('Opened Stripe customer portal with window.open');
    }
  } catch (error) {
    console.error('Error opening customer portal:', error);
    showError(`Could not open customer portal: ${error.message}. Please try again.`);
  }
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

// Add a retry button function - always fetches fresh from server
function addRetryButton() {
  const retryBtn = document.getElementById('retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      console.log('Retry button clicked, attempting to reconnect...');
      
      // Clear error messages
      const errorBox = document.querySelector('.error-box');
      if (errorBox) {
        errorBox.innerHTML = '';
        errorBox.style.display = 'none';
      }
      
      // Show loading indicator
      if (window.activeTab === 'subscription') {
        document.getElementById('loading').style.display = 'flex';
        document.getElementById('subscription-section').style.display = 'none';
      }
      
      // Try to connect to server again
      const isOnline = await checkServerStatus();
      if (isOnline) {
        // Server is back online, reload data
        await loadUserData();
        showMessage('Connection restored! Using live data.');
      } else {
        // Still offline
        showError('Server is still unreachable. Please try again later.', true,
                  `Could not connect to ${API_BASE_URL}. Please check if the server is running.`);
      }
    });
  }
}

// Helper function to show a success message
function showMessage(message, isTemporary = true) {
  const container = document.querySelector('.content-container');
  if (!container) return;
  
  // Create or get message box
  let messageBox = document.querySelector('.message-box');
  if (!messageBox) {
    messageBox = document.createElement('div');
    messageBox.className = 'message-box';
    container.prepend(messageBox);
  }
  
  // Set message
  messageBox.textContent = message;
  messageBox.style.display = 'block';
  messageBox.style.backgroundColor = '#4caf50';
  messageBox.style.color = 'white';
  messageBox.style.padding = '10px';
  messageBox.style.borderRadius = '4px';
  messageBox.style.margin = '10px 0';
  
  // Clear after 3 seconds if temporary
  if (isTemporary) {
    setTimeout(() => {
      messageBox.style.display = 'none';
    }, 3000);
  }
}

// Function to check subscription status using email
function checkSubscriptionStatus() {
  console.log('Checking subscription status directly from server');
  
  // Get the user email and fetch data
  getUserEmail()
    .then(email => {
      return fetchServerUsageData(email);
    })
    .catch(error => {
      console.error('Failed to check subscription status:', error);
      
      // Show error
      showError('Could not verify subscription status. Please try again later.', true,
               `Error: ${error.message}`);
    });
}

// Modified checkForPlanSelection to not use storage
function checkForPlanSelection() {
  const urlParams = new URLSearchParams(window.location.search);
  const planFromUrl = urlParams.get('plan');
  
  if (planFromUrl) {
    console.log('Plan parameter detected in URL:', planFromUrl);
    // Switch to the plans tab
    switchTab('plans');
    
    // Just highlight the specified plan but don't auto-select it to prevent auto-payment
    document.querySelectorAll('.plan-card').forEach(card => {
      const cardPlan = card.getAttribute('data-plan');
      if (cardPlan === planFromUrl) {
        card.classList.add('highlighted');
        // Scroll to it if needed
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        card.classList.remove('highlighted');
      }
    });
  }
} 