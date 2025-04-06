const fetch = require('node-fetch');

// Constants
const WATCH_URL = 'https://www.youtube.com/watch?v={video_id}';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

// Custom Error classes
class YouTubeTranscriptError extends Error {
  constructor(message) {
    super(`[YouTubeTranscript] 🚨 ${message}`);
    this.name = 'YouTubeTranscriptError';
  }
}

class InvalidVideoIdError extends YouTubeTranscriptError {
  constructor(videoId) {
    super(`Invalid YouTube video ID: ${videoId}`);
    this.name = 'InvalidVideoIdError';
  }
}

class TooManyRequestsError extends YouTubeTranscriptError {
  constructor(videoId) {
    super(`Too many requests for video ${videoId}. YouTube is showing a captcha.`);
    this.name = 'TooManyRequestsError';
  }
}

class VideoUnavailableError extends YouTubeTranscriptError {
  constructor(videoId) {
    super(`The video is no longer available (${videoId})`);
    this.name = 'VideoUnavailableError';
  }
}

class TranscriptsDisabledError extends YouTubeTranscriptError {
  constructor(videoId) {
    super(`Transcript is disabled on this video (${videoId})`);
    this.name = 'TranscriptsDisabledError';
  }
}

class NoTranscriptAvailableError extends YouTubeTranscriptError {
  constructor(videoId) {
    super(`No transcripts are available for this video (${videoId})`);
    this.name = 'NoTranscriptAvailableError';
  }
}

class NoTranscriptFoundError extends YouTubeTranscriptError {
  constructor(videoId, languageCodes, availableTranscripts) {
    const message = `No transcript found for language codes: ${languageCodes.join(', ')} for video ${videoId}. Available transcripts: ${JSON.stringify(availableTranscripts)}`;
    super(message);
    this.name = 'NoTranscriptFoundError';
  }
}

// Main function to get transcript
async function getTranscript(videoId, languageCodes = ['en']) {
  try {
    // Validate video ID
    if (!videoId || !videoId.match(/^[A-Za-z0-9_-]{11}$/)) {
      throw new InvalidVideoIdError(videoId);
    }
    
    // Create a session-like object for cookies
    const session = {
      cookies: new Map(),
      async fetch(url, options = {}) {
        // In browser, cookies are managed automatically
        return fetch(url, options);
      }
    };
    
    // Fetch available transcripts (similar to TranscriptListFetcher)
    const transcriptList = await listTranscripts(session, videoId);
    
    // Find transcript in requested language (similar to TranscriptList.find_transcript)
    const transcript = findTranscript(transcriptList, languageCodes, videoId);
    
    // Fetch the actual transcript data (similar to Transcript.fetch)
    return await fetchTranscriptData(session, transcript);
    
  } catch (error) {
    console.error('Transcript fetch failed:', error);
    throw error;
  }
}

async function listTranscripts(session, videoId) {
  // Fetch the video page HTML (similar to TranscriptListFetcher._fetch_video_html)
  const html = await fetchVideoHtml(session, videoId);
  
  // Extract captions JSON (similar to TranscriptListFetcher._extract_captions_json)
  const captionsJson = extractCaptionsJson(html, videoId);
  
  // Build transcript list (similar to TranscriptList.build)
  const translationLanguages = captionsJson.translationLanguages ? 
    captionsJson.translationLanguages.map(lang => ({
      language: lang.languageName?.simpleText,
      language_code: lang.languageCode
    })) : [];
  
  const manuallyCreatedTranscripts = {};
  const generatedTranscripts = {};
  
  captionsJson.captionTracks.forEach(caption => {
    const isGenerated = caption.kind === 'asr';
    const targetDict = isGenerated ? generatedTranscripts : manuallyCreatedTranscripts;
    
    targetDict[caption.languageCode] = {
      videoId,
      baseUrl: caption.baseUrl,
      language: caption.name?.simpleText || caption.languageName?.simpleText || caption.languageCode,
      languageCode: caption.languageCode,
      isGenerated,
      isTranslatable: caption.isTranslatable === true,
      translationLanguages: caption.isTranslatable ? translationLanguages : []
    };
  });
  
  return {
    videoId,
    manuallyCreatedTranscripts,
    generatedTranscripts,
    translationLanguages
  };
}

