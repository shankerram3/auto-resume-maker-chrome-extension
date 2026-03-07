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

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'generateResume') {
    handleGenerateResume(request.jobDescription, request.masterResume, request.requestId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
});

async function handleGenerateResume(jobDescription, masterResume, requestId) {
  const settings = await getSettings();

  return await handleGenerateResumeViaBackend(
    BACKEND_URL,
    jobDescription,
    masterResume,
    {
      saveAs: settings.downloadSaveAs,
      subfolder: settings.downloadSubfolder,
      requestId
    }
  );
}
