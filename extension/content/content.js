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
  let progressSource = null;
  let progressRequestId = null;

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
.resume-gen-float-btn {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 99999;
  background: #111827;
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 12px 18px;
  font: 600 14px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
  cursor: pointer;
  transition: all 0.2s ease;
}
.resume-gen-float-btn:hover {
  background: #0f172a;
  transform: translateY(-1px);
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
#resume-gen-progress {
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 99999;
  width: 320px;
  background: #0b0f19;
  color: #e5e7eb;
  border: 1px solid #1f2937;
  border-radius: 12px;
  padding: 12px 14px;
  font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 8px 24px rgba(0,0,0,0.25);
  display: none;
}
#resume-gen-progress.show {
  display: block;
}
#resume-gen-progress .title {
  font-weight: 600;
  margin-bottom: 6px;
}
#resume-gen-progress .bar {
  width: 100%;
  height: 6px;
  background: #111827;
  border-radius: 6px;
  overflow: hidden;
  margin: 8px 0;
}
#resume-gen-progress .bar-fill {
  height: 100%;
  width: 0%;
  background: #22c55e;
  transition: width 0.25s ease;
}
#resume-gen-progress .meta {
  color: #cbd5f5;
}
#resume-gen-progress .actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
#resume-gen-progress .actions button {
  background: #111827;
  color: #e5e7eb;
  border: 1px solid #1f2937;
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 11px;
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

  function ensureProgressPanel() {
    if (document.getElementById('resume-gen-progress')) return;
    const panel = document.createElement('div');
    panel.id = 'resume-gen-progress';
    panel.innerHTML = `
      <div class="title">Generating resume…</div>
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="meta">Starting…</div>
      <div class="actions">
        <button id="resume-gen-hide">Hide</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#resume-gen-hide')?.addEventListener('click', () => {
      panel.classList.remove('show');
    });
  }

  function showProgressPanel() {
    const panel = document.getElementById('resume-gen-progress');
    if (panel) panel.classList.add('show');
  }

  function updateProgressPanel(percent, message) {
    const panel = document.getElementById('resume-gen-progress');
    if (!panel) return;
    const fill = panel.querySelector('.bar-fill');
    const meta = panel.querySelector('.meta');
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (meta) meta.textContent = message || 'Working...';
  }

  async function getBackendUrl() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['backendUrl'], (result) => {
        resolve(result.backendUrl || '');
      });
    });
  }

  function startProgressStream(backendUrl, requestId) {
    const url = `${backendUrl.replace(/\\/+$/, '')}/api/progress/${encodeURIComponent(requestId)}`;
    const source = new EventSource(url);
    source.addEventListener('progress', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        const eta = typeof data.etaSeconds === 'number' ? ` • ETA ~${data.etaSeconds}s` : '';
        const msg = data.message ? `${data.message}${eta}` : 'Working...';
        updateProgressPanel(data.percent ?? 0, msg);
      } catch (_) {
        updateProgressPanel(10, 'Working...');
      }
    });
    source.onerror = () => {
      updateProgressPanel(10, 'Waiting for updates...');
    };
    return source;
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

    const backendUrl = await getBackendUrl();
    if (!backendUrl) {
      showToast('❌ Backend URL not configured. Set it in Options.', 'error');
      return;
    }

    showToast('🤖 Generating resume...', 'info');
    ensureProgressPanel();
    showProgressPanel();
    updateProgressPanel(5, 'Starting...');

    progressRequestId = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (progressSource) {
      progressSource.close();
      progressSource = null;
    }
    progressSource = startProgressStream(backendUrl, progressRequestId);

    // Send to background script for processing
    chrome.runtime.sendMessage(
      {
        action: 'generateResume',
        jobDescription,
        masterResume,
        requestId: progressRequestId,
      },
      (response) => {
        if (response && response.success) {
          updateProgressPanel(100, 'Download started.');
          showToast('✅ Resume generated successfully!', 'success');
        } else {
          const error = response?.error || 'Unknown error';
          updateProgressPanel(100, error);
          showToast(`❌ ${error}`, 'error');
        }
        if (progressSource) {
          progressSource.close();
          progressSource = null;
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

  function ensureFloatingButton() {
    if (document.querySelector('.resume-gen-float-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'resume-gen-float-btn';
    btn.title = 'Generate resume from this job';
    btn.textContent = 'Generate Resume';
    btn.addEventListener('click', handleGenerateResume);
    document.body.appendChild(btn);
  }

  function ensureButton() {
    if (!isLinkedInJobPage()) return;
    ensureStyles();
    ensureProgressPanel();
    ensureFloatingButton();

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
