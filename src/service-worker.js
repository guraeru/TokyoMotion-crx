// Service Worker - Download processing
const DEBUG = false; // Debug flag

if (DEBUG) console.log("Service worker loaded");

// Configuration constants
const DOWNLOAD_CONFIG = {
	REDIRECT_WAIT_MS: 2000,
	RETRY_FILENAME_PREFIX: 'video_'
};


function handleVideoDownload(tabId, videoInfo) {
	const initialUrl = videoInfo.url;
	
	// Wait for redirect completion if intermediate URL
	if (initialUrl.includes('/vsrc/') || !initialUrl.includes('www47')) {
		if (DEBUG) console.log("Initial URL is redirect URL, waiting for redirect...");
		
		// Wait for page redirect
		setTimeout(() => {
			// Get info again after redirect
			chrome.tabs.sendMessage(tabId, {action: "getVideoInfo"}, (retryResponse) => {
				if (chrome.runtime.lastError) {
					if (DEBUG) console.log("Could not refresh after redirect, using initial response");
					performDownload(tabId, videoInfo);
				} else if (retryResponse && retryResponse.success) {
					if (DEBUG) console.log("Got final video info after redirect:", retryResponse.videoInfo);
					performDownload(tabId, retryResponse.videoInfo);
				} else {
					performDownload(tabId, videoInfo);
				}
			});
		}, DOWNLOAD_CONFIG.REDIRECT_WAIT_MS);
	} else {
		performDownload(tabId, videoInfo);
	}
}

function performDownload(tabId, videoInfo) {
	// Execute download in content script
	chrome.tabs.sendMessage(tabId, {
		action: "downloadVideo",
		videoInfo: videoInfo
	}, (response) => {
		if (chrome.runtime.lastError) {
			if (DEBUG) console.error("Download error:", chrome.runtime.lastError);
		} else {
			if (DEBUG) console.log("Download initiated from context menu:", response);
		}
	});
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (DEBUG) console.log("Service worker received message:", request.action);
	
	switch (request.action) {
		case "downloadToFile":
			if (DEBUG) console.log("Starting download with video info");
			downloadVideoToFile(request.videoInfo, sendResponse);
			return true;
		
		case "directDownload":
		case "downloadDirectURL":
			if (DEBUG) console.log("Direct download");
			downloadDirectURL(request.url, request.filename, request.referer, sendResponse);
			return true;
		
		case "directDownloadMP4":
			if (DEBUG) console.log("Direct MP4 download - calling downloadDirectMP4");
			downloadDirectMP4(request.url, request.filename, sendResponse);
			return true;
		
		case "downloadBlob":
			if (DEBUG) console.log("Downloading blob URL");
			downloadBlob(request.blobUrl, request.filename, sendResponse);
			return true;
		
		// downloadVideo action is handled in content script (background/index.js)
		// Not processed here in service worker (prevent duplicate downloads)
		
		default:
			if (DEBUG) console.error("Unknown action:", request.action);
			sendResponse({success: false, message: "Unknown action: " + request.action});
			return false;
	}
});

// Common download processing function
function executeDownload(url, filename, sendResponse) {
	chrome.downloads.download({
		url: url,
		filename: filename,
		saveAs: false
	}, (downloadId) => {
		if (DEBUG) console.log("chrome.downloads.download callback called with downloadId:", downloadId);
		
		if (chrome.runtime.lastError) {
			if (DEBUG) console.error("Chrome download error:", chrome.runtime.lastError);
			sendResponse({
				success: false,
				message: "Download failed: " + chrome.runtime.lastError.message
			});
		} else {
			if (DEBUG) console.log("Download started with ID:", downloadId);
			sendResponse({
				success: true,
				message: `Download started: ${filename}`,
				downloadId: downloadId
			});
		}
	});
}

function downloadBlob(blobUrl, filename, sendResponse) {
	try {
		if (DEBUG) console.log("Downloading blob:", { blobUrl, filename });
		executeDownload(blobUrl, filename, sendResponse);
	} catch (error) {
		if (DEBUG) console.error("Blob download error:", error);
		sendResponse({
			success: false,
			message: "Download failed: " + error.message
		});
	}
}

