// Configuration constants
const POPUP_CONFIG = {
	REDIRECT_WAIT_MS: 3000,
	RETRY_DELAY_MS: 800,
	MAX_RETRIES: 6
};

// Helper functions
function isRedirectUrl(url) {
	return url.includes('/vsrc/') || !url.includes('www47');
}

function selectBestSource(sources) {
	if (!sources || !Array.isArray(sources)) {
		return null;
	}
	
	// Prefer HD
	let selectedSource = sources.find(s => s.src.includes('/hd/'));
	if (!selectedSource) {
		// SD or other mp4
		selectedSource = sources.find(s => s.src.includes('/sd/'));
	}
	if (!selectedSource) {
		// Any mp4, first one
		selectedSource = sources[0];
	}
	
	return selectedSource;
}

async function retryGetVideoInfo(tabId, maxTries = POPUP_CONFIG.MAX_RETRIES) {
	let lastErr = null;
	
	for (let i = 0; i < maxTries; i++) {
		try {
			const videoInfo = await chrome.tabs.sendMessage(tabId, { action: 'getVideoInfo' });
			if (videoInfo && videoInfo.success) {
				return videoInfo;
			}
			lastErr = new Error(videoInfo?.message || 'empty response');
		} catch (msgErr) {
			lastErr = msgErr;
		}
		
		console.log(`Retrying getVideoInfo after redirect (attempt ${i + 1})`);
		await new Promise(r => setTimeout(r, POPUP_CONFIG.RETRY_DELAY_MS));
	}
	
	throw lastErr || new Error('Retry failed');
}

async function handleRedirectFlow(tab, videoInfo, statusDiv) {
	console.log('Initial URL is an intermediate redirect URL, triggering redirect:', videoInfo.videoInfo.url);

	// No download needed. Just trigger redirect by clicking link
	try {
		await chrome.tabs.sendMessage(tab.id, {
			action: "triggerRedirect",
			videoInfo: videoInfo.videoInfo
		});
	} catch (e) {
		console.error("Failed to send redirect trigger message:", e);
		// Continue anyway
	}

	// Wait for redirect to complete
	console.log("Waiting for page redirect...");
	await new Promise(resolve => setTimeout(resolve, POPUP_CONFIG.REDIRECT_WAIT_MS));

	// Get final mp4 URL after redirect
	statusDiv.textContent = 'Getting final URL...';
	console.log("Sending getVideoInfo message again after redirect:", tab.id);
	
	// Re-inject content script with retry logic
	try {
		await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			files: ['background/index.js']
		});
		console.log('Injected content script after redirect');
	} catch (injectErr) {
		console.warn('Content script injection failed (continuing):', injectErr);
	}

	const updatedVideoInfo = await retryGetVideoInfo(tab.id);
	console.log("Video info received (after redirect):", updatedVideoInfo.videoInfo);
	
	return updatedVideoInfo;
}

async function executeDownload(tab, videoInfo, statusDiv, looksLikeRedirectUrl) {
	let result;
	const message = looksLikeRedirectUrl ? 'Starting final download...' : 'Starting download...';
	statusDiv.textContent = message;
	
	console.log(`Sending ${looksLikeRedirectUrl ? 'final ' : ''}download request to content script`);
	
	try {
		result = await chrome.tabs.sendMessage(tab.id, {
			action: "downloadVideo",
			videoInfo: videoInfo.videoInfo
		});
	} catch (e) {
		console.error("Failed to send download message to content script:", e);
		throw new Error(`${looksLikeRedirectUrl ? 'Final ' : ''}download error occurred`);
	}
	
	return result;
}

document.getElementById('downloadBtn').addEventListener('click', async () => {
    const statusDiv = document.getElementById('status');
    const btn = document.getElementById('downloadBtn');
    
    // --- Initial state setup ---
    btn.disabled = true;
    btn.textContent = 'Downloading...';
    statusDiv.textContent = '';
    statusDiv.className = '';
    
    try {
        const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
        
        // --- Check site URL ---
        if (!tab.url.includes('tokyomotion.net') && !tab.url.includes('osakamotion.net')) {
            throw new Error('Please open a TokyoMotion or OsakaMotion page');
        }
        
        console.log("Tab URL:", tab.url);
        
        // --- 1. Get video info (initial) ---
        console.log("Sending getVideoInfo message to tab:", tab.id);
        let videoInfo;
        try {
            videoInfo = await chrome.tabs.sendMessage(tab.id, {action: "getVideoInfo"});
        } catch (e) {
            console.error("Failed to get video info:", e);
            throw new Error("Extension not loaded on video page. Please reload the page.");
        }
        
        if (!videoInfo.success) {
            throw new Error(videoInfo.message || "Failed to get video info");
        }
        
        console.log("Video info received (first time):", videoInfo.videoInfo);
        
        const initialUrl = videoInfo.videoInfo.url || '';
        const looksLikeRedirectUrl = isRedirectUrl(initialUrl);

        // --- 2. Handle redirect if needed ---
        if (looksLikeRedirectUrl) {
            videoInfo = await handleRedirectFlow(tab, videoInfo, statusDiv);
        }

        // --- 3. Select download URL (HD preferred) ---
        const selectedSource = selectBestSource(videoInfo.videoInfo.sources);
        if (selectedSource) {
            videoInfo.videoInfo.url = selectedSource.src;
        }

        // --- 4. Execute final download ---
        const result = await executeDownload(tab, videoInfo, statusDiv, looksLikeRedirectUrl);
        
        console.log("Download response (final):", result);
        
        if (result && result.success) {
            // Check if this is a warning (e.g., duplicate download)
            if (result.warning) {
                statusDiv.textContent = '⚠ ' + (result.message || 'Warning');
                statusDiv.className = 'warning';
            } else {
                statusDiv.textContent = '✓ ' + (result.message || 'Download started');
                statusDiv.className = 'success';
            }
        } else if (result && result.message) {
            throw new Error(result.message);
        } else {
            console.error("Unexpected response:", result);
            throw new Error("Invalid download response");
        }
        
    } catch (error) {
        console.error('Error:', error);
        statusDiv.textContent = '✗ ' + error.message;
        statusDiv.className = 'error';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Start Download';
    }
});