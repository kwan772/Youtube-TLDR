from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
import os
import io
from youtube_transcript_api import YouTubeTranscriptApi
import json

# You need these scopes for accessing caption data
SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl']

def get_authenticated_service():
    credentials = None
    # Token file stores the user's credentials from previously successful logins
    if os.path.exists('token.json'):
        credentials = Credentials.from_authorized_user_file('token.json', SCOPES)
    
    # If there are no valid credentials available, let the user log in
    if not credentials or not credentials.valid:
        if credentials and credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
        else:
            # You need to create a client_secrets.json file from Google Cloud Console
            flow = InstalledAppFlow.from_client_secrets_file(
                'client_secrets.json', SCOPES)
            credentials = flow.run_local_server(port=0)
        
        # Save the credentials for the next run
        with open('token.json', 'w') as token:
            token.write(credentials.to_json())
    
    # Build the YouTube API client
    return build('youtube', 'v3', credentials=credentials)

def get_caption_track_ids(youtube, video_id):
    # First, we need to get the caption track IDs for the video
    captions_response = youtube.captions().list(
        part='snippet',
        videoId=video_id
    ).execute()
    
    caption_tracks = []
    for item in captions_response.get('items', []):
        caption_id = item['id']
        language = item['snippet']['language']
        track_name = item['snippet'].get('name', 'Default')
        is_auto = item['snippet'].get('trackKind') == 'ASR'  # Auto-generated captions
        
        caption_tracks.append({
            'id': caption_id,
            'language': language,
            'name': track_name,
            'is_auto': is_auto
        })
    
    return caption_tracks

def download_caption(youtube, caption_id, output_format='srt'):
    # Valid formats: sbv, scc, srt, ttml, vtt
    if output_format not in ['sbv', 'scc', 'srt', 'ttml', 'vtt']:
        raise ValueError(f"Invalid format: {output_format}. Use one of: sbv, scc, srt, ttml, vtt")
    
    request = youtube.captions().download(
        id=caption_id,
        tfmt=output_format
    )
    
    # Create a BytesIO object to store the downloaded caption
    caption_file = io.BytesIO()
    downloader = MediaIoBaseDownload(caption_file, request)
    
    done = False
    while not done:
        status, done = downloader.next_chunk()
        print(f"Download progress: {int(status.progress() * 100)}%")
    
    # Reset the file pointer to the beginning
    caption_file.seek(0)
    return caption_file.read().decode('utf-8')

def test_transcript(video_id):
    try:
        # First, let's see what transcripts are available
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        
        print(f"\nAvailable transcripts for video {video_id}:")
        for transcript in transcript_list:
            print(f"- Language: {transcript.language} ({transcript.language_code})")
            print(f"  Generated: {'Yes' if transcript.is_generated else 'No'}")
            print(f"  Translation: {'Yes' if transcript.is_translatable else 'No'}")
        
        # Try to get English transcript first
        try:
            transcript = YouTubeTranscriptApi.get_transcript(video_id, languages=['en'])
            print("\nFound English transcript!")
        except Exception as e:
            print("\nFailed to get English transcript, trying any available transcript...")
            # If English fails, get the first available transcript
            transcript = YouTubeTranscriptApi.get_transcript(video_id)
        
        # Print first few entries of transcript
        print("\nFirst 3 entries of transcript:")
        for entry in transcript[:3]:
            print(json.dumps(entry, indent=2))
        
        print(f"\nTotal transcript entries: {len(transcript)}")
        return transcript
        
    except Exception as e:
        print(f"\nError: {str(e)}")
        return None

if __name__ == "__main__":
    # VIDEO_ID = "uGrBHohIgQY"  # The video ID you're having trouble with
    # print(f"Testing transcript fetch for video: {VIDEO_ID}")
    # transcript = test_transcript(VIDEO_ID)

    from cryptography.fernet import Fernet
    key = Fernet.generate_key()
    print(key.decode())