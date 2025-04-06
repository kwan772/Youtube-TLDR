from flask import Flask, request, jsonify, Response, stream_with_context, render_template_string, make_response
from flask_cors import CORS
import requests
import os
import time
from openai import OpenAI
from functools import lru_cache
import threading
from datetime import datetime, timedelta
from youtube_transcript_api import YouTubeTranscriptApi
import json
import uuid
import stripe
from collections import defaultdict, Counter
import logging
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Disable automatic CORS handling
CORS(app)

# Add CORS headers to all responses
@app.after_request
def add_cors_headers(response):
    # Allow requests from any origin
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS,HEAD')
    response.headers.add('Access-Control-Max-Age', '86400')  # 24 hours
    return response

# Add OPTIONS response for all routes
@app.route('/', defaults={'path': ''}, methods=['OPTIONS'])
@app.route('/<path:path>', methods=['OPTIONS'])
def options_handler(path):
    response = make_response()
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization,Accept')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS,HEAD')
    response.headers.add('Access-Control-Max-Age', '86400')  # 24 hours
    return response

# Stripe configuration - replace with your keys in production
stripe.api_key = os.getenv('STRIPE_SECRET_KEY', 'sk_test_your_test_key')  # Test key

# Simple rate limiter implementation
class RateLimiter:
    def __init__(self, limit=15, per_minutes=1):
        self.limit = limit
        self.window = timedelta(minutes=per_minutes)
        self.requests = {}  # IP -> list of timestamps
    
    def is_allowed(self, ip):
        now = datetime.now()
        if ip not in self.requests:
            self.requests[ip] = []
        
        # Remove old requests
        self.requests[ip] = [t for t in self.requests[ip] if now - t < self.window]
        
        # Check if under limit
        if len(self.requests[ip]) < self.limit:
            self.requests[ip].append(now)
            return True
        return False

# Create rate limiter
rate_limiter = RateLimiter(limit=15, per_minutes=1)

# Initialize Google OpenAI client
gen_client = OpenAI(
    api_key=os.environ.get("GOOGLE_API_KEY", "AIzaSyAASCCmGK0EoxtvaWnWdC9ZZgw5xowlZrk"),
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/"
)

# Initialize cache (using a dictionary in Python)
summary_cache = {}
CACHE_TTL = 24 * 60 * 60  # 24 hours in seconds

# In-memory database for user tracking (switch to a real DB in production)
user_usage = defaultdict(lambda: {"count": 0, "videos": set()})
user_subscriptions = {}

# Configuration
FREE_TIER_LIMIT = 0  # Number of free summaries per month
SUBSCRIPTION_PLANS = {
    "pro": {
        "name": "Pro Plan",
        "price": 499,  # $4.99 in cents
        "features": ["Unlimited summaries", "Enhanced AI model", "Priority support"],
        "duration": 30,  # days
    },
    "premium": {
        "name": "Premium Plan",
        "price": 999,  # $9.99 in cents
        "features": ["Unlimited summaries", "Enhanced AI model", "Custom summary length", 
                    "Download summaries", "YouTube Channel analysis"],
        "duration": 30,  # days
    }
}

# Function to get transcript using the YouTube Transcript API SDK
def get_transcript(video_id):
    try:
        # Use the SDK to get the transcript
        transcript_list = YouTubeTranscriptApi.get_transcript(video_id)
        
        if not transcript_list or len(transcript_list) == 0:
            raise Exception("No transcript found")
        
        # Convert to the same format as before
        return [{"text": item["text"]} for item in transcript_list]
    except Exception as error:
        print(f"Error fetching transcript: {error}")
        raise

def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    seconds = int(seconds % 60)
    
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"

