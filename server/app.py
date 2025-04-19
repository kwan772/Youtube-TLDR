from flask import Flask, request, jsonify, Response, stream_with_context, render_template_string, make_response, redirect, url_for
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
from cryptography.fernet import Fernet
import base64
from google import genai

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
stripe.api_key = os.getenv('STRIPE_SECRET_KEY', '')  # Test key

# Generate a secret key for encryption (ideally load this from environment)
# In production, store this securely and load from environment variables
ENCRYPTION_KEY = os.getenv('ENCRYPTION_KEY', Fernet.generate_key())
cipher_suite = Fernet(ENCRYPTION_KEY)

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

# Helper function to check subscription status with Stripe
def check_subscription_with_stripe(email):
    """
    Check subscription status with Stripe using customer email.
    Returns a dict with subscription details if active, None otherwise.
    Also returns the current usage count from customer metadata.
    """
    if not email:
        return None
    
    try:
        # First find the customer by email
        customers = stripe.Customer.list(email=email, limit=1)
        
        if not customers or len(customers.data) == 0:
            print(f"No customer found for email: {email}")
            return None
        
        customer = customers.data[0]
        customer_metadata = customer.metadata or {}
        
        # Get usage count from customer metadata
        usage_count = 0
        usage_reset_date = None
        try:
            if 'monthly_usage' in customer_metadata:
                usage_count = int(customer_metadata.get('monthly_usage', '0'))
            if 'usage_reset_date' in customer_metadata:
                usage_reset_date = customer_metadata.get('usage_reset_date')
        except (ValueError, TypeError) as e:
            print(f"Error parsing usage count from customer metadata: {e}")
        
        # Get active subscriptions for the customer
        subscriptions = stripe.Subscription.list(
            customer=customer.id,
            status='active',
            limit=1
        )
        
        if not subscriptions or len(subscriptions.data) == 0:
            # Look for one-time payments as fallback
            payment_intents = stripe.PaymentIntent.list(
                customer=customer.id, 
                limit=5
            )
            
            # Check if there's a successful payment with specific metadata
            for payment in payment_intents.data:
                if payment.status == 'succeeded' and payment.metadata.get('plan'):
                    plan = payment.metadata.get('plan')
                    payment_date = datetime.fromtimestamp(payment.created)
                    
                    # Calculate expiry based on plan duration
                    if plan in SUBSCRIPTION_PLANS:
                        expiry_date = payment_date + timedelta(days=SUBSCRIPTION_PLANS[plan]["duration"])
                        
                        # Check if subscription is still valid
                        if datetime.now() < expiry_date:
                            print(f"Found active one-time payment for plan {plan}, expires: {expiry_date}")
                            
                            # Check if we need to reset usage
                            if usage_reset_date is None:
                                usage_reset_date = (now + timedelta(days=30)).isoformat()
                            try:
                                reset_date = datetime.fromisoformat(usage_reset_date)
                                now = datetime.now()
                                if now > reset_date:
                                    # Time to reset the usage count
                                    print(f"Resetting usage count for {customer.email} (one-time payment)")
                                    stripe.Customer.modify(
                                        customer.id,
                                        metadata={
                                            'monthly_usage': '0',
                                            'usage_reset_date': (now + timedelta(days=30)).isoformat(),
                                            **{k: v for k, v in customer_metadata.items() if k not in ['monthly_usage', 'usage_reset_date']}
                                        }
                                    )
                                    usage_count = 0
                            except (ValueError, TypeError) as e:
                                print(f"Error parsing usage reset date: {e}")
                            
                            return {
                                "plan": plan,
                                "status": "active",
                                "payment_id": payment.id,
                                "customer_id": customer.id,
                                "expiry_date": expiry_date,
                                "is_subscription": False,
                                "usage_count": usage_count
                            }
            
            print(f"No active subscription found for customer: {customer.id}")
            return None
        
        # Get the first active subscription
        subscription = subscriptions.data[0]
        
        # Check if we need to reset usage based on billing cycle
        current_period_start = None
        try:
            if hasattr(subscription, 'current_period_start') and subscription.current_period_start:
                current_period_start = datetime.fromtimestamp(subscription.current_period_start)
                
                # If usage_reset_date is before the current period start, we need to reset
                if usage_reset_date:
                    try:
                        reset_date = datetime.fromisoformat(usage_reset_date)
                        if current_period_start > reset_date:
                            # New billing cycle, reset the usage count
                            print(f"Resetting usage count for {customer.email} (new billing cycle)")
                            stripe.Customer.modify(
                                customer.id,
                                metadata={
                                    'monthly_usage': '0',
                                    'usage_reset_date': (current_period_start + timedelta(days=30)).isoformat(),
                                    **{k: v for k, v in customer_metadata.items() if k not in ['monthly_usage', 'usage_reset_date']}
                                }
                            )
                            usage_count = 0
                    except (ValueError, TypeError) as e:
                        print(f"Error checking usage reset for subscription: {e}")
        except Exception as e:
            print(f"Error checking current_period_start: {e}")
        
        # Get the plan information
        if hasattr(subscription, 'plan') and subscription.plan and subscription.plan.active:
            plan_id = subscription.plan.product
            # Map the plan ID to our internal plan names
            # This would need customization based on your Stripe product/price setup
            plan_mapping = {
                'prod_S7BfdlxGIF1K9m': 'pro',
                'prod_S7Bfpjd9lmQnpD': 'premium'
            }
            plan = plan_mapping.get(plan_id, '')  # Default to pro if unknown
        
        # Calculate next billing date for response
        current_period_end = None
        try:
            if hasattr(subscription, 'current_period_end') and subscription.current_period_end:
                current_period_end = datetime.fromtimestamp(subscription.current_period_end)
        except Exception as e:
            print(f"Error getting current_period_end: {e}")
        
        print(f"Found active subscription for customer {customer.email}, plan: {plan}, status: {subscription.status}, id: {subscription.id}, usage: {usage_count}")
        
        return {
            "plan": plan,
            "status": subscription.status,
            "subscription_id": subscription.id,
            "customer_id": customer.id,
            "current_period_end": current_period_end,
            "is_subscription": True,
            "usage_count": usage_count
        }
    
    except Exception as e:
        print(f"Error checking subscription with Stripe: {e}")
        return None

