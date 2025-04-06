const fetch = require('node-fetch');

async function debugTranscriptFetch(videoId) {
    console.log(`Debugging transcript for video ID: ${videoId}`);
    
    try {
        // Step 1: Fetch the video page to check if transcripts are available
        console.log("\n=== STEP 1: Fetching video page ===");
        const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}`;
        console.log(`Fetching ${videoPageUrl}`);
        
        const response = await fetch(videoPageUrl);
        const html = await response.text();
        console.log(`Received HTML response (${html.length} characters)`);
        
        // Step 2: Extract player response data
        console.log("\n=== STEP 2: Extracting player response data ===");
        const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});/);
        if (!playerResponseMatch) {
            throw new Error('Could not find player response data');
        }
        
        const playerResponse = JSON.parse(playerResponseMatch[1]);
        console.log("Successfully extracted ytInitialPlayerResponse");
        
        // Step 3: Check available captions
        console.log("\n=== STEP 3: Checking available captions ===");
        const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer;
        
        if (!captions) {
            console.error("No captions object found in player response");
            console.log(JSON.stringify(playerResponse?.captions, null, 2));
            throw new Error('No captions data available');
        }
        
        if (!captions.captionTracks || captions.captionTracks.length === 0) {
            console.error("No caption tracks found");
            throw new Error('No caption tracks available');
        }
        
        // Step 3a: Categorize captions (manual vs auto-generated)
        const manualCaptions = [];
        const autoCaptions = [];
        
        console.log(`Found ${captions.captionTracks.length} caption tracks:`);
        captions.captionTracks.forEach((track, i) => {
            const trackKind = track.kind || '';
            const isAuto = trackKind === 'asr';
            const trackInfo = {
                index: i,
                name: track.name?.simpleText || 'Unnamed',
                languageCode: track.languageCode,
                kind: trackKind,
                isAuto: isAuto,
                isTranslatable: track.isTranslatable || false,
                url: track.baseUrl
            };
            
            console.log(`  ${i+1}. ${trackInfo.name} (${trackInfo.languageCode}) - ${isAuto ? 'Auto-generated' : 'Manual'}`);
            console.log(`     URL: ${trackInfo.url}`);
            
            if (isAuto) {
                autoCaptions.push(trackInfo);
            } else {
                manualCaptions.push(trackInfo);
            }
        });
        
        console.log(`\nManual captions: ${manualCaptions.length}`);
        console.log(`Auto-generated captions: ${autoCaptions.length}`);
        
        // Step 3b: Check translation options
        if (captions.translationLanguages && captions.translationLanguages.length > 0) {
            console.log(`\nAvailable translation languages: ${captions.translationLanguages.length}`);
            captions.translationLanguages.slice(0, 5).forEach((lang, i) => {
                console.log(`  ${i+1}. ${lang.languageName.simpleText} (${lang.languageCode})`);
            });
            if (captions.translationLanguages.length > 5) {
                console.log(`  ... and ${captions.translationLanguages.length - 5} more`);
            }
        }
        
        // Step 4: Find the best transcript (prioritize English manual > English auto > any manual > any auto)
        const preferredLanguages = ['en', 'en-US', 'en-GB'];
        
        // Try to find manual caption in preferred language
        let selectedCaption = null;
        for (const langCode of preferredLanguages) {
            const found = manualCaptions.find(cap => cap.languageCode.startsWith(langCode));
            if (found) {
                selectedCaption = found;
                console.log(`\nFound manual caption in preferred language: ${found.languageCode}`);
                break;
            }
        }
        
        // If not found, try auto-generated in preferred language
        if (!selectedCaption) {
            for (const langCode of preferredLanguages) {
                const found = autoCaptions.find(cap => cap.languageCode.startsWith(langCode));
                if (found) {
                    selectedCaption = found;
                    console.log(`\nFound auto-generated caption in preferred language: ${found.languageCode}`);
                    break;
                }
            }
        }
        
        // If still not found, use first manual or auto caption available
        if (!selectedCaption) {
            selectedCaption = manualCaptions[0] || autoCaptions[0];
            console.log(`\nUsing first available caption: ${selectedCaption.languageCode} (${selectedCaption.isAuto ? 'Auto' : 'Manual'})`);
        }
        
        if (!selectedCaption) {
            throw new Error('Could not select a suitable caption track');
        }
        
        // Step 5: Fetch the selected transcript
        console.log(`\n=== STEP 5: Fetching selected transcript ===`);
        console.log(`Selected: ${selectedCaption.name} (${selectedCaption.languageCode}) - ${selectedCaption.isAuto ? 'Auto-generated' : 'Manual'}`);
        
        // Add parameters to get better quality transcript
        let transcriptUrl = selectedCaption.url;
        
        // Try different transcript formats
        console.log("Fetching with different formats to find the best transcript:");
        
        // Format 1: Default with tlang parameter
        const url1 = `${transcriptUrl}&tlang=${selectedCaption.languageCode}`;
        console.log(`\nTrying URL 1: Default + tlang parameter`);
        const resp1 = await fetch(url1);
        const text1 = await resp1.text();
        const count1 = (text1.match(/<text/g) || []).length;
        console.log(`Retrieved ${count1} transcript entries`);
        
        // Format 2: JSON format
        const url2 = `${transcriptUrl}&fmt=json3`;
        console.log(`\nTrying URL 2: JSON format`);
        const resp2 = await fetch(url2);
        const text2 = await resp2.text();
        let count2 = 0;
        try {
            if (text2.startsWith('{')) {
                const json = JSON.parse(text2);
                count2 = json.events ? json.events.filter(e => e.segs && e.segs.length > 0).length : 0;
            }
        } catch (e) {
            console.log("Failed to parse JSON response");
        }
        console.log(`Retrieved ${count2} transcript entries`);
        
        // Format 3: Adding srv3 parameter (used by YouTube sometimes)
        const url3 = `${transcriptUrl}&fmt=srv3`;
        console.log(`\nTrying URL 3: srv3 format`);
        const resp3 = await fetch(url3);
        const text3 = await resp3.text();
        let count3 = 0;
        try {
            if (text3.startsWith('{')) {
                const json = JSON.parse(text3);
                count3 = json.events ? json.events.length : 0;
            } else {
                count3 = (text3.match(/<text/g) || []).length;
            }
        } catch (e) {
            console.log("Failed to parse srv3 response");
        }
        console.log(`Retrieved ${count3} transcript entries`);
        
        // Choose best transcript based on entry count
        let bestText = '';
        let bestFormat = '';
        let bestCount = 0;
        
        // Prioritize JSON over XML, as it's more reliable to parse
        if (count2 > 0) {
            bestText = text2;
            bestFormat = 'JSON';
            bestCount = count2;
        } else if (count1 > 0) {
            bestText = text1;
            bestFormat = 'XML';
            bestCount = count1;
        } else if (count3 > 0) {
            bestText = text3;
            bestFormat = 'srv3';
            bestCount = count3;
        }
        
        console.log(`\nSelected best transcript format: ${bestFormat} with ${bestCount} entries`);
        
        // Step 6: Parse the selected transcript
        console.log("\n=== STEP 6: Parsing the best transcript ===");
        let transcript = [];
        
        if (bestFormat === 'JSON' || bestFormat === 'srv3') {
            // Parse JSON format
            console.log("Parsing JSON format...");
            try {
                const jsonData = JSON.parse(bestText);
                if (jsonData.events) {
                    transcript = jsonData.events
                        .filter(event => event.segs && event.segs.length > 0)
                        .map(event => ({
                            text: event.segs.map(seg => seg.utf8).join(' ').trim(),
                            start: event.tStartMs / 1000,
                            duration: (event.dDurationMs || 1000) / 1000
                        }))
                        .filter(item => item.text);
                    console.log(`Successfully parsed ${transcript.length} entries from JSON`);
                }
            } catch (e) {
                console.error('Error parsing JSON transcript:', e);
            }
        } else if (bestFormat === 'XML') {
            // Parse XML format
            console.log("Parsing XML format...");
            // XML parsing in JavaScript can be tricky with multiline content
            // Instead of using regex, try a different approach
            
            const xmlDoc = bestText.replace(/>\s+</g, '><'); // Remove whitespace between tags
            console.log(`Length of XML: ${xmlDoc.length}`);
            
            // Split by opening tag and recombine properly
            const parts = xmlDoc.split('<text ').slice(1); // Skip the first split result (before first tag)
            console.log(`Found ${parts.length} parts after splitting`);
            
            transcript = parts.map(part => {
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
            
            console.log(`Successfully parsed ${transcript.length} entries from XML`);
        }
        
        // Step 7: Show transcript samples
        console.log(`\nParsed ${transcript.length} transcript entries`);
        
        if (transcript.length > 0) {
            console.log("\nFirst 5 entries:");
            transcript.slice(0, 5).forEach((entry, i) => {
                const minutes = Math.floor(entry.start / 60);
                const seconds = Math.floor(entry.start % 60).toString().padStart(2, '0');
                console.log(`  ${i+1}. [${minutes}:${seconds}] ${entry.text.substring(0, 50)}${entry.text.length > 50 ? '...' : ''}`);
            });
            
            if (transcript.length > 10) {
                console.log("\nLast 5 entries:");
                transcript.slice(-5).forEach((entry, i) => {
                    const minutes = Math.floor(entry.start / 60);
                    const seconds = Math.floor(entry.start % 60).toString().padStart(2, '0');
                    const idx = transcript.length - 5 + i;
                    console.log(`  ${idx+1}. [${minutes}:${seconds}] ${entry.text.substring(0, 50)}${entry.text.length > 50 ? '...' : ''}`);
                });
            }
        }
        
        return {
            selectedCaption,
            bestFormat,
            transcriptCount: transcript.length,
            transcript
        };
        
    } catch (error) {
        console.error(`\nError debugging transcript: ${error.message}`);
        console.error(error);
    }
}

// Run for the specified video ID
const videoId = process.argv[2] || 'ZudTPpJCbbA';
debugTranscriptFetch(videoId); 