# Check if user has reached their usage limits
@app.route('/usage', methods=['GET'])
def check_usage():
    try:
        user_id = request.args.get('userId')
        if not user_id:
            return jsonify({
                "error": "Missing userId parameter"
            }), 400
        
        # Look for subscription header or query parameter in case the client includes it
        subscription_header = request.headers.get('X-Subscription')
        subscription_param = request.args.get('subscription')
        client_subscription_data = None
        
        # Try to parse subscription data from header or param
        if subscription_header:
            try:
                client_subscription_data = json.loads(subscription_header)
            except:
                pass
                
        elif subscription_param:
            try:
                client_subscription_data = json.loads(subscription_param)
            except:
                pass
        
        # Check for a valid client-provided subscription
        has_subscription = False
        if client_subscription_data and isinstance(client_subscription_data, dict):
            plan = client_subscription_data.get('plan')
            expiry_date_str = client_subscription_data.get('expiryDate')
            
            if plan and expiry_date_str:
                try:
                    # Parse the expiry date
                    expiry_date = datetime.fromisoformat(expiry_date_str.replace('Z', '+00:00'))
                    
                    # Make sure current time is timezone-aware for comparison
                    current_time = datetime.now().replace(tzinfo=expiry_date.tzinfo)
                    
                    # Check if subscription is still valid
                    if current_time < expiry_date:
                        print(f"Valid client subscription in usage check: {plan}, expires: {expiry_date}")
                        has_subscription = True
                        
                        # Store the subscription info in our database
                        user_subscriptions[user_id] = {
                            "plan": plan,
                            "expiresAt": expiry_date
                        }
                except Exception as e:
                    print(f"Error parsing client subscription in usage check: {e}")
        
        # If no valid client subscription, check our database
        if not has_subscription:
            # Check if user has an active subscription
            subscription = user_subscriptions.get(user_id)
            if subscription and subscription.get('expiresAt'):
                expiry = subscription.get('expiresAt')
                current_time = datetime.now()
                
                # Make both times timezone-aware or naive for comparison
                if hasattr(expiry, 'tzinfo') and expiry.tzinfo:
                    current_time = current_time.replace(tzinfo=expiry.tzinfo)
                
                has_subscription = current_time < expiry
        
        if has_subscription:
            # Return subscription details for paid users
            subscription_info = user_subscriptions.get(user_id, {})
            plan = subscription_info.get('plan', 'pro')
            limit = 1500 if plan == 'premium' else 400
            
            # Get usage count
            user_count = user_usage.get(user_id, {"count": 0}).get("count", 0)
            
            return jsonify({
                "hasReachedLimit": False,
                "usage": {
                    "current": user_count,
                    "limit": limit
                },
                "subscription": {
                    "plan": plan,
                    "expiresAt": subscription_info.get('expiresAt').isoformat() if hasattr(subscription_info.get('expiresAt'), 'isoformat') else subscription_info.get('expiresAt')
                }
            })
        
        # For non-subscribed users, check if they've reached the free limit
        usage_count = 0
        if user_id in user_usage:
            usage_count = user_usage[user_id]["count"]
        
        has_reached_limit = usage_count >= FREE_TIER_LIMIT and FREE_TIER_LIMIT > 0
        
        return jsonify({
            "hasReachedLimit": has_reached_limit,
            "usage": {
                "current": usage_count,
                "limit": FREE_TIER_LIMIT
            }
        })
    except Exception as error:
        print(f"Error checking usage: {error}")
        return jsonify({
            "error": "Failed to check usage",
            "details": str(error)
        }), 500

# Track user summary usage
@app.route('/usage', methods=['POST'])
def track_usage():
    try:
        data = request.json
        user_id = data.get('userId')
        video_id = data.get('videoId')
        
        if not user_id or not video_id:
            return jsonify({
                "error": "Missing required parameters"
            }), 400
        
        # Check for subscription in the request
        client_subscription = data.get('subscription')
        has_subscription = False
        
        # Check client-provided subscription first (from Chrome extension)
        if client_subscription and isinstance(client_subscription, dict):
            plan = client_subscription.get('plan')
            expiry_date_str = client_subscription.get('expiryDate')
            
            if plan and expiry_date_str:
                try:
                    # Parse the expiry date
                    expiry_date = datetime.fromisoformat(expiry_date_str.replace('Z', '+00:00'))
                    
                    # Make sure current time is timezone-aware for comparison
                    current_time = datetime.now().replace(tzinfo=expiry_date.tzinfo)
                    
                    # Check if subscription is still valid
                    if current_time < expiry_date:
                        print(f"Valid subscription found in usage tracking: {plan}, expires: {expiry_date}")
                        has_subscription = True
                        
                        # Store or update the subscription in our database for future requests
                        user_subscriptions[user_id] = {
                            "plan": plan,
                            "expiresAt": expiry_date
                        }
                except Exception as e:
                    print(f"Error parsing client subscription data in usage tracking: {e}")
        
        # If no valid client subscription, check our database
        if not has_subscription:
            subscription = user_subscriptions.get(user_id)
            if subscription and subscription.get('expiresAt'):
                expiry = subscription.get('expiresAt')
                current_time = datetime.now()
                
                # Make both times timezone-aware or naive for comparison
                if hasattr(expiry, 'tzinfo') and expiry.tzinfo:
                    current_time = current_time.replace(tzinfo=expiry.tzinfo)
                
                has_subscription = current_time < expiry
        
        # Get current usage or initialize
        if user_id not in user_usage:
            user_usage[user_id] = {"count": 0, "videos": set()}
        
        # Check for duplicate tracking of the same video
        if video_id not in user_usage[user_id]["videos"]:
            user_usage[user_id]["count"] += 1
            user_usage[user_id]["videos"].add(video_id)
        
        # If the user has a subscription, include that info in the response
        response_data = {
            "success": True,
            "usage": {
                "current": user_usage[user_id]["count"]
            }
        }
        
        if has_subscription:
            # For paid users, get the limit based on plan
            subscription_info = user_subscriptions.get(user_id, {})
            plan = subscription_info.get('plan', 'pro')
            limit = 1500 if plan == 'premium' else 400
            
            response_data["usage"]["limit"] = limit
            response_data["subscription"] = {
                "plan": plan,
                "expiresAt": subscription_info.get('expiresAt', '').isoformat() if hasattr(subscription_info.get('expiresAt', ''), 'isoformat') else subscription_info.get('expiresAt', '')
            }
        else:
            # For free users
            response_data["usage"]["limit"] = FREE_TIER_LIMIT
        
        return jsonify(response_data)
    except Exception as error:
        print(f"Error tracking usage: {error}")
        return jsonify({
            "error": "Failed to track usage",
            "details": str(error)
        }), 500

