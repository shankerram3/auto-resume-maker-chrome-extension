/**
 * Content script for LinkedIn job pages.
 * Listens for messages from the popup to extract the job description from the DOM.
 */

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'extractJobDescription') {
    try {
      const text = typeof JobExtractor !== 'undefined'
        ? JobExtractor.extractFromDOM(document)
        : null;
      sendResponse({ success: !!text, jobDescription: text });
    } catch (e) {
      sendResponse({ success: false, error: String(e) });
    }
  }
  return true;
});

// Inject a floating "Create Custom Resume" button on LinkedIn job pages.
(function injectResumeButton() {
  'use strict';

  function isLinkedInJobPage() {
    return location.hostname.includes('linkedin.com') && location.pathname.includes('/jobs');
  }

  function ensureStyles() {
    if (document.getElementById('resume-gen-styles')) return;
    const style = document.createElement('style');
    style.id = 'resume-gen-styles';
    style.textContent = `
#resume-gen-btn{
  position:fixed;
  right:20px;
  bottom:20px;
  z-index:99999;
  background:#111827;
  color:#fff;
  border:none;
  border-radius:999px;
  padding:12px 18px;
  font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  box-shadow:0 8px 24px rgba(0,0,0,.2);
  cursor:pointer;
}
#resume-gen-btn:hover{background:#0f172a;}
#resume-gen-toast{
  position:fixed;
  right:20px;
  bottom:70px;
  z-index:99999;
  background:#0b0f19;
  color:#e5e7eb;
  border:1px solid #1f2937;
  border-radius:10px;
  padding:10px 14px;
  font:500 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  opacity:0;
  transform:translateY(6px);
  transition:opacity .18s ease, transform .18s ease;
}
#resume-gen-toast.show{opacity:1;transform:translateY(0);}
`;
    document.head.appendChild(style);
  }

  function showToast(message) {
    const toast = document.getElementById('resume-gen-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function extractAboutJob() {
    const container = document.querySelector(
      'div[data-sdui-component="com.linkedin.sdui.generated.jobseeker.dsl.impl.aboutTheJob"]'
    );
    if (container) {
      const text = (container.innerText || container.textContent || '').trim();
      if (text) return text;
    }
    if (typeof JobExtractor !== 'undefined') {
      return JobExtractor.extractFromDOM(document);
    }
    return null;
  }

  function ensureButton() {
    if (!isLinkedInJobPage()) return;
    ensureStyles();
    if (!document.getElementById('resume-gen-btn')) {
      const btn = document.createElement('button');
      btn.id = 'resume-gen-btn';
      btn.title = 'Create custom resume';
      btn.textContent = 'Create Custom Resume';
      btn.addEventListener('click', async () => {
        const text = extractAboutJob();
        if (!text) {
          showToast('About the job section not found.');
          return;
        }
        chrome.storage.local.set({ lastJobDescription: text });
        try {
          await navigator.clipboard.writeText(text);
          showToast('Copied “About the job” to clipboard.');
        } catch (err) {
          console.warn('Clipboard failed', err);
          showToast('Saved to extension. Clipboard blocked.');
        }
      });
      document.body.appendChild(btn);
    }
    if (!document.getElementById('resume-gen-toast')) {
      const toast = document.createElement('div');
      toast.id = 'resume-gen-toast';
      toast.textContent = 'Copied “About the job” to clipboard.';
      document.body.appendChild(toast);
    }
  }

  // Initial injection and observe SPA navigations/DOM changes.
  ensureButton();
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
