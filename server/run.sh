#!/bin/bash

# Load environment variables from .env file if it exists
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Set default Google API key if not provided
if [ -z "$GOOGLE_API_KEY" ]; then
    export GOOGLE_API_KEY="AIzaSyAASCCmGK0EoxtvaWnWdC9ZZgw5xowlZrk"
    echo "Using default Google API key"
fi

export FLASK_APP=app.py
export FLASK_ENV=development
python -m flask run --host=0.0.0.0 --port=3000 