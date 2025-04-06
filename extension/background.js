// Listen for messages from content script, popup, or external websites
chrome.runtime.onMessageExternal.addListener(function(request, sender, sendResponse) {
  console.log("Background script received external message:", request.action, "from:", sender.url);
  
  // Handle payment success messages from our server
  if (request.action === "paymentSuccess") {
    console.log("Payment success received from external source:", request.plan);
    
    // Get the user ID from storage
    chrome.storage.local.get(['tldrUserId'], function(result) {
      if (result.tldrUserId) {
        const userId = result.tldrUserId;
        
        // Store subscription data
        const subscriptionData = {
          plan: request.plan,
          startDate: request.startDate || new Date().toISOString(),
          expiryDate: request.expiryDate || calculateExpiryDate(request.plan),
          active: true
        };
        
        console.log("Storing subscription data from external source:", subscriptionData);
        
        // Save subscription data to storage
        chrome.storage.local.set({ 
          subscription: subscriptionData
        }, function() {
          console.log('Subscription data saved successfully');
          
          // Update badge to show subscription is active
          chrome.action.setBadgeText({ text: "PRO" });
          chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
          
          // Try to open the popup to show the updated subscription status
          try {
            chrome.action.openPopup().catch(error => {
              console.log('Could not open popup directly after payment, using fallback');
              
              // Try to create a notification
              chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icon.jpg',
                title: 'Subscription Activated',
                message: `Your ${request.plan === 'premium' ? 'Premium' : 'Pro'} plan is now active!`,
                priority: 2
              }, function(notificationId) {
                if (chrome.runtime.lastError) {
                  console.error('Notification creation failed:', chrome.runtime.lastError);
                }
              });
            });
          } catch (e) {
            console.error('Error trying to open popup:', e);
          }
        });
      } else {
        console.error("No user ID found when handling external payment success");
      }
    });
    
    // Send response to acknowledge
    sendResponse({ success: true });
    return true; // Keep message channel open for async response
  }
  
  // Handle external request to open the popup
  if (request.action === "openPopup") {
    console.log("Received external request to open popup");
    
    // Store the selected plan in storage for the popup to access if provided
    if (request.plan) {
      chrome.storage.local.set({ selectedPlan: request.plan }, function() {
        console.log('Selected plan stored from external source:', request.plan);
      });
    }
    
    // Try to open the popup directly
    try {
      chrome.action.openPopup().catch(error => {
        console.log('Could not open popup directly, opening in a new tab instead');
        // Open popup in a new tab as fallback
        openPopupInNewTab();
      });
    } catch (e) {
      console.error('Error trying to open popup:', e);
      // Open in a new tab as fallback
      openPopupInNewTab();
    }
    
    // Send a response to acknowledge receiving the message
    sendResponse({ success: true });
    return true; // Keep the message channel open for async response
  }
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  console.log("Background script received message:", request.action);
  
  if (request.action === "openPopup") {
    // Store the selected plan in storage for the popup to access
    chrome.storage.local.set({ selectedPlan: request.plan }, function() {
      console.log('Selected plan stored:', request.plan);
      
      // Try to open the popup directly (may not work due to Chrome restrictions)
      chrome.action.openPopup().catch(error => {
        console.log('Could not open popup directly, opening in a new tab instead');
        // Open popup in a new tab as fallback
        openPopupInNewTab();
      });
    });
    
    // Send a response to acknowledge receiving the message
    sendResponse({ success: true });
    return true; // Keep the message channel open for async response
  }
  
  // Handle payment success message from payment-success.html
  if (request.action === "paymentSuccess") {
    console.log("Payment success received for plan:", request.plan);
    
    // Get the user ID from storage
    chrome.storage.local.get(['tldrUserId'], function(result) {
      if (result.tldrUserId) {
        const userId = result.tldrUserId;
        
        // Store subscription data
        const subscriptionData = {
          plan: request.plan,
          startDate: request.startDate || new Date().toISOString(),
          expiryDate: request.expiryDate || calculateExpiryDate(request.plan),
          active: true
        };
        
        console.log("Storing subscription data:", subscriptionData);
        
        // Save subscription data to storage
        chrome.storage.local.set({ 
          subscription: subscriptionData
        }, function() {
          console.log('Subscription data saved successfully');
          
          // Update badge to show subscription is active
          chrome.action.setBadgeText({ text: "PRO" });
          chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
          
          // Try to open the popup to show the updated subscription status
          try {
            chrome.action.openPopup().catch(error => {
              console.log('Could not open popup directly after payment, using fallback');
              
              // Try to create a notification
              chrome.notifications.create({
                type: 'basic',
                iconUrl: 'icons/icon128.png',
                title: 'Subscription Activated',
                message: `Your ${request.plan === 'premium' ? 'Premium' : 'Pro'} plan is now active!`,
                priority: 2
              }, function(notificationId) {
                if (chrome.runtime.lastError) {
                  console.error('Notification creation failed:', chrome.runtime.lastError);
                }
              });
              
              // Open popup in a new tab as fallback
              openPopupInNewTab();
            });
          } catch (e) {
            console.error('Error trying to open popup:', e);
          }
        });
      } else {
        console.error("No user ID found when handling payment success");
      }
    });
    
    // Send response to acknowledge
    sendResponse({ success: true });
    return true; // Keep message channel open for async response
  }
});

// Function to open popup in a new tab
function openPopupInNewTab() {
  chrome.tabs.create({
    url: chrome.runtime.getURL("popup.html")
  });
}

// Function to calculate expiry date based on plan
function calculateExpiryDate(plan) {
  const expiryDate = new Date();
  
  if (plan === 'premium') {
    expiryDate.setDate(expiryDate.getDate() + 365); // 1 year
  } else {
    expiryDate.setDate(expiryDate.getDate() + 30); // 30 days
  }
  
  return expiryDate.toISOString();
}

// Check subscription status on startup
chrome.runtime.onStartup.addListener(function() {
  checkSubscriptionStatus();
});

// Also check when extension is installed or updated
chrome.runtime.onInstalled.addListener(function() {
  checkSubscriptionStatus();
});

// Function to check subscription status and clear expired subscriptions
function checkSubscriptionStatus() {
  chrome.storage.local.get(['subscription'], function(result) {
    if (result.subscription) {
      const subscription = result.subscription;
      
      // Check if subscription is expired
      const now = new Date();
      const expiryDate = new Date(subscription.expiryDate);
      
      if (now > expiryDate) {
        console.log('Subscription expired, clearing subscription data');
        chrome.storage.local.set({ subscription: null });
        chrome.action.setBadgeText({ text: "" });
      } else {
        // Update badge for active subscription
        chrome.action.setBadgeText({ text: "PRO" });
        chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
      }
    }
  });
} 