# Route to handle Stripe payment success redirects
@app.route('/payment-success', methods=['GET'])
def payment_success():
    """Handle successful payment redirects from Stripe."""
    plan = request.args.get('plan', 'pro')
    extension_id = request.args.get('extension_id')
    client_reference_id = request.args.get('client_reference_id')
    
    # Log the payment success
    print(f"Payment success for plan: {plan}, extension ID: {extension_id}, user ID: {client_reference_id}")
    
    if client_reference_id:
        # Store the subscription in our database
        user_subscriptions[client_reference_id] = {
            "plan": plan,
            "status": "active",
            "start_date": datetime.now().isoformat(),
            "expiry_date": (datetime.now() + timedelta(days=SUBSCRIPTION_PLANS[plan]["duration"])).isoformat()
        }
        print(f"Subscription activated for user: {client_reference_id}")
    
    # Return an HTML page that will communicate with the extension
    return render_template_string("""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Payment Successful</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                text-align: center;
                background-color: #f8f9fa;
                margin: 0;
                padding: 20px;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
            }
            .container {
                background-color: white;
                padding: 30px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
                max-width: 500px;
                width: 90%;
            }
            h1 {
                color: #4CAF50;
                margin-bottom: 20px;
            }
            p {
                color: #555;
                line-height: 1.6;
                margin-bottom: 20px;
            }
            .loader {
                border: 4px solid #f3f3f3;
                border-top: 4px solid #4CAF50;
                border-radius: 50%;
                width: 30px;
                height: 30px;
                animation: spin 2s linear infinite;
                margin: 20px auto;
            }
            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
            button {
                background-color: #4285F4;
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 4px;
                cursor: pointer;
                font-weight: bold;
                margin-top: 10px;
            }
            button:hover {
                background-color: #3367D6;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Payment Successful!</h1>
            <p>Thank you for upgrading your YouTube TLDR subscription.</p>
            <p>Your new plan have been activated.</p>
            <div id="processing">
                <p>Communicating with extension...</p>
                <div class="loader"></div>
            </div>
            <div id="complete" style="display: none;">
                <p id="status-message">All set! You can now return to YouTube.</p>
                <button id="open-extension-btn">Open Extension</button>
                <p><small>You can close this tab after opening the extension.</small></p>
            </div>
        </div>

        <script>
            document.addEventListener('DOMContentLoaded', function() {
                const extensionId = "{{ extension_id }}";
                const plan = "{{ plan }}";
                
                console.log('Payment success page loaded for plan:', plan);
                console.log('Extension ID:', extensionId);
                
                // Calculate subscription details
                const startDate = new Date();
                const expiryDate = new Date();
                
                // Set expiry based on plan
                if (plan === 'premium') {
                    expiryDate.setDate(expiryDate.getDate() + 365); // 1 year
                } else {
                    expiryDate.setDate(expiryDate.getDate() + 30); // 30 days
                }
                
                // Try to communicate with the extension
                setTimeout(function() {
                    try {
                        chrome.runtime.sendMessage(
                            extensionId,
                            {
                                action: 'paymentSuccess',
                                plan: plan,
                                startDate: startDate.toISOString(),
                                expiryDate: expiryDate.toISOString()
                            },
                            function(response) {
                                const error = chrome.runtime.lastError;
                                if (error) {
                                    console.error('Error sending message to extension:', error);
                                    showManualInstructions();
                                } else {
                                    console.log('Response from extension:', response);
                                    showComplete(true);
                                }
                            }
                        );
                    } catch (error) {
                        console.error('Error communicating with extension:', error);
                        showManualInstructions();
                    }
                }, 1000);
                
                // Add button event handler
                document.getElementById('open-extension-btn').addEventListener('click', function() {
                    // Try to open the extension
                    try {
                        chrome.runtime.sendMessage(
                            extensionId,
                            { action: 'openPopup' },
                            function(response) {
                                console.log('Open popup response:', response);
                            }
                        );
                    } catch (error) {
                        console.error('Error opening extension:', error);
                        // Open extension page in new tab as fallback
                        window.open(`chrome-extension://${extensionId}/popup.html?plan=${plan}`, '_blank');
                    }
                });
                
                // Fallback to show complete after 5 seconds
                setTimeout(function() {
                    showComplete(false);
                }, 5000);
            });
            
            function showComplete(success) {
                document.getElementById('processing').style.display = 'none';
                document.getElementById('complete').style.display = 'block';
            }
            
            function showManualInstructions() {
                document.getElementById('processing').style.display = 'none';
                document.getElementById('complete').style.display = 'block';
                document.getElementById('status-message').innerHTML = 
                    'Your subscription has been activated! Please open the YouTube TLDR extension to see your upgraded features.';
            }
        </script>
    </body>
    </html>
    """, extension_id=extension_id, plan=plan)