function downloadDirectURL(url, filename, referer, sendResponse) {
	try {
		if (DEBUG) console.log("Direct URL download:", { url, filename });
		// chrome.downloads.download() downloads URL directly
		// Browser automatically handles redirects and headers
		executeDownload(url, filename, sendResponse);
	} catch (error) {
		if (DEBUG) console.error("Direct download error:", error);
		sendResponse({
			success: false,
			message: "Download failed: " + error.message
		});
	}
}

function downloadDirectMP4(url, filename, sendResponse) {
	try {
		if (DEBUG) console.log("Direct MP4 download:", { url, filename });
		
		// Ensure filename ends with .mp4
		const finalFilename = filename.endsWith('.mp4') ? filename : `${filename}.mp4`;
		
		// Use fetch to ignore Content-Disposition and download
		fetch(url)
			.then(response => {
				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}
				return response.blob();
			})
			.then(blob => {
				if (DEBUG) console.log("Blob received:", blob.size, "bytes, type:", blob.type);
				
				// Convert to data URL
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result;
					
					// Download data URL
					chrome.downloads.download({
						url: dataUrl,
						filename: finalFilename,
						saveAs: false
					}, (downloadId) => {
						if (chrome.runtime.lastError) {
							if (DEBUG) console.error("Chrome download error:", chrome.runtime.lastError);
							sendResponse({
								success: false,
								message: "Download failed: " + chrome.runtime.lastError.message
							});
						} else {
							if (DEBUG) console.log("Download started with ID:", downloadId);
							sendResponse({
								success: true,
								message: `Download started: ${finalFilename}`,
								downloadId: downloadId
							});
						}
					});
				};
				
				reader.onerror = () => {
					if (DEBUG) console.error("FileReader error");
					sendResponse({
						success: false,
						message: "File read error"
					});
				};
				
				reader.readAsDataURL(blob);
			})
			.catch(error => {
				if (DEBUG) console.error("Fetch error:", error);
				sendResponse({
					success: false,
					message: "Download failed: " + error.message
				});
			});
	} catch (error) {
		if (DEBUG) console.error("Direct MP4 download error:", error);
		sendResponse({
			success: false,
			message: "Download failed: " + error.message
		});
	}
}

function downloadVideoToFile(videoInfo, sendResponse) {
	try {
		const { url, title, referer } = videoInfo;
		
		if (DEBUG) console.log("Service worker: downloadVideoToFile called", { url, title, referer });

		const filename = `${title}.mp4`;
		
		if (DEBUG) console.log("Calling chrome.downloads.download with:", { url, filename });
		
		// chrome.downloads.download() downloads URL directly
		chrome.downloads.download({
			url: url,
			filename: filename,
			saveAs: false
		}, (downloadId) => {
			if (DEBUG) console.log("chrome.downloads.download callback called with downloadId:", downloadId);
			
			if (chrome.runtime.lastError) {
				if (DEBUG) console.error("Chrome download error:", chrome.runtime.lastError);
				// Retry: try with different filename
				const retryFilename = `${DOWNLOAD_CONFIG.RETRY_FILENAME_PREFIX}${Date.now()}.mp4`;
				if (DEBUG) console.log("Retrying with filename:", retryFilename);
				
				chrome.downloads.download({
					url: url,
					filename: retryFilename,
					saveAs: false
				}, (retryId) => {
					if (chrome.runtime.lastError) {
						if (DEBUG) console.error("Chrome download retry error:", chrome.runtime.lastError);
						sendResponse({
							success: false,
							message: "Download failed: " + chrome.runtime.lastError.message
						});
					} else {
						if (DEBUG) console.log("Download started (retry) with ID:", retryId);
						sendResponse({
							success: true,
							message: `Download started: ${retryFilename}`,
							downloadId: retryId
						});
					}
				});
			} else {
				if (DEBUG) console.log("Download started with ID:", downloadId);
				sendResponse({
					success: true,
					message: `Download started: ${filename}`,
					downloadId: downloadId
				});
			}
		});

	} catch (error) {
		if (DEBUG) console.error("Download error:", error);
		sendResponse({
			success: false,
			message: "Download failed: " + error.message
		});
	}
}

// Monitor download completion
chrome.downloads.onChanged.addListener((delta) => {
	if (delta.state) {
		if (DEBUG) console.log("[Service Worker] Download state changed:", delta.id, delta.state.current);
	}
});
