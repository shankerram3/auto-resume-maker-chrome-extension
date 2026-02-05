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

// Inject an inline "Generate Resume" button next to the "About the Job" heading on LinkedIn job pages.
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
.resume-gen-inline-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 12px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font: 600 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
  cursor: pointer;
  transition: all 0.2s ease;
  vertical-align: middle;
}
.resume-gen-inline-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
}
.resume-gen-inline-btn:active {
  transform: translateY(0);
}
.resume-gen-inline-btn svg {
  width: 16px;
  height: 16px;
}
#resume-gen-toast {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 99999;
  background: #0b0f19;
  color: #e5e7eb;
  border: 1px solid #1f2937;
  border-radius: 10px;
  padding: 12px 16px;
  font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  opacity: 0;
  transform: translateY(-10px);
  transition: opacity 0.2s ease, transform 0.2s ease;
  max-width: 320px;
}
#resume-gen-toast.show {
  opacity: 1;
  transform: translateY(0);
}
#resume-gen-toast.error {
  background: #7f1d1d;
  border-color: #991b1b;
  color: #fecaca;
}
#resume-gen-toast.success {
  background: #064e3b;
  border-color: #065f46;
  color: #a7f3d0;
}
`;
    document.head.appendChild(style);
  }

  function showToast(message, type = 'info') {
    let toast = document.getElementById('resume-gen-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'resume-gen-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = type === 'error' ? 'error' : type === 'success' ? 'success' : '';
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
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

  async function handleGenerateResume() {
    const jobDescription = extractAboutJob();
    if (!jobDescription) {
      showToast('❌ Could not extract job description', 'error');
      return;
    }

    showToast('🔄 Extracting job description...', 'info');

    // Save to storage for popup to access
    chrome.storage.local.set({ lastJobDescription: jobDescription });

    // Get master resume
    const masterResume = await new Promise((resolve) => {
      chrome.storage.local.get(['masterResume'], (result) => {
        resolve(result.masterResume || '');
      });
    });

    if (!masterResume || masterResume.trim().length < 100) {
      showToast('❌ Master resume not configured. Please set it in Options.', 'error');
      return;
    }

    showToast('🤖 Generating resume with Claude...', 'info');

    // Send to background script for processing
    chrome.runtime.sendMessage(
      {
        action: 'generateResume',
        jobDescription,
        masterResume,
      },
      (response) => {
        if (response && response.success) {
          showToast('✅ Resume generated successfully!', 'success');
        } else {
          const error = response?.error || 'Unknown error';
          showToast(`❌ ${error}`, 'error');
        }
      }
    );
  }

  function findAboutJobHeading() {
    const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (const heading of headings) {
      const text = (heading.textContent || '').trim().toLowerCase();
      if (text.includes('about the job') || text.includes('about this job')) {
        return heading;
      }
    }
    return null;
  }

  function ensureButton() {
    if (!isLinkedInJobPage()) return;
    ensureStyles();

    const heading = findAboutJobHeading();
    if (!heading) return;

    // Check if button already exists next to this heading
    if (heading.querySelector('.resume-gen-inline-btn') || heading.nextElementSibling?.classList.contains('resume-gen-inline-btn')) {
      return;
    }

    const btn = document.createElement('button');
    btn.className = 'resume-gen-inline-btn';
    btn.title = 'Extract job description and generate custom resume';
    btn.innerHTML = `
      <svg fill="currentColor" viewBox="0 0 20 20">
        <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/>
        <path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/>
      </svg>
      <span>Generate Resume</span>
    `;
    btn.addEventListener('click', handleGenerateResume);

    // Insert button next to heading
    heading.appendChild(btn);
  }

  // Initial injection and observe SPA navigations/DOM changes.
  ensureButton();
  const observer = new MutationObserver(() => ensureButton());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