@app.route('/summary', methods=['POST'])
def get_summary():
    # Apply rate limiting
    client_ip = request.remote_addr
    if not rate_limiter.is_allowed(client_ip):
        return jsonify({
            "error": "Rate limit exceeded",
            "details": "Too many requests in a short period. Please try again later."
        }), 429
    
    try:
        data = request.json
        video_id = data.get('videoId')
        transcript = data.get('transcript', [])
        user_id = data.get('userId')
        
        # Check for subscription data in request
        client_subscription = data.get('subscription')
        
        if not video_id:
            return jsonify({
                "error": "Missing video ID",
                "details": "Please provide a valid YouTube video ID"
            }), 400
        
        # Generate cache key
        cache_key = f"{video_id}"
        
        # Check if user has reached free tier limit
        # First check if user has a valid subscription from request or database
        has_subscription = False
        
        # Check client-provided subscription first (from Chrome extension)
        if client_subscription and isinstance(client_subscription, dict):
            plan = client_subscription.get('plan')
            expiry_date_str = client_subscription.get('expiryDate')
            
            if plan and expiry_date_str:
                try:
                    # Parse the expiry date
                    expiry_date = datetime.fromisoformat(expiry_date_str.replace('Z', '+00:00'))
                    
                    # Make sure current time is timezone-aware for comparison
                    current_time = datetime.now().replace(tzinfo=expiry_date.tzinfo)
                    
                    # Check if subscription is still valid
                    if current_time < expiry_date:
                        print(f"Valid subscription found in request: {plan}, expires: {expiry_date}")
                        has_subscription = True
                        
                        # Store or update the subscription in our database for future requests
                        user_subscriptions[user_id] = {
                            "plan": plan,
                            "expiresAt": expiry_date
                        }
                except Exception as e:
                    print(f"Error parsing client subscription data: {e}")
        
        # If no valid client subscription, check our database
        if not has_subscription and user_id:
            subscription = user_subscriptions.get(user_id)
            if subscription and subscription.get('expiresAt'):
                expiry = subscription.get('expiresAt')
                current_time = datetime.now()
                
                # Make both times timezone-aware or naive for comparison
                if hasattr(expiry, 'tzinfo') and expiry.tzinfo:
                    current_time = current_time.replace(tzinfo=expiry.tzinfo)
                
                has_subscription = current_time < expiry
        
        # If no subscription, check if they've reached the free limit
        if not has_subscription:
            if user_id and user_id in user_usage:
                usage_count = user_usage[user_id]["count"]
                if usage_count >= FREE_TIER_LIMIT and FREE_TIER_LIMIT > 0:
                    return jsonify({
                        "error": "You've reached your free tier limit. Please upgrade to continue using the service.",
                        "requiresPayment": True
                    }), 402  # 402 Payment Required
            
            # For new users or those within limits, continue processing
        
        # Check if we have a cached summary
        cached_summary = summary_cache.get(cache_key)
        if cached_summary:
            # Send cached result
            def generate_cached():
                yield json.dumps({
                    "cached": True,
                    "summary": cached_summary
                }) + "\n"
            
            return Response(
                generate_cached(),
                mimetype='application/x-ndjson'
            )
        
        # transcript is empty or not a list
        if not transcript:
            try:
                print(f"No transcript provided, attempting to fetch from YouTube API: {video_id}")
                transcript = get_transcript(video_id)
            except Exception as e:
                print(f"Failed to fetch transcript: {e}")

        compact_transcript = []
        for item in transcript:
            text = item.get("text", "")
            start_time = item.get("start", 0)
            formatted_time = format_timestamp(start_time)
            compact_transcript.append({
                "text": text,
                "timestamp": formatted_time
            })
        
        # Generate streaming response
        def generate():
            # Generate summary using Google's OpenAI API with streaming
            core_prompt = f'''
You are an AI assistant tasked with summarizing YouTube video transcripts for display in a very small space (like a tooltip). The goal is maximum scannability and quick understanding, accurately reflecting the breadth and **full duration** of the video's content.

**Input:**
1.  **Video Transcript:**
    ```
    {compact_transcript}
    ```
2.  **Estimated Video Duration (Optional but highly recommended for >1hr videos):** [e.g., "Approx. 3 hours 45 minutes"]

**Task:**
Analyze the provided transcript and generate an extremely concise summary.
1.  Identify the single core theme or overarching topic for the **Main Point**.
2.  Select **distinct, highly important key moments or major topic shifts** for the **Highlights**. The number should reflect the video's length and density:
    *   **Short videos (< 45 min):** Aim for **4 to 6** highlights.
    *   **Medium videos (45 min - 2 hours):** Aim for **6 to 10** highlights.
    *   **VERY Long videos/podcasts (> 2 hours):** Aim for **8 to 12** highlights (use up to 15 *only if absolutely necessary* to capture distinct, crucial topics spread across the *entire* duration). Prioritize significance; do not add filler points.
3.  **CRITICAL & NON-NEGOTIABLE REQUIREMENT:** Highlights **MUST** be strategically distributed to represent the **ENTIRE video duration, from the beginning right through to the concluding sections.** For content longer than 90 minutes, it is **ESSENTIAL** to include significant points from the **final hour or final major topic discussed,** no matter how late it occurs in the transcript. Actively fight timestamp clustering; ensure coverage across all major parts (early, multiple distinct mid-sections, late, **very late/end**).
4.  Exclude all filler, extended pleasantries, intros/greetings, sponsor messages, calls to action, and outro remarks. Focus *only* on substantive discussion points, key arguments, findings, or distinct topic introductions/conclusions.

**Output Format:**

💡 Main Point:
[Provide a single, extremely concise sentence (max 15 words) summarizing the video's core theme or overall subject.]

⏱️ Highlights:
[List **between 4 and 15** key moments/topic shifts, adjusted for video length/density per Task #2. Each MUST have a starting timestamp `[HH:MM:SS]` (preferred for >1hr) or `[MM:SS]` and a *very brief* description (max ~7-10 words). **Ensure timestamps demonstrate significant progression covering the FULL duration, with representation from the final segments.**]
*   `[HH:MM:SS]` - [Key moment/topic - early]
*   `[HH:MM:SS]` - [Key moment/topic - early-middle]
*   *... (additional points distributed through middle sections)*
*   `[HH:MM:SS]` - [Key moment/topic - late-middle]
*   `[HH:MM:SS]` - [Key moment/topic - **late / near end**]
*   `[HH:MM:SS]` - [Key moment/topic - **potentially from final discussion**]

**Tone:** Highly economical, factual, and neutral. Prioritize extreme brevity *for each highlight description*. Ensure descriptions capture the essence of the point despite their short length. **Adherence to full duration highlight distribution, especially including the final stages of long content, is paramount. Verify the last highlight timestamp reflects content near the actual end.**
                     '''
            
            if "start" in transcript[-1] and transcript[-1]["start"] < 1800:
                core_prompt = f'''
Input:

Video Transcript:

{compact_transcript}
Use code with caution.
Task:
Analyze the provided transcript and generate an extremely concise summary.

Identify the single core topic or finding for the Main Point.

Select 4 to 6 distinct, highly important key moments for the Highlights.

CRITICAL REQUIREMENT: These highlights MUST be drawn from different sections of the video to represent its entire progression. Actively search for significant moments in the beginning, middle (approx. 30-70% mark), and end (final ~20-30%) of the transcript. Do NOT cluster highlights only at the start.

Exclude all filler, introductions, greetings, sponsor messages, calls to action, and outro remarks. Focus only on substantive content.

Output Format:

💡 Main Point:
[Provide a single, extremely concise sentence (max 15 words) summarizing the video's core topic or finding.]

⏱️ Highlights:
[List **between 4 and 10** key moments/topic shifts, adjusted for video length as per Task #2. Each MUST have a starting timestamp `[HH:MM:SS]` or `[MM:SS]` and a *very brief* description (max ~7-10 words). **Ensure timestamps demonstrate significant progression throughout the entire video.** For multi-hour videos, expect timestamps spanning hours.]
*   `[HH:MM:SS]` - [Key moment/topic - early]
*   `[HH:MM:SS]` - [Key moment/topic - early-middle]
*   `[HH:MM:SS]` - [Key moment/topic - mid-video]
*   `[HH:MM:SS]` - [Key moment/topic - mid-video / major shift]
*   *... (additional points distributed through middle)*
*   `[HH:MM:SS]` - [Key moment/topic - late-middle]
*   `[HH:MM:SS] - [Key moment/topic - near end / conclusion]

**Tone:** Highly economical, factual, and neutral. Prioritize extreme brevity *for each highlight description*. Ensure descriptions capture the essence of the point despite their short length. **Adherence to highlight distribution across the *entire* duration is paramount, especially for long content.
                '''

            response = gen_client.chat.completions.create(
                model="gemini-2.0-flash",
                messages=[
                    {"role": "system", "content": f"You are an AI assistant tasked with summarizing YouTube video transcripts for display in a very small space (like a tooltip). The goal is maximum scannability and quick understanding, accurately reflecting the breadth and **full duration** of the video's content."},
                    # {"role": "user", "content": f"{full_text}\n\nSummarize this YouTube video transcript within 5 sentences:"}
                    {"role": "user", "content":core_prompt}
                ],
                stream=True  # Enable streaming
            )

            summary = ""
            for chunk in response:
                if chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    summary += content
                    # Send the chunk to the client with consistent formatting
                    chunk_response = json.dumps({"chunk": content, "done": False})
                    yield chunk_response + '\n'

            # Cache the complete summary
            summary_cache[video_id] = summary
            
            # Set up cache expiration
            def remove_from_cache():
                if video_id in summary_cache:
                    del summary_cache[video_id]
            
            t = threading.Timer(CACHE_TTL, remove_from_cache)
            t.daemon = True
            t.start()
            
            # Track usage if user_id is provided
            if user_id:
                # Get current usage or initialize
                if user_id not in user_usage:
                    user_usage[user_id] = {"count": 0, "videos": set()}
                
                # Check for duplicate tracking of the same video
                if video_id not in user_usage[user_id]["videos"]:
                    user_usage[user_id]["count"] += 1
                    user_usage[user_id]["videos"].add(video_id)

            # Send ONE final message with done: true - with proper formatting
            final_response = json.dumps({"chunk": "", "done": True})
            yield final_response + '\n'
        
        return Response(
            generate(),
            mimetype='application/x-ndjson'
        )
        
    except Exception as e:
        return jsonify({
            "error": "An unexpected error occurred",
            "details": str(e)
        }), 500

