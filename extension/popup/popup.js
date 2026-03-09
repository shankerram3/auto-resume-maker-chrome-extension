(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const btnGenerate = document.getElementById('btnGenerate');
  let pollTimer = null;

  function showStatus(message, type = 'info') {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
    statusEl.classList.remove('hidden');
  }

  /**
   * Extract job description from the active LinkedIn tab.
   */
  async function extractJobDescription() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('Could not access current tab.');
    if (!tab.url || !tab.url.includes('linkedin.com/jobs')) {
      throw new Error('Open a LinkedIn job page first.');
    }

    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, { action: 'extractJobDescription' });
    } catch (_) {
      response = null;
    }

    if (response?.success && response.jobDescription) {
      return response.jobDescription;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const normalize = (t) => (t || '').replace(/\s+/g, ' ').trim();
        const about = document.querySelector(
          'div[data-sdui-component="com.linkedin.sdui.generated.jobseeker.dsl.impl.aboutTheJob"]'
        );
        if (about) {
          const text = normalize(about.innerText || about.textContent || '');
          if (text.length > 100) return text;
        }
        const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'));
        for (const h of headings) {
          const txt = normalize(h.textContent || '').toLowerCase();
          if (txt.includes('about the job') || txt.includes('about this job')) {
            const parent = h.parentElement;
            if (parent) {
              const t = normalize(parent.innerText || parent.textContent || '');
              if (t.length > 200) return t;
            }
            const next = h.nextElementSibling;
            if (next) {
              const t = normalize(next.innerText || next.textContent || '');
              if (t.length > 100) return t;
            }
          }
        }
        return '';
      }
    });

    const fallbackText = results?.[0]?.result || '';
    if (fallbackText && fallbackText.length > 100) {
      return fallbackText;
    }

    throw new Error('Could not find job description on this page.');
  }

  function startPollingStatus() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const status = await chrome.runtime.sendMessage({ action: 'getGenerationStatus' });
        if (!status) return;

        if (status.state === 'done') {
          showStatus(status.message, 'success');
          btnGenerate.disabled = false;
          clearInterval(pollTimer);
          pollTimer = null;
        } else if (status.state === 'error') {
          showStatus(status.message, 'error');
          btnGenerate.disabled = false;
          clearInterval(pollTimer);
          pollTimer = null;
        } else if (status.state === 'generating') {
          showStatus(status.message, 'info');
        }
      } catch (_) {
        // Extension context may be invalidated
      }
    }, 1500);
  }

  async function generateResume() {
    btnGenerate.disabled = true;

    try {
      // Step 1: Extract job description from LinkedIn page
      showStatus('Extracting job description...', 'info');
      const jobDescription = await extractJobDescription();

      // Step 2: Get master resume
      showStatus('Loading master resume...', 'info');
      let masterResume = '';
      try {
        masterResume = await (typeof MasterResume !== 'undefined' ? MasterResume.getMasterResume() : '');
      } catch (_) {
        throw new Error('Could not load master resume. Set it in Settings.');
      }

      if (!masterResume || masterResume.trim().length < 100) {
        throw new Error('Master resume not configured. Please set it in Settings.');
      }

      // Step 3: Send to background service worker (fire-and-forget)
      showStatus('Generating resume with AI... (this may take a minute)', 'info');
      const ack = await chrome.runtime.sendMessage({
        action: 'generateResume',
        jobDescription: jobDescription.trim(),
        masterResume
      });

      if (ack?.received) {
        // Poll for completion status
        startPollingStatus();
      } else {
        showStatus('Failed to start generation.', 'error');
        btnGenerate.disabled = false;
      }
    } catch (e) {
      showStatus(e?.message || 'Generation failed.', 'error');
      btnGenerate.disabled = false;
    }
  }

  // On popup open, check if there's an in-progress generation
  chrome.runtime.sendMessage({ action: 'getGenerationStatus' }, (status) => {
    if (status?.state === 'generating') {
      showStatus(status.message, 'info');
      btnGenerate.disabled = true;
      startPollingStatus();
    } else if (status?.state === 'done') {
      showStatus(status.message, 'success');
    } else if (status?.state === 'error') {
      showStatus(status.message, 'error');
    }
  });

  btnGenerate?.addEventListener('click', generateResume);

  const optLink = document.getElementById('optionsLink');
  if (optLink) optLink.href = chrome.runtime.getURL('options/options.html');
})();