# Create rate limiter
rate_limiter = RateLimiter(limit=15, per_minutes=1)

# Create client
genai_client = genai.Client(
    api_key=os.environ.get("GOOGLE_API_KEY", "AIzaSyAgp2q8WviHovN7vBmbLnfQoUMey0VeB50"),
)

# Initialize cache (using a dictionary in Python)
summary_cache = {}
CACHE_TTL = 24 * 60 * 60  # 24 hours in seconds

# In-memory database for user tracking (switch to a real DB in production)
# Removing in-memory usage tracking - using Stripe as single source of truth
# user_usage = defaultdict(lambda: {"count": 0, "videos": set()})
user_subscriptions = {}
# Map to store client_reference_ids to emails
client_reference_map = {}

# Configuration
FREE_TIER_LIMIT = 2  # Number of free summaries per month
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
        user_email = request.args.get('email')
        
        if not user_email:
            return jsonify({
                "error": "Missing email parameter"
            }), 400
        
        # Check subscription status with Stripe
        subscription_info = check_subscription_with_stripe(user_email)
        has_subscription = subscription_info is not None
        
        # Get usage from Stripe
        usage_count = 0
        
        # If we have subscription info, it includes usage count
        if subscription_info and 'usage_count' in subscription_info:
            usage_count = subscription_info.get('usage_count', 0)
        else:
            # No subscription but may still have a customer record
            try:
                customers = stripe.Customer.list(email=user_email, limit=1)
                if customers and len(customers.data) > 0:
                    customer = customers.data[0]
                    customer_metadata = customer.metadata or {}
                    
                    if 'monthly_usage' in customer_metadata:
                        try:
                            usage_count = int(customer_metadata.get('monthly_usage', '0'))
                        except (ValueError, TypeError):
                            pass
            except Exception as e:
                print(f"Error checking customer usage in Stripe: {e}")
        
        if has_subscription:
            # Return subscription details for paid users
            plan = subscription_info.get('plan', 'pro')
            limit = 1500 if plan == 'premium' else 400
            
            # Handle expiry date safely
            expiry_date = None
            try:
                if subscription_info.get('is_subscription', False):
                    expiry_date = subscription_info.get('current_period_end')
                else:
                    expiry_date = subscription_info.get('expiry_date')
                
                # Format the date for response
                expiry_formatted = None
                if expiry_date:
                    if hasattr(expiry_date, 'isoformat'):
                        expiry_formatted = expiry_date.isoformat()
                    else:
                        expiry_formatted = str(expiry_date)
                else:
                    # Default to 30 days from now if no expiry date is available
                    expiry_formatted = (datetime.now() + timedelta(days=30)).isoformat()
            except Exception as e:
                print(f"Error formatting expiry date: {e}")
                # Default to 30 days from now if there's an error
                expiry_formatted = (datetime.now() + timedelta(days=30)).isoformat()
            
            return jsonify({
                "hasReachedLimit": False,
                "usage": {
                    "current": usage_count,
                    "limit": limit
                },
                "subscription": {
                    "plan": plan,
                    "expiresAt": expiry_formatted
                }
            })
        
        # For non-subscribed users, check if they've reached the free limit
        has_reached_limit = usage_count >= FREE_TIER_LIMIT
        print(f"usage_count: {usage_count} (Stripe: {usage_count})")
        
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
        email = data.get('email')
        video_id = data.get('videoId')
        
        if not email or not video_id:
            return jsonify({
                "error": "Missing required parameters"
            }), 400
        
        # Check for subscription in the request
        client_subscription = data.get('subscription')
        has_subscription = False
        subscription_info = None
        
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
                        subscription_info = {
                            "plan": plan,
                            "expiry_date": expiry_date,
                            "is_subscription": False
                        }
                except Exception as e:
                    print(f"Error parsing client subscription data in usage tracking: {e}")
        
        # If no valid client subscription, check with Stripe
        if not has_subscription:
            stripe_subscription = check_subscription_with_stripe(email)
            if stripe_subscription:
                has_subscription = True
                subscription_info = stripe_subscription
        
        # For tracking in Stripe, we need to determine if the user exists as a customer
        stripe_customer_id = None
        current_usage_count = 0
        customer_metadata = {}
        video_ids_set = set()
        
        if subscription_info and subscription_info.get('customer_id'):
            # User is already a customer in Stripe
            stripe_customer_id = subscription_info.get('customer_id')
            current_usage_count = subscription_info.get('usage_count', 0)
        else:
            # Check if user exists in Stripe
            try:
                customers = stripe.Customer.list(email=email, limit=1)
                if customers and len(customers.data) > 0:
                    customer = customers.data[0]
                    stripe_customer_id = customer.id
                    customer_metadata = customer.metadata or {}
                    
                    # Get current usage count
                    if 'monthly_usage' in customer_metadata:
                        try:
                            current_usage_count = int(customer_metadata.get('monthly_usage', '0'))
                        except (ValueError, TypeError):
                            current_usage_count = 0
                            
                    # Get tracked video IDs if they exist
                    if 'viewed_videos' in customer_metadata:
                        try:
                            video_ids_json = customer_metadata.get('viewed_videos', '[]')
                            video_ids_set = set(json.loads(video_ids_json))
                        except (ValueError, TypeError, json.JSONDecodeError):
                            video_ids_set = set()
            except Exception as e:
                print(f"Error checking if customer exists in Stripe: {e}")
        
        # If no Stripe customer yet, create one
        if not stripe_customer_id:
            try:
                customer = stripe.Customer.create(
                    email=email,
                    name=email.split('@')[0] if '@' in email else email,  # Use part before @ as name
                    metadata={
                        'monthly_usage': '0',
                        'usage_reset_date': (datetime.now() + timedelta(days=30)).isoformat(),
                        'created_date': datetime.now().isoformat(),
                        'viewed_videos': '[]'
                    }
                )
                stripe_customer_id = customer.id
                print(f"Created new customer in Stripe: {stripe_customer_id}")
            except Exception as e:
                print(f"Error creating customer in Stripe: {e}")
        
        # Check for duplicate tracking of the same video
        is_duplicate = video_id in video_ids_set
        
        if not is_duplicate:
            # Add video to the set and update the set in Stripe
            video_ids_set.add(video_id)
            
            # Also update usage in Stripe if we have a customer ID
            if stripe_customer_id:
                try:
                    # Update usage in Stripe
                    new_usage = current_usage_count + 1
                    
                    # Get existing metadata to preserve other fields
                    try:
                        if not customer_metadata:
                            customer = stripe.Customer.retrieve(stripe_customer_id)
                            customer_metadata = customer.metadata or {}
                    except Exception as e:
                        print(f"Error retrieving customer metadata: {e}")
                    
                    # Update the customer with new usage count and viewed videos
                    stripe.Customer.modify(
                        stripe_customer_id,
                        metadata={
                            'monthly_usage': str(new_usage),
                            'viewed_videos': json.dumps(list(video_ids_set)),
                            **{k: v for k, v in customer_metadata.items() if k not in ['monthly_usage', 'viewed_videos']}
                        }
                    )
                    print(f"Updated usage count in Stripe for {email}: {new_usage}")
                    current_usage_count = new_usage
                except Exception as e:
                    print(f"Error updating usage in Stripe: {e}")
        
        # If the user has a subscription, include that info in the response
        response_data = {
            "success": True,
            "usage": {
                "current": current_usage_count
            }
        }
        
        if has_subscription:
            # For paid users, get the limit based on plan
            plan = subscription_info.get('plan', 'pro')
            limit = 1500 if plan == 'premium' else 400
            
            response_data["usage"]["limit"] = limit
            
            # Handle expiry date safely
            try:
                # Prepare subscription data for response
                expiry_date = None
                if subscription_info.get('is_subscription', False):
                    expiry_date = subscription_info.get('current_period_end')
                else:
                    expiry_date = subscription_info.get('expiry_date')
                
                # Format the date for response
                expiry_formatted = None
                if expiry_date:
                    if hasattr(expiry_date, 'isoformat'):
                        expiry_formatted = expiry_date.isoformat()
                    else:
                        expiry_formatted = str(expiry_date)
                else:
                    # Default to 30 days from now if no expiry date is available
                    expiry_formatted = (datetime.now() + timedelta(days=30)).isoformat()
                
                response_data["subscription"] = {
                    "plan": plan,
                    "expiresAt": expiry_formatted
                }
            except Exception as e:
                print(f"Error formatting expiry date in track_usage: {e}")
                # Default to 30 days from now if there's an error
                expiry_formatted = (datetime.now() + timedelta(days=30)).isoformat()
                response_data["subscription"] = {
                    "plan": plan,
                    "expiresAt": expiry_formatted
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
@app.route('/payment-result', methods=['GET'])
def payment_result():
    """Handle payment result redirects from Stripe payment links."""
    # Get parameters from the redirect URL
    plan = request.args.get('plan', 'pro')
    extension_id = request.args.get('extension_id')
    client_reference_id = request.args.get('utm_source')
    user_email = request.args.get('user_email')
    session_id = request.args.get('session_id')
    
    # For debugging
    print(f"Payment result received with: plan={plan}, extension_id={extension_id}, client_reference_id={client_reference_id}, user_email={user_email}, session_id={session_id}")
    
    # Variables to track payment status
    payment_status = "failed"
    payment_error = None
    email = None
    
    # Verify checkout session with Stripe if session_id is provided
    if session_id:
        try:
            # Retrieve the session from Stripe to verify its status
            checkout_session = stripe.checkout.Session.retrieve(session_id)
            
            # Check if payment was successful
            if checkout_session.payment_status == 'paid':
                payment_status = "success"
                
                # Get subscription details from the session
                if checkout_session.metadata:
                    if 'plan' in checkout_session.metadata:
                        plan = checkout_session.metadata.get('plan')
                    if 'email' in checkout_session.metadata:
                        email = checkout_session.metadata.get('email')
                
                # If customer email is available in the session, use it
                if hasattr(checkout_session, 'customer_details') and checkout_session.customer_details:
                    if not email and hasattr(checkout_session.customer_details, 'email'):
                        email = checkout_session.customer_details.email
                
                print(f"Payment verified successful for session {session_id}")
            else:
                payment_error = f"Payment not completed. Status: {checkout_session.payment_status}"
                print(f"Payment verification failed: {payment_error}")
        except Exception as e:
            payment_error = f"Error verifying payment: {str(e)}"
            print(f"Error verifying checkout session: {e}")
    else:
        payment_error = "No session ID provided"
        print("Warning: No session ID provided for payment verification")
    
    # If session verification failed, also try to get email from client_reference_id
    if (payment_status == "success" and not email) or payment_status == "failed":
        # Determine the user's email from client_reference_id or direct parameter
        
        # Try to decrypt client_reference_id if it exists
        if client_reference_id:
            try:
                # Decode from URL-safe base64 back to encrypted data
                encrypted_data = base64.urlsafe_b64decode(client_reference_id).decode()
                
                # Decrypt the data
                decrypted_data = cipher_suite.decrypt(encrypted_data.encode()).decode()
                
                # Parse the decrypted data
                parts = decrypted_data.split('|')
                if len(parts) >= 3:
                    timestamp, email, plan_from_ref = parts[0], parts[1], parts[2]
                    # Only override plan if we didn't get it from the session
                    if payment_status != "success" or not plan:
                        plan = plan_from_ref
                    print(f"Successfully decrypted client ID: timestamp={timestamp}, email={email}, plan={plan}")
                
                # Also check if it exists in our map
                if client_reference_id in client_reference_map:
                    client_data = client_reference_map[client_reference_id]
                    # Mark this client_reference_id as used
                    client_data['used'] = True
                    client_data['used_at'] = datetime.now().isoformat()
                    client_data['extension_id'] = extension_id
                    
                    print(f"Found client reference in map: {client_data}")
            except Exception as e:
                print(f"Error decrypting client reference ID: {e}")
        
        # If no email found from decryption, use the one from URL parameter
        if not email and user_email:
            email = user_email
            print(f"Using email from URL parameter: {email}")
    
    # Return either a success or failure page based on payment status
    if payment_status == "success":
        # Return HTML success page with script to communicate with extension
        return render_template_string("""
<!DOCTYPE html>
<html>
<head>
    <title>Payment Successful</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f9f9f9;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        .container {
            max-width: 600px;
            padding: 30px;
            background: white;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            text-align: center;
        }
        h1 {
            color: #4CAF50;
        }
        .loader {
            border: 5px solid #f3f3f3;
            border-top: 5px solid #4CAF50;
            border-radius: 50%;
            width: 50px;
            height: 50px;
            animation: spin 2s linear infinite;
            margin: 20px auto;
        }
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        button {
            background-color: #4CAF50;
            color: white;
            border: none;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 20px 0;
            cursor: pointer;
            border-radius: 5px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Payment Successful!</h1>
        <p>Thank you for upgrading to our {{ plan|capitalize }} plan.</p>
        <p>Your subscription has been activated.</p>
        
        <div id="status">
            <p>Communicating with extension...</p>
            <div class="loader"></div>
        </div>
        
        <div id="complete" style="display: none;">
            <p>All set! You can now close this tab and return to YouTube.</p>
            <button onclick="tryCloseTab()">Close Tab</button>
            <p style="margin-top: 10px; font-size: 14px;">If the button doesn't work, you can simply close this tab manually.</p>
            <a href="https://youtube.com" style="display: block; margin-top: 15px; color: #4CAF50; text-decoration: underline;">Or return to YouTube</a>
        </div>
    </div>

    <script>
        // Try to communicate with extension
        window.onload = function() {
            setTimeout(function() {
                try {
                    // Send message to extension about successful payment
                    chrome.runtime.sendMessage("{{ extension_id }}", 
                        {
                            action: "paymentSuccess",
                            plan: "{{ plan }}",
                            startDate: "{{ start_date }}",
                            expiryDate: "{{ expiry_date }}",
                            email: "{{ email }}"
                        }, 
                        function(response) {
                            document.getElementById("status").style.display = "none";
                            document.getElementById("complete").style.display = "block";
                            
                            if (response && response.success) {
                                console.log("Extension acknowledged payment success");
                            } else {
                                console.warn("Extension did not acknowledge message");
                            }
                        }
                    );
                } catch (e) {
                    console.error("Error communicating with extension:", e);
                    document.getElementById("status").style.display = "none";
                    document.getElementById("complete").style.display = "block";
                }
                
                // Show completion regardless after a timeout
                setTimeout(function() {
                    document.getElementById("status").style.display = "none";
                    document.getElementById("complete").style.display = "block";
                }, 5000);
            }, 1000);
        };
        
        // Function to try closing the tab with fallback messaging
        function tryCloseTab() {
            try {
                window.close();
                
                // If we're still here after a moment, window.close() didn't work
                setTimeout(function() {
                    alert("Please close this tab manually to return to YouTube.");
                }, 300);
            } catch (e) {
                console.error("Error closing tab:", e);
                alert("Please close this tab manually to return to YouTube.");
            }
        }
    </script>
</body>
</html>
    """, 
    plan=plan, 
    extension_id=extension_id,
    start_date=datetime.now().isoformat(),
    expiry_date=(datetime.now() + timedelta(days=SUBSCRIPTION_PLANS[plan]["duration"])).isoformat(),
    email=email or "User"
    )
    else:
        # Return HTML failure page
        return render_template_string("""
<!DOCTYPE html>
<html>
<head>
    <title>Payment Failed</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f9f9f9;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        .container {
            max-width: 600px;
            padding: 30px;
            background: white;
            border-radius: 10px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            text-align: center;
        }
        h1 {
            color: #f44336;
        }
        .error-icon {
            color: #f44336;
            font-size: 48px;
            margin-bottom: 20px;
        }
        button {
            background-color: #4CAF50;
            color: white;
            border: none;
            padding: 10px 20px;
            text-align: center;
            text-decoration: none;
            display: inline-block;
            font-size: 16px;
            margin: 20px 0;
            cursor: pointer;
            border-radius: 5px;
        }
        a {
            color: #4CAF50;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">⚠️</div>
        <h1>Payment Failed</h1>
        <p>We were unable to process your payment.</p>
        <p>Error: {{ error }}</p>
        
        <p>Please try again or contact support if the problem persists.</p>
        
        <p style="margin-top: 20px;">
            <a href="https://youtube.com">Return to YouTube</a>
        </p>
    </div>
</body>
</html>
    """, 
    error=payment_error or "Unable to verify payment",
    email=email or user_email or ""
    )

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
                except Exception as e:
                    print(f"Error parsing client subscription data: {e}")
        
        # If no valid client subscription, check with Stripe
        if not has_subscription and user_id:
            stripe_subscription = check_subscription_with_stripe(user_id)
            if stripe_subscription:
                has_subscription = True
                print(f"Valid subscription found in Stripe: {stripe_subscription.get('plan')}")
        
        # If no subscription, check if they've reached the free limit
        if not has_subscription:
            # Check usage count from Stripe
            usage_count = 0
            
            if user_id:
                try:
                    # Try to get usage from Stripe
                    customers = stripe.Customer.list(email=user_id, limit=1)
                    if customers and len(customers.data) > 0:
                        customer = customers.data[0]
                        customer_metadata = customer.metadata or {}
                        
                        if 'monthly_usage' in customer_metadata:
                            try:
                                usage_count = int(customer_metadata.get('monthly_usage', '0'))
                                print(f"Got usage count from Stripe: {usage_count}")
                            except (ValueError, TypeError) as e:
                                print(f"Error parsing usage count from Stripe: {e}")
                except Exception as e:
                    print(f"Error checking usage in Stripe: {e}")
            
            # Check if they've reached the limit
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
        
        # Reduce timestamp density
        compact_transcript = reduce_timestamp_density(compact_transcript,20)
        
        # Generate streaming response
        def generate():
            # Generate summary using Google's Generative AI API with streaming
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
[List **between 10 and 20** key moments/topic shifts, adjusted for video length/density per Task #2. Each MUST have a starting timestamp `[HH:MM:SS]` (preferred for >1hr) or `[MM:SS]` and a *very brief* description (max ~7-10 words). **Ensure timestamps demonstrate significant progression covering the FULL duration, with representation from the final segments.**]
*   `[HH:MM:SS]` - [Key moment/topic - early]
*   `[HH:MM:SS]` - [Key moment/topic - early-middle]
*   *... (additional points distributed through middle sections)*
*   `[HH:MM:SS]` - [Key moment/topic - late-middle]
*   `[HH:MM:SS]` - [Key moment/topic - **late / near end**]
*   `[HH:MM:SS]` - [Key moment/topic - **potentially from final discussion**]

**Tone:** Highly economical, factual, and neutral. Prioritize extreme brevity *for each highlight description*. Ensure descriptions capture the essence of the point despite their short length. **Adherence to full duration highlight distribution, especially including the final stages of long content, is paramount. Verify the last highlight timestamp reflects content near the actual end.**
                     '''
            
            if "start" in transcript[-1] and transcript[-1]["start"] < 1800:
                print("Video is less than 30 minutes")
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

            print(compact_transcript)
            
            # Start streaming response
            response = genai_client.models.generate_content_stream(
                model="gemini-2.0-flash-lite",
                contents=core_prompt
            )
            
            summary = ""
            model_used = ""  # Default model name
            # print response body
            for chunk in response:
                if hasattr(chunk, 'text') and chunk.text:
                    content = chunk.text
                    summary += content
                    # Send the chunk to the client with consistent formatting
                    chunk_response = json.dumps({"chunk": content, "done": False})
                    yield chunk_response + '\n'
        

            # Print all available data from the response
            print("\n=== FULL RESPONSE DATA ===")
            print(f"Response type: {type(response)}")
            print(f"Response dir: {dir(response)}")
            
            # Cache the complete summary
            summary_cache[video_id] = summary
            
            # Set up cache expiration
            def remove_from_cache():
                if video_id in summary_cache:
                    del summary_cache[video_id]
            
            t = threading.Timer(CACHE_TTL, remove_from_cache)
            t.daemon = True
            t.start()
            
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
        extension_id = str(uuid.uuid4())
        
        # Create a checkout session with Stripe
        try:
            # Create the session
            checkout_session = stripe.checkout.Session.create(
                payment_method_types=['card'],
                line_items=[{
                    'price_data': {
                        'currency': 'usd',
                        'product_data': {
                            'name': plan["name"],
                            'description': f"YouTube TLDR {plan['name']} subscription",
                        },
                        'unit_amount': plan["price"],
                    },
                    'quantity': 1,
                }],
                mode='payment',
                success_url=request.url_root + 'payment-result?session_id={CHECKOUT_SESSION_ID}&plan=' + plan_id + '&extension_id=' + extension_id + '&user_email=' + user_id,
                cancel_url=request.url_root + 'payment?userId=' + user_id,
                metadata={
                    'userId': user_id,
                    'plan': plan_id,
                    'email': user_id if '@' in user_id else None
                },
            )
            
            # Return a simple page that redirects to Stripe checkout
            return render_template_string("""
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Redirecting to Checkout...</title>
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
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            height: 100vh;
                        }
                        .container {
                            max-width: 600px;
                            padding: 30px;
                            background: white;
                            border-radius: 10px;
                            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                            text-align: center;
                        }
                        h2 {
                            color: #4a6cf7;
                        }
                        .loader {
                            border: 5px solid #f3f3f3;
                            border-top: 5px solid #4a6cf7;
                            border-radius: 50%;
                            width: 50px;
                            height: 50px;
                            animation: spin 2s linear infinite;
                            margin: 20px auto;
                        }
                        @keyframes spin {
                            0% { transform: rotate(0deg); }
                            100% { transform: rotate(360deg); }
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h2>Redirecting to Secure Checkout</h2>
                        <p>Please wait while we redirect you to our secure payment page...</p>
                        <div class="loader"></div>
                        <p style="margin-top: 20px; font-size: 14px;">If you are not redirected automatically, please click the button below:</p>
                        <button id="checkout-button" style="background-color: #4a6cf7; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Go to Checkout</button>
                    </div>

                    <script>
                        var stripe = Stripe('{{ stripe_public_key }}');
                        var checkoutButton = document.getElementById('checkout-button');
                        
                        // Redirect to Stripe Checkout on page load
                        window.onload = function() {
                            redirectToCheckout();
                        };
                        
                        // Also handle click on button as fallback
                        checkoutButton.addEventListener('click', function() {
                            redirectToCheckout();
                        });
                        
                        function redirectToCheckout() {
                            stripe.redirectToCheckout({
                                sessionId: '{{ session_id }}'
                            }).then(function (result) {
                                if (result.error) {
                                    // If redirectToCheckout fails due to a browser or network error
                                    alert(result.error.message);
                                }
                            });
                        }
                    </script>
                </body>
                </html>
            """, 
            session_id=checkout_session.id,
            stripe_public_key=os.getenv('STRIPE_PUBLIC_KEY', 'pk_test_TYooMQauvdEDq54NiTphI7jx')
            )
            
        except Exception as e:
            logging.error(f"Error creating checkout session: {str(e)}")
            return f"An error occurred while setting up payment: {str(e)}", 500
    
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
        extension_id = data.get('extensionId', str(uuid.uuid4()))
        
        # Create a Checkout Session with Stripe
        success_url = request.url_root + 'payment-result?session_id={CHECKOUT_SESSION_ID}&plan=' + plan_id + '&extension_id=' + extension_id
        cancel_url = request.url_root + 'payment?userId=' + user_id
        
        # Create the session
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {
                        'name': plan["name"],
                        'description': f"YouTube TLDR {plan['name']} subscription",
                    },
                    'unit_amount': plan["price"],
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=success_url,
            cancel_url=cancel_url,
            metadata={
                'userId': user_id,
                'plan': plan_id,
                'email': user_id if '@' in user_id else None
            },
        )
        
        return jsonify({
            "sessionId": checkout_session.id,
            "url": checkout_session.url
        })
    
    except Exception as e:
        logging.error(f"Error creating checkout session: {str(e)}")
        return jsonify({"error": "Failed to create checkout session", "details": str(e)}), 500

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

@app.route('/generate-client-id', methods=['POST'])
def generate_client_id():
    """Generate a unique client reference ID for Stripe checkout and map it to the user's email."""
    try:
        data = request.json
        email = data.get('email')
        plan = data.get('plan', 'pro')  # Default to 'pro' if not specified
        
        if not email:
            return jsonify({"error": "Email is required"}), 400
        
        # Generate a unique client reference ID with timestamp, plan and email
        timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
        
        # Create a string containing all the information we want to encrypt
        client_data = f"{timestamp}|{email}|{plan}"
        
        # Encrypt the data
        encrypted_data = cipher_suite.encrypt(client_data.encode()).decode()
        
        # Generate a shorter version that's URL-safe
        # We'll use base64 encoding and remove special chars
        client_id = base64.urlsafe_b64encode(encrypted_data.encode()).decode()
        
        # Store the mapping of client_id to email and plan
        client_reference_map[client_id] = {
            'email': email,
            'plan': plan,
            'created_at': timestamp,
            'used': False
        }
        
        print(f"Generated encrypted client ID for email {email} with plan {plan}")
        
        return jsonify({
            "clientReferenceId": client_id,
            "email": email,
            "plan": plan
        })
        
    except Exception as e:
        print(f"Error generating client ID: {e}")
        return jsonify({"error": f"Failed to generate client ID: {str(e)}"}), 500

# Route to handle Stripe payment success redirects (compatibility redirect)
@app.route('/payment-success', methods=['GET'])
def payment_success_redirect():
    """Redirect old /payment-success URLs to /payment-result for backward compatibility."""
    # Forward all query parameters 
    args = request.args.to_dict()
    query_string = '&'.join([f"{k}={v}" for k, v in args.items()])
    
    # Redirect to the new endpoint with all original query parameters
    return redirect(url_for('payment_result') + '?' + query_string, code=301)

def reduce_timestamp_density(transcript, max_time_gap=5):
    """
    Reduces the density of timestamps in a transcript by combining segments that are close in time.
    
    Args:
        transcript: List of dicts with 'text' and 'timestamp' keys
        max_time_gap: Maximum time gap in seconds between segments to combine
        
    Returns:
        List of dicts with reduced timestamp density
    """
    if not transcript or len(transcript) <= 1:
        return transcript
    
    # Convert timestamps to seconds for easier comparison
    def timestamp_to_seconds(ts):
        try:
            parts = ts.split(':')
            if len(parts) == 3:
                hours, minutes, seconds = map(float, parts)
                return hours * 3600 + minutes * 60 + seconds
            elif len(parts) == 2:
                minutes, seconds = map(float, parts)
                return minutes * 60 + seconds
            else:
                return float(ts)
        except (ValueError, AttributeError):
            return 0
    
    reduced_transcript = []
    current_segment = {
        'text': transcript[0]['text'],
        'timestamp': transcript[0]['timestamp']
    }
    current_time = timestamp_to_seconds(transcript[0]['timestamp'])
    
    for i in range(1, len(transcript)):
        segment = transcript[i]
        next_time = timestamp_to_seconds(segment['timestamp'])
        
        # If the time gap is small enough, combine segments
        if next_time - current_time <= max_time_gap:
            current_segment['text'] += ' ' + segment['text']
        else:
            # Add the current segment to results and start a new one
            reduced_transcript.append(current_segment)
            current_segment = {
                'text': segment['text'],
                'timestamp': segment['timestamp']
            }
            current_time = next_time
    
    # Add the last segment
    reduced_transcript.append(current_segment)
    
    return reduced_transcript

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3000, debug=True)