@app.route('/payment', methods=['GET'])
def payment_page():
    try:
        user_id = request.args.get('userId')
        plan_id = request.args.get('plan')
        
        if not user_id:
            return "Missing user ID", 400
        
        # If no plan specified, show plan selection page
        if not plan_id:
            return render_template_string("""
                <!DOCTYPE html>
                <html>
                <head>
                    <title>YouTube TLDR - Subscription Plans</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            line-height: 1.6;
                            color: #333;
                            margin: 0;
                            padding: 0;
                            background-color: #f9f9f9;
                        }
                        .container {
                            max-width: 1000px;
                            margin: 0 auto;
                            padding: 40px 20px;
                        }
                        .header {
                            text-align: center;
                            margin-bottom: 40px;
                        }
                        .logo {
                            font-size: 28px;
                            font-weight: bold;
                            color: #333;
                        }
                        h1 {
                            font-size: 36px;
                            margin: 10px 0;
                        }
                        p {
                            font-size: 18px;
                            color: #666;
                        }
                        .plans {
                            display: flex;
                            flex-wrap: wrap;
                            justify-content: center;
                            gap: 30px;
                            margin-top: 40px;
                        }
                        .plan {
                            background: white;
                            border-radius: 10px;
                            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                            padding: 30px;
                            width: 280px;
                            text-align: center;
                            position: relative;
                            transition: transform 0.3s ease;
                        }
                        .plan:hover {
                            transform: translateY(-5px);
                        }
                        .plan.popular {
                            border: 2px solid #4a6cf7;
                        }
                        .plan-name {
                            font-size: 24px;
                            font-weight: bold;
                            margin-bottom: 15px;
                        }
                        .plan-price {
                            font-size: 36px;
                            font-weight: bold;
                            margin-bottom: 20px;
                        }
                        .plan-price span {
                            font-size: 16px;
                            font-weight: normal;
                        }
                        .features {
                            list-style: none;
                            padding: 0;
                            margin: 30px 0;
                            text-align: left;
                        }
                        .features li {
                            padding: 5px 0;
                            position: relative;
                            padding-left: 25px;
                        }
                        .features li::before {
                            content: "✓";
                            color: #4a6cf7;
                            position: absolute;
                            left: 0;
                        }
                        .button {
                            display: inline-block;
                            background-color: #4a6cf7;
                            color: white;
                            border: none;
                            border-radius: 5px;
                            padding: 12px 25px;
                            font-size: 16px;
                            font-weight: bold;
                            cursor: pointer;
                            transition: background-color 0.3s;
                            text-decoration: none;
                        }
                        .button:hover {
                            background-color: #3152d4;
                        }
                        .button.secondary {
                            background-color: transparent;
                            border: 2px solid #ccc;
                            color: #666;
                        }
                        .button.secondary:hover {
                            background-color: #f5f5f5;
                        }
                        .popular-badge {
                            position: absolute;
                            top: -12px;
                            right: 20px;
                            background-color: #4a6cf7;
                            color: white;
                            padding: 5px 15px;
                            border-radius: 20px;
                            font-size: 14px;
                            font-weight: bold;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <div class="logo">YouTube TLDR</div>
                            <h1>Choose Your Plan</h1>
                            <p>Get AI-powered summaries for any YouTube video</p>
                        </div>
                        
                        <div class="plans">
                            <div class="plan">
                                <div class="plan-name">Free</div>
                                <div class="plan-price">$0 <span>/month</span></div>
                                <p>Limited access to try out the service</p>
                                <ul class="features">
                                    <li>5 video summaries per month</li>
                                    <li>Basic AI model</li>
                                    <li>Standard summary length</li>
                                </ul>
                                <button class="button secondary" disabled>Current Plan</button>
                            </div>
                            
                            <div class="plan popular">
                                <div class="popular-badge">Most Popular</div>
                                <div class="plan-name">Pro</div>
                                <div class="plan-price">$3.99 <span>/month</span></div>
                                <p>Perfect for regular YouTube viewers</p>
                                <ul class="features">
                                    <li>Unlimited summaries</li>
                                    <li>Enhanced AI model</li>
                                    <li>Priority processing</li>
                                    <li>Email support</li>
                                </ul>
                                <a href="/payment?userId={{ user_id }}&plan=pro" class="button">Select Pro</a>
                            </div>
                            
                            <div class="plan">
                                <div class="plan-name">Premium</div>
                                <div class="plan-price">$8.99 <span>/month</span></div>
                                <p>For power users who need it all</p>
                                <ul class="features">
                                    <li>All Pro features</li>
                                    <li>Custom summary length</li>
                                    <li>Download summaries</li>
                                    <li>YouTube Channel analysis</li>
                                    <li>Priority support</li>
                                </ul>
                                <a href="/payment?userId={{ user_id }}&plan=premium" class="button">Select Premium</a>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            """, user_id=user_id)
        
        # Check if plan is valid
        if plan_id not in SUBSCRIPTION_PLANS:
            return "Invalid plan", 400
        
        # Get plan details
        plan = SUBSCRIPTION_PLANS[plan_id]
        
        # Return payment page
        return render_template_string("""
            <!DOCTYPE html>
            <html>
            <head>
                <title>YouTube TLDR - Payment</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <script src="https://js.stripe.com/v3/"></script>
                <style>
                    body {
                        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                        line-height: 1.6;
                        color: #333;
                        margin: 0;
                        padding: 0;
                        background-color: #f9f9f9;
                    }
                    .container {
                        max-width: 600px;
                        margin: 50px auto;
                        padding: 30px;
                        background: white;
                        border-radius: 10px;
                        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                    }
                    .header {
                        text-align: center;
                        margin-bottom: 30px;
                    }
                    .logo {
                        font-size: 24px;
                        font-weight: bold;
                        color: #333;
                    }
                    h1 {
                        font-size: 28px;
                        margin: 10px 0;
                    }
                    .plan-details {
                        background-color: #f5f7ff;
                        border-radius: 8px;
                        padding: 20px;
                        margin-bottom: 30px;
                    }
                    .plan-name {
                        font-size: 20px;
                        font-weight: bold;
                    }
                    .plan-price {
                        font-size: 24px;
                        font-weight: bold;
                        margin: 10px 0;
                    }
                    .feature-list {
                        margin: 15px 0;
                    }
                    .feature {
                        display: flex;
                        align-items: center;
                        margin-bottom: 8px;
                    }
                    .feature-check {
                        color: #4a6cf7;
                        margin-right: 10px;
                    }
                    .form-group {
                        margin-bottom: 20px;
                    }
                    label {
                        display: block;
                        margin-bottom: 8px;
                        font-weight: 500;
                    }
                    #card-element {
                        background-color: white;
                        border: 1px solid #ddd;
                        border-radius: 4px;
                        padding: 12px;
                    }
                    #card-errors {
                        color: #dc3545;
                        margin-top: 10px;
                        font-size: 14px;
                    }
                    .button {
                        display: block;
                        width: 100%;
                        background-color: #4a6cf7;
                        color: white;
                        border: none;
                        border-radius: 5px;
                        padding: 12px 25px;
                        font-size: 16px;
                        font-weight: bold;
                        cursor: pointer;
                        transition: background-color 0.3s;
                    }
                    .button:hover {
                        background-color: #3152d4;
                    }
                    .terms {
                        font-size: 14px;
                        color: #666;
                        text-align: center;
                        margin-top: 20px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="logo">YouTube TLDR</div>
                        <h1>Complete Your Purchase</h1>
                    </div>
                    
                    <div class="plan-details">
                        <div class="plan-name">{{ plan["name"] }}</div>
                        <div class="plan-price">${{ plan["price"] / 100 }}<span>/month</span></div>
                        
                        <div class="feature-list">
                            {% for feature in plan["features"] %}
                            <div class="feature">
                                <span class="feature-check">✓</span>
                                <span>{{ feature }}</span>
                            </div>
                            {% endfor %}
                        </div>
                    </div>
                    
                    <form id="payment-form">
                        <div class="form-group">
                            <label for="card-element">Credit or debit card</label>
                            <div id="card-element"></div>
                            <div id="card-errors" role="alert"></div>
                        </div>
                        
                        <button id="submit-button" class="button">Subscribe Now</button>
                    </form>
                    
                    <div class="terms">
                        By subscribing, you agree to our Terms of Service and Privacy Policy.
                        Your subscription will automatically renew each month until canceled.
                    </div>
                </div>
                
                <script>
                    // Initialize Stripe
                    var stripe = Stripe('pk_test_TYooMQauvdEDq54NiTphI7jx');  // Replace with your Publishable Key
                    var elements = stripe.elements();
                    
                    // Create card Element
                    var card = elements.create('card', {
                        style: {
                            base: {
                                fontSize: '16px',
                                color: '#32325d',
                            }
                        }
                    });
                    
                    // Add card Element to the page
                    card.mount('#card-element');
                    
                    // Handle validation errors
                    card.addEventListener('change', function(event) {
                        var displayError = document.getElementById('card-errors');
                        if (event.error) {
                            displayError.textContent = event.error.message;
                        } else {
                            displayError.textContent = '';
                        }
                    });
                    
                    // Handle form submission
                    var form = document.getElementById('payment-form');
                    form.addEventListener('submit', function(event) {
                        event.preventDefault();
                        
                        // Disable the submit button to prevent multiple clicks
                        document.getElementById('submit-button').disabled = true;
                        document.getElementById('submit-button').textContent = 'Processing...';
                        
                        // Create payment intent on server
                        fetch('/create-payment-intent', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                userId: '{{ user_id }}',
                                planId: '{{ plan_id }}'
                            })
                        })
                        .then(function(response) {
                            return response.json();
                        })
                        .then(function(data) {
                            if (data.error) {
                                var errorElement = document.getElementById('card-errors');
                                errorElement.textContent = data.error;
                                document.getElementById('submit-button').disabled = false;
                                document.getElementById('submit-button').textContent = 'Subscribe Now';
                                return;
                            }
                            
                            // Use client secret to confirm payment
                            return stripe.confirmCardPayment(data.clientSecret, {
                                payment_method: {
                                    card: card
                                }
                            });
                        })
                        .then(function(result) {
                            if (result.error) {
                                // Show error
                                var errorElement = document.getElementById('card-errors');
                                errorElement.textContent = result.error.message;
                                document.getElementById('submit-button').disabled = false;
                                document.getElementById('submit-button').textContent = 'Subscribe Now';
                            } else {
                                // Payment succeeded, redirect to success page
                                window.location.href = '/payment-success?userId={{ user_id }}&planId={{ plan_id }}&extension_id={{ extension_id }}&client_reference_id={{ client_reference_id }}';
                            }
                        })
                        .catch(function(error) {
                            console.error('Error:', error);
                            var errorElement = document.getElementById('card-errors');
                            errorElement.textContent = 'An unexpected error occurred.';
                            document.getElementById('submit-button').disabled = false;
                            document.getElementById('submit-button').textContent = 'Subscribe Now';
                        });
                    });
                </script>
            </body>
            </html>
        """, plan=plan, user_id=user_id, plan_id=plan_id, extension_id=uuid.uuid4(), client_reference_id=uuid.uuid4())
    
    except Exception as e:
        logging.error(f"Error creating payment page: {str(e)}")
        return "An error occurred while processing your request", 500