async function fetchVideoHtml(session, videoId) {
  // First attempt to fetch the page
  let html = await fetchHtml(session, videoId);
  
  // Handle consent page if needed (similar to TranscriptListFetcher._create_consent_cookie)
  if (html.includes('action="https://consent.youtube.com/s"')) {
    const match = html.match(/name="v" value="(.*?)"/);
    if (!match) {
      throw new YouTubeTranscriptError(`Failed to create consent cookie for video ${videoId}`);
    }
    
    // In a browser environment, we might not be able to set cookies directly
    // Let's try to simulate this by setting a special header
    try {
      document.cookie = `CONSENT=YES+${match[1]}; domain=.youtube.com; path=/; secure; SameSite=None`;
    } catch (e) {
      console.warn('Could not set consent cookie:', e);
    }
    
    // Try again with consent
    html = await fetchHtml(session, videoId);
    if (html.includes('action="https://consent.youtube.com/s"')) {
      throw new YouTubeTranscriptError(`Failed to handle consent page for video ${videoId}`);
    }
  }
  
  return html;
}

async function fetchHtml(session, videoId) {
  const response = await session.fetch(WATCH_URL.replace('{video_id}', videoId), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US'
    }
  });
  
  if (!response.ok) {
    throw new YouTubeTranscriptError(`Failed to fetch video page: ${response.status}`);
  }
  
  return await response.text();
}

function extractCaptionsJson(html, videoId) {
  // Similar to TranscriptListFetcher._extract_captions_json
  const splittedHtml = html.split('"captions":');
  
  if (splittedHtml.length <= 1) {
    if (videoId.startsWith('http://') || videoId.startsWith('https://')) {
      throw new InvalidVideoIdError(videoId);
    }
    if (html.includes('class="g-recaptcha"')) {
      throw new TooManyRequestsError(videoId);
    }
    if (!html.includes('"playabilityStatus":')) {
      throw new VideoUnavailableError(videoId);
    }
    
    throw new TranscriptsDisabledError(videoId);
  }
  
  try {
    const captionsJson = JSON.parse(
      splittedHtml[1].split(',"videoDetails')[0].replace(/\n/g, '')
    ).playerCaptionsTracklistRenderer;
    
    if (!captionsJson) {
      throw new TranscriptsDisabledError(videoId);
    }
    
    if (!('captionTracks' in captionsJson)) {
      throw new NoTranscriptAvailableError(videoId);
    }
    
    return captionsJson;
  } catch (e) {
    throw new YouTubeTranscriptError(`Failed to parse captions JSON: ${e.message}`);
  }
}

function findTranscript(transcriptList, languageCodes, videoId) {
  // Similar to TranscriptList._find_transcript
  // Check both manually created and generated transcripts
  const transcriptDicts = [
    transcriptList.manuallyCreatedTranscripts,
    transcriptList.generatedTranscripts
  ];
  
  for (const languageCode of languageCodes) {
    for (const transcriptDict of transcriptDicts) {
      if (languageCode in transcriptDict) {
        return transcriptDict[languageCode];
      }
      
      // Try partial match (e.g., en-US for en)
      const partialMatch = Object.keys(transcriptDict).find(code => 
        code.startsWith(languageCode + '-')
      );
      
      if (partialMatch) {
        return transcriptDict[partialMatch];
      }
    }
  }
  
  // If we reach here, no transcript was found
  // Create a list of available transcripts for the error message
  const availableLanguages = {
    manual: Object.keys(transcriptList.manuallyCreatedTranscripts),
    generated: Object.keys(transcriptList.generatedTranscripts)
  };
  
  throw new NoTranscriptFoundError(videoId, languageCodes, availableLanguages);
}

async function fetchTranscriptData(session, transcript) {
  // Similar to Transcript.fetch
  const response = await session.fetch(transcript.baseUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US'
    }
  });
  
  if (!response.ok) {
    throw new YouTubeTranscriptError(`Failed to fetch transcript: ${response.status}`);
  }
  
  const transcriptText = await response.text();
  return parseTranscriptXml(transcriptText);
}

function parseTranscriptXml(xmlText, preserveFormatting = false) {
  // Similar to _TranscriptParser.parse
  const results = [...xmlText.matchAll(RE_XML_TRANSCRIPT)];
  
  return results.map(result => ({
    text: unescapeHtml(result[3], preserveFormatting),
    start: parseFloat(result[1]),
    duration: parseFloat(result[2]),
    end: parseFloat(result[1]) + parseFloat(result[2])
  }));
}

function unescapeHtml(html, preserveFormatting = false) {
  // Simplified version of _html_unescaping.unescape
  const formattingTags = ['strong', 'em', 'b', 'i', 'mark', 'small', 'del', 'ins', 'sub', 'sup'];
  
  let cleanHtml = html;
  if (preserveFormatting) {
    const formatsRegex = formattingTags.join('|');
    const regex = new RegExp(`<\\/?(?!\\/?(?:${formatsRegex})\\b)[^>]*>`, 'gi');
    cleanHtml = cleanHtml.replace(regex, '');
  } else {
    cleanHtml = cleanHtml.replace(/<[^>]*>/g, '');
  }
  
  // Unescape HTML entities
  const doc = new DOMParser().parseFromString(cleanHtml, 'text/html');
  return doc.body.textContent;
}

