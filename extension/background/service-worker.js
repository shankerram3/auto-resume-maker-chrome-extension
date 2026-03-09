/**
 * Background service worker: handles resume generation via backend API.
 */

importScripts('backend-handler.js');

const BACKEND_URL = 'https://resume-generator-backend-production-42f6.up.railway.app';

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['downloadSaveAs', 'downloadSubfolder'], (result) => {
      resolve({
        downloadSaveAs: result.downloadSaveAs !== false,
        downloadSubfolder: result.downloadSubfolder || ''
      });
    });
  });
}

// Update generation status in storage so popup can poll it
function setGenerationStatus(status) {
  chrome.storage.local.set({ generationStatus: status });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'generateResume') {
    // Respond immediately so the popup knows the request was received
    sendResponse({ received: true });

    // Run generation in the background
    handleGenerateResume(request.jobDescription, request.masterResume, request.requestId);
    return false;
  }

  if (request.action === 'getGenerationStatus') {
    chrome.storage.local.get(['generationStatus'], (result) => {
      sendResponse(result.generationStatus || null);
    });
    return true;
  }
});

async function handleGenerateResume(jobDescription, masterResume, requestId) {
  setGenerationStatus({ state: 'generating', message: 'Generating resume with AI...' });

  const settings = await getSettings();

  const result = await handleGenerateResumeViaBackend(
    BACKEND_URL,
    jobDescription,
    masterResume,
    {
      saveAs: settings.downloadSaveAs,
      subfolder: settings.downloadSubfolder,
      requestId
    }
  );

  if (result?.success) {
    setGenerationStatus({ state: 'done', message: 'Resume downloaded!' });
  } else {
    setGenerationStatus({ state: 'error', message: result?.error || 'Generation failed.' });
  }
}