@app.route('/create-payment-intent', methods=['POST'])
def create_payment_intent():
    try:
        data = request.json
        user_id = data.get('userId')
        plan_id = data.get('planId')
        
        if not user_id or not plan_id:
            return jsonify({"error": "Missing user ID or plan ID"}), 400
        
        if plan_id not in SUBSCRIPTION_PLANS:
            return jsonify({"error": "Invalid plan"}), 400
        
        plan = SUBSCRIPTION_PLANS[plan_id]
        
        # Create a PaymentIntent with Stripe
        payment_intent = stripe.PaymentIntent.create(
            amount=plan["price"],
            currency="usd",
            description=f"YouTube TLDR {plan['name']} subscription",
            metadata={
                "userId": user_id,
                "planId": plan_id
            }
        )
        
        return jsonify({
            "clientSecret": payment_intent.client_secret,
            "paymentIntentId": payment_intent.id
        })
    
    except Exception as e:
        logging.error(f"Error creating payment intent: {str(e)}")
        return jsonify({"error": "Failed to create payment intent"}), 500

@app.route('/payment/activate', methods=['POST'])
def activate_subscription():
    try:
        data = request.json
        user_id = data.get('userId')
        payment_id = data.get('paymentId')
        
        if not user_id or not payment_id:
            return jsonify({"error": "Missing user ID or payment ID"}), 400
        
        # Verify payment with Stripe
        payment_intent = stripe.PaymentIntent.retrieve(payment_id)
        
        # Check if payment was successful
        if payment_intent.status != 'succeeded':
            return jsonify({"error": "Payment not successful"}), 400
        
        # Get plan from payment metadata
        plan_id = payment_intent.metadata.get('planId')
        
        if plan_id not in SUBSCRIPTION_PLANS:
            return jsonify({"error": "Invalid plan"}), 400
        
        plan = SUBSCRIPTION_PLANS[plan_id]
        
        # Create subscription
        expiry_date = datetime.now() + timedelta(days=plan["duration"])
        
        user_subscriptions[user_id] = {
            "plan": plan_id,
            "startedAt": datetime.now(),
            "expiresAt": expiry_date,
            "paymentId": payment_id
        }
        
        return jsonify({
            "success": True,
            "subscription": user_subscriptions[user_id]
        })
    
    except Exception as e:
        logging.error(f"Error activating subscription: {str(e)}")
        return jsonify({"error": "Failed to activate subscription"}), 500

@app.route('/process-payment', methods=['POST'])
def process_payment():
    try:
        data = request.json
        payment_method_id = data.get('paymentMethodId')
        user_id = data.get('userId') or data.get('uid')
        plan = data.get('plan')
        
        if not payment_method_id or not user_id or not plan:
            return jsonify({
                "success": False,
                "error": "Missing required parameters"
            }), 400
        
        if plan not in SUBSCRIPTION_PLANS:
            return jsonify({
                "success": False,
                "error": "Invalid subscription plan"
            }), 400
        
        try:
            # Create a subscription
            # For demo purposes, we'll just simulate a successful payment
            # In production, you'd use:
            # customer = stripe.Customer.create(payment_method=payment_method_id)
            # subscription = stripe.Subscription.create(
            #     customer=customer.id,
            #     items=[{'price': SUBSCRIPTION_PLANS[plan]['stripe_price_id']}],
            #     payment_behavior='default_incomplete',
            #     expand=['latest_invoice.payment_intent']
            # )
            
            # Create subscription in our system
            subscription_end_date = datetime.now() + timedelta(days=30)
            user_subscriptions[user_id] = {
                'plan': plan,
                'start_date': datetime.now().isoformat(),
                'expiry': subscription_end_date.isoformat(),
                'active': True
            }
            
            return jsonify({
                "success": True,
                "subscription_id": str(uuid.uuid4()),
                "expiry_date": subscription_end_date.isoformat()
            })
            
        except stripe.error.CardError as e:
            error_message = e.error.message
            return jsonify({
                "success": False,
                "error": error_message
            }), 400
            
        except stripe.error.StripeError as e:
            logging.error(f"Stripe error: {str(e)}")
            return jsonify({
                "success": False,
                "error": "Payment processing failed. Please try again."
            }), 500
            
    except Exception as e:
        logging.error(f"Error in process_payment: {str(e)}")
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

# Root route for health checks
@app.route('/', methods=['GET', 'HEAD'])
def health_check():
    """Simple health check endpoint for the server"""
    return jsonify({
        "status": "online",
        "message": "YouTube TLDR API is running",
        "version": "1.0"
    })

# CORS test endpoint
@app.route('/cors-test', methods=['GET', 'OPTIONS'])
def cors_test():
    """Endpoint to test CORS configuration"""
    if request.method == 'OPTIONS':
        # Handle preflight request
        response = jsonify({"message": "CORS preflight request successful"})
        return response
    
    # Get the origin header
    origin = request.headers.get('Origin', 'No origin header')
    
    # Return diagnostic information
    return jsonify({
        "message": "CORS test successful",
        "request_origin": origin,
        "access_control_allow_origin": "*",  # What we're sending back
        "all_request_headers": dict(request.headers),
        "server_time": datetime.now().isoformat(),
        "cors_enabled": True
    })

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3000, debug=True) 