// Modified to accept a videoId parameter
async function testTranscript(videoId = "dQw4w9WgXcQ") {
  try {
    console.log(`Fetching transcript for video: ${videoId}`);
    
    const transcript = await getTranscript(videoId, ['en']);
    console.log(`Transcript fetched successfully. ${transcript.length} segments found.`);
    
    // Display first few segments as preview
    transcript.slice(0, 5).forEach((segment, index) => {
      console.log(`[${index + 1}] [${formatTime(segment.start)}] ${segment.text}`);
    });
    
    return transcript;
  } catch (error) {
    console.error('Error fetching transcript:', error);
    return null;
  }
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Export functions
module.exports = {
  getTranscript,
  testTranscript
};

// If running directly, use command line argument if provided
if (typeof require !== 'undefined' && require.main === module) {
  const customVideoId = process.argv[2]; // Get video ID from command line
  testTranscript(customVideoId || undefined);
}

// Copy of the relevant functions from content.js
async function getYouTubeTranscript(videoId) {
    try {
        console.log(`Fetching transcript for video: ${videoId}`);
        const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`);
        const html = await response.text();
        console.log('Got video page, length:', html.length);

        // Extract ytInitialPlayerResponse instead of ytInitialData
        const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (!playerResponseMatch) {
            console.error('Could not find ytInitialPlayerResponse in the page');
            throw new Error('Could not find transcript data');
        }

        const playerResponse = JSON.parse(playerResponseMatch[1]);
        console.log('Found ytInitialPlayerResponse');

        // Find captions data directly in playerResponse
        const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer;
        if (!captions || !captions.captionTracks || captions.captionTracks.length === 0) {
            console.error('No caption tracks found in:', JSON.stringify(playerResponse?.captions, null, 2));
            throw new Error('No captions available');
        }

        console.log('Available caption tracks:', captions.captionTracks.map(track => ({
            language: track.languageCode,
            name: track.name?.simpleText,
            kind: track.kind,
            isTranslatable: track.isTranslatable,
            url: track.baseUrl
        })));

        // Get English or first available track
        const captionTrack = captions.captionTracks.find(track => 
            track.languageCode.startsWith('en')
        ) || captions.captionTracks[0];

        if (!captionTrack) {
            throw new Error('No suitable caption track found');
        }

        console.log('Selected caption track:', {
            language: captionTrack.languageCode,
            name: captionTrack.name?.simpleText,
            kind: captionTrack.kind,
            url: captionTrack.baseUrl
        });

        // Fetch the transcript
        const transcriptResponse = await fetch(captionTrack.baseUrl);
        const transcriptText = await transcriptResponse.text();
        console.log('Got transcript XML, length:', transcriptText.length);

        // Parse the XML
        const transcriptEntries = transcriptText.match(/<text.+?<\/text>/g);
        if (!transcriptEntries) {
            console.error('No transcript entries found in XML:', transcriptText.substring(0, 200) + '...');
            throw new Error('Failed to parse transcript');
        }

        const transcript = transcriptEntries.map(entry => {
            const startMatch = entry.match(/start="([\d.]+)"/);
            const durationMatch = entry.match(/dur="([\d.]+)"/);
            const textMatch = entry.match(/>(.+?)</);

            if (!startMatch || !durationMatch || !textMatch) {
                console.error('Failed to parse entry:', entry);
                return null;
            }

            return {
                text: textMatch[1].replace(/&amp;/g, '&')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'"),
                start: parseFloat(startMatch[1]),
                duration: parseFloat(durationMatch[1])
            };
        }).filter(Boolean);

        console.log('Parsed transcript entries:', transcript.length);
        console.log('First 3 entries:', transcript.slice(0, 3));

        return transcript;
    } catch (error) {
        console.error('Transcript fetch failed:', error);
        throw error;
    }
}

// Test function
async function testTranscript() {
    const videoId = process.argv[2] || 'f-2_wQ1mb6A';
    console.log(`\nTesting transcript fetch for video: ${videoId}\n`);
    
    try {
        const transcript = await getYouTubeTranscript(videoId);
        console.log('\nSuccess! Found', transcript.length, 'transcript entries');
        return transcript;
    } catch (error) {
        console.error('\nTest failed:', error);
        return null;
    }
}

// Run the test
testTranscript();
