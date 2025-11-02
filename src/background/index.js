// Content script listener
if (typeof DEBUG === 'undefined') var DEBUG = false; // Debug flag

if (DEBUG) console.log("[Content Script] Loaded on page:", window.location.href);

// Check if already initialized (prevent duplicate execution)
if (window.__tokyomotion_extension_initialized__) {
	if (DEBUG) console.log("[Content Script] Already initialized, skipping");
} else {
	window.__tokyomotion_extension_initialized__ = true;

// Configuration constants
const CONFIG = {
	MAX_RETRIES: 6,
	RETRY_DELAY_MS: 700,
	REDIRECT_WAIT_MS: 100
};

// Prevent duplicate downloads - use sessionStorage to persist across page reloads
let lastDownloadedUrl = sessionStorage.getItem('__tokyomotion_last_download_url__') || null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (DEBUG) console.log("[Content Script] Received message:", request.action);
	
	if (request.action === "getVideoInfo") {
		// Find video sources with retries
		const findSources = () => {
			const sources = [];
			
			// 1) Search for video element
			const videoElement = document.querySelector('video');
			if (videoElement) {
				let videoSrc = videoElement.src || '';
				if (!videoSrc) {
					const source = videoElement.querySelector('source');
					if (source && source.src) {
						videoSrc = source.src;
					}
				}
				if (videoSrc) {
					sources.push({ src: videoSrc, type: 'video/mp4' });
				}
			}
			
			// 2) Search for source tags with mp4
			if (sources.length === 0) {
				const srcElements = Array.from(document.querySelectorAll('source'));
				for (const s of srcElements) {
					if (s.src && /\.mp4(\?|$)/i.test(s.src)) {
						sources.push({ src: s.src, type: s.type || 'video/mp4' });
						break;
					}
				}
			}
			
			// 3) Extract mp4 URLs from script tags or page text
			if (sources.length === 0) {
				const scripts = document.querySelectorAll('script');
				for (const script of scripts) {
					const content = script.textContent || '';
					// Extended pattern: /vsrc/, /video/, or *.mp4 URLs
					const mp4Match = content.match(/https?:\/\/[^"'\s]+\.mp4(?:\?[^"'\s]*)?/i);
					const videoMatch = content.match(/https?:\/\/[^"'\s]+\/video\/[^"'\s]+/i);
					const match = mp4Match || videoMatch;
					
					if (match) {
						sources.push({ src: match[0], type: 'video/mp4' });
						break;
					}
				}
			}
			
			return sources;
		};

		const buildResponse = (sources) => {
			const pageUrl = window.location.href;
			const src = sources[0].src;
			
			// Get title
			const titleElement = document.querySelector('.hidden-xs.big-title-truncate.m-t-0') || 
			                     document.querySelector('h1');
			const title = titleElement?.innerText?.trim() || '';
			
			// Generate filename
			let filename = '';
			const mp4IdMatch = pageUrl.match(/\/(\d+)\.mp4$/);
			const pageIdMatch = pageUrl.match(/\/video\/(\d+)/);
			
			if (mp4IdMatch) {
				filename = `tokyomotion_${mp4IdMatch[1]}`;
			} else if (pageIdMatch) {
				filename = `tokyomotion_${pageIdMatch[1]}`;
			}
			
			if (title && title !== 'video') {
				filename = filename ? `${filename}_${title}` : title;
			}
			
			if (!filename) {
				filename = 'tokyomotion_video';
			}
			
			return {
				success: true,
				videoInfo: {
					url: src,
					title: filename,
					referer: pageUrl,
					sources: sources
				}
			};
		};

		let attempt = 0;
		const tryFind = () => {
			attempt++;
			const sources = findSources();
			if (sources.length > 0) {
				if (DEBUG) console.log('[Content Script] Found video sources on attempt', attempt, sources[0]);
				sendResponse(buildResponse(sources));
				return;
			}
			if (attempt < CONFIG.MAX_RETRIES) {
				if (DEBUG) console.log('[Content Script] No sources yet, retrying after', CONFIG.RETRY_DELAY_MS, 'ms (attempt', attempt, ')');
				setTimeout(tryFind, CONFIG.RETRY_DELAY_MS);
			} else {
				if (DEBUG) console.error('[Content Script] No video sources found after retries');
				sendResponse({ success: false, message: 'Video source not found', debug: 'No source after retries' });
			}
		};

		// Return true for async response
		tryFind();
		return true;
	} else if (request.action === "triggerRedirect") {
		// Trigger redirect by clicking link
		try {
			if (DEBUG) console.log("[Content Script] Triggering redirect click");
			// Record this URL to prevent subsequent downloads (persist across reloads)
			lastDownloadedUrl = request.videoInfo.url;
			sessionStorage.setItem('__tokyomotion_last_download_url__', lastDownloadedUrl);
			const link = document.createElement('a');
			link.href = request.videoInfo.url;
			link.style.display = 'none';
			document.body.appendChild(link);
			link.click();
			setTimeout(() => link.remove(), 100);
			sendResponse({ success: true, message: "Redirect triggered" });
		} catch (error) {
			if (DEBUG) console.error("[Content Script] Redirect trigger error:", error);
			sendResponse({ success: false, message: "Failed to trigger redirect: " + error.message });
		}
		return true;
	} else if (request.action === "downloadVideo") {
		// Download by clicking link in page
		downloadVideoWithCorrectExtension(request.videoInfo, sendResponse);
		return true;
	}
});

function downloadVideoWithCorrectExtension(videoInfo, sendResponse) {
	const { url, title, referer } = videoInfo;
	
	if (DEBUG) console.log("[Content Script] Initiating download:", { url, title, referer });
	
	// Skip if this URL was already downloaded recently
	if (lastDownloadedUrl === url) {
		if (DEBUG) console.warn("[DEBUG] Duplicate download prevented for URL:", url);
		sendResponse({ success: true, warning: true, message: "Duplicate download prevented" });
		return;
	}
	lastDownloadedUrl = url;
	sessionStorage.setItem('__tokyomotion_last_download_url__', lastDownloadedUrl);
	
	// Insert <a download> tag in page and auto-click
	// Uses browser native download functionality
	// This bypasses fetch blocking and auto-includes Referer/Cookies
	try {
		if (DEBUG) console.log("[Content Script] Creating download link...");
		
		// Remove existing link if present
		const existingLink = document.getElementById("__extension_download_link__");
		if (existingLink) {
			existingLink.remove();
		}
		
		// Create download link
		const link = document.createElement('a');
		link.id = "__extension_download_link__";
		link.href = url;
		link.download = `${title}.mp4`;
		link.style.display = 'none';
		
		if (DEBUG) console.log("[Content Script] Download link created:", { href: link.href, download: link.download });
		
		// Add to page and click
		document.body.appendChild(link);
		
		// Browser download process will automatically follow redirects
		link.click();
		if (DEBUG) console.log("[Content Script] Link clicked - browser will follow redirects automatically");
		
		// Remove link
		setTimeout(() => {
			link.remove();
			if (DEBUG) console.log("[Content Script] Download link removed");
		}, 100);
		
		sendResponse({
			success: true,
			message: `Download started: ${title}.mp4`
		});
		
	} catch (error) {
		if (DEBUG) console.error("[Content Script] Download error:", error);
		sendResponse({
			success: false,
			message: "Download failed: " + error.message
		});
	}
}

} // End of initialization check