(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const btnExtract = document.getElementById('btnExtract');
  const btnLoadFile = document.getElementById('btnLoadFile');
  const fileInput = document.getElementById('fileInput');
  const manualSection = document.getElementById('manualSection');
  const jobDescInput = document.getElementById('jobDescInput');
  const btnGenerate = document.getElementById('btnGenerate');

  let currentJobDescription = '';
  let userEdited = false;
  let persistTimer = null;

  const POPUP_DRAFT_KEY = 'popupDraft';
  const LAST_JOB_KEY = 'lastJobDescription';
  const LAST_JOB_URL_KEY = 'lastJobDescriptionUrl';
  const LAST_JOB_AT_KEY = 'lastJobDescriptionAt';

  function showStatus(message, type = 'info') {
    statusEl.textContent = message;
    statusEl.className = 'status ' + type;
    statusEl.classList.remove('hidden');
  }

  function hideStatus() {
    statusEl.classList.add('hidden');
  }

  function updateGenerateButton() {
    btnGenerate.disabled = !currentJobDescription || currentJobDescription.trim().length < 50;
  }

  function setJobDescription(text, options = {}) {
    currentJobDescription = text || '';
    if (jobDescInput) jobDescInput.value = currentJobDescription;
    updateGenerateButton();
    if (options.source && options.source !== 'manual') {
      userEdited = false;
    }
    if (options.persist !== false) {
      queuePersistDraft(options);
    }
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    });
  }

  function storageSet(values) {
    return new Promise((resolve) => {
      chrome.storage.local.set(values, () => resolve());
    });
  }

  async function getActiveTabInfo() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function queuePersistDraft(meta = {}) {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistDraft(meta).catch(() => {});
    }, 250);
  }

  async function persistDraft(meta = {}) {
    const tab = meta.tab || (meta.includeTab ? await getActiveTabInfo() : null);
    const draft = {
      text: currentJobDescription || '',
      source: meta.source || 'manual',
      url: meta.url || tab?.url || '',
      title: meta.title || tab?.title || '',
      updatedAt: Date.now(),
    };
    await storageSet({ [POPUP_DRAFT_KEY]: draft });
  }

  function describeDraftMismatch(draft, tab) {
    if (!draft?.url || !tab?.url) return '';
    if (draft.url === tab.url) return '';
    return 'Draft loaded from a different tab. Click “Extract from LinkedIn” to refresh.';
  }

  async function loadInitialState() {
    const tab = await getActiveTabInfo();
    const result = await storageGet([
      POPUP_DRAFT_KEY,
      LAST_JOB_KEY,
      LAST_JOB_URL_KEY,
      LAST_JOB_AT_KEY,
    ]);

    const draft = result[POPUP_DRAFT_KEY];
    const lastJobDescription = result[LAST_JOB_KEY];
    const lastJobUrl = result[LAST_JOB_URL_KEY];

    if (draft?.text) {
      setJobDescription(draft.text, { persist: false });
      const mismatch = describeDraftMismatch(draft, tab);
      if (mismatch) {
        showStatus(mismatch, 'info');
      } else if (draft.source === 'tab') {
        showStatus('Loaded job description from this tab.', 'success');
      }
      return;
    }

    if (lastJobDescription) {
      setJobDescription(lastJobDescription, { persist: false });
      if (lastJobUrl && tab?.url && lastJobUrl !== tab.url) {
        showStatus('Loaded job description from another tab. Click “Extract from LinkedIn” to refresh.', 'info');
      } else {
        showStatus('Loaded job description from page.', 'success');
      }
    }
  }

  async function extractFromCurrentTab() {
    showStatus('Extracting job description...', 'info');
    btnExtract.disabled = true;
    try {
      const tab = await getActiveTabInfo();
      if (!tab?.id) {
        showStatus('Could not access current tab.', 'error');
        return;
      }
      if (!tab.url || !tab.url.includes('linkedin.com/jobs')) {
        showStatus('Open a LinkedIn job page first, or use "Load from HTML File".', 'error');
        return;
      }
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'extractJobDescription' });
      } catch (err) {
        response = null;
      }
      if (response?.success && response.jobDescription) {
        setJobDescription(response.jobDescription, { source: 'tab', includeTab: true });
        await storageSet({
          [LAST_JOB_KEY]: response.jobDescription,
          [LAST_JOB_URL_KEY]: tab.url || '',
          [LAST_JOB_AT_KEY]: Date.now(),
        });
        showStatus('Job description extracted.', 'success');
      } else {
        // Fallback: try direct DOM extraction via scripting
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
          setJobDescription(fallbackText, { source: 'tab', includeTab: true });
          await storageSet({
            [LAST_JOB_KEY]: fallbackText,
            [LAST_JOB_URL_KEY]: tab.url || '',
            [LAST_JOB_AT_KEY]: Date.now(),
          });
          showStatus('Job description extracted.', 'success');
        } else {
          showStatus('Could not find job description. Try "Load from HTML File" or paste manually.', 'error');
        }
      }
    } catch (e) {
      showStatus('Extraction failed. Load from file or paste manually.', 'error');
    } finally {
      btnExtract.disabled = false;
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    showStatus('Reading file...', 'info');
    const reader = new FileReader();
    reader.onload = () => {
      const html = reader.result;
      const text = typeof JobExtractor !== 'undefined' ? JobExtractor.extractFromHTML(html) : null;
      if (text) {
        setJobDescription(text, { source: 'file' });
        showStatus('Job description extracted from file.', 'success');
      } else {
        showStatus('Could not find job description in this file.', 'error');
      }
    };
    reader.readAsText(file);
    fileInput.value = '';
  }

  async function generateResume() {
    if (!currentJobDescription || currentJobDescription.trim().length < 50) {
      showStatus('Please provide a job description first.', 'error');
      return;
    }

    showStatus('Getting master resume...', 'info');
    let masterResume = '';
    try {
      masterResume = await (typeof MasterResume !== 'undefined' ? MasterResume.getMasterResume() : '');
    } catch (e) {
      showStatus('Could not load master resume.', 'error');
      return;
    }

    showStatus('Generating resume with AI...', 'info');
    btnGenerate.disabled = true;

    try {
      const result = await chrome.runtime.sendMessage({
        action: 'generateResume',
        jobDescription: currentJobDescription.trim(),
        masterResume
      });

      if (result?.success) {
        showStatus('PDF download started!', 'success');
      } else if (result?.downloadTex) {
        chrome.runtime.sendMessage({ action: 'downloadTex', latex: result.latex }, () => {
          showStatus('LaTeX compilation failed. Downloaded .tex file instead.', 'info');
        });
      } else {
        showStatus(result?.error || 'Generation failed.', 'error');
      }
    } catch (e) {
      showStatus(e?.message || 'Generation failed.', 'error');
    } finally {
      btnGenerate.disabled = false;
      updateGenerateButton();
    }
  }

  jobDescInput?.addEventListener('input', () => {
    currentJobDescription = jobDescInput.value;
    userEdited = true;
    updateGenerateButton();
    queuePersistDraft({ source: 'manual' });
  });

  jobDescInput?.addEventListener('paste', () => {
    setTimeout(() => {
      currentJobDescription = jobDescInput.value;
      userEdited = true;
      updateGenerateButton();
      queuePersistDraft({ source: 'manual' });
    }, 0);
  });

  btnExtract?.addEventListener('click', extractFromCurrentTab);
  btnLoadFile?.addEventListener('click', () => fileInput.click());
  fileInput?.addEventListener('change', handleFileSelect);
  btnGenerate?.addEventListener('click', generateResume);

  manualSection?.classList.remove('hidden');
  const optLink = document.getElementById('optionsLink');
  if (optLink) optLink.href = chrome.runtime.getURL('options/options.html');
  updateGenerateButton();
  loadInitialState();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (userEdited) return;
    const changedLastJob = changes[LAST_JOB_KEY]?.newValue;
    if (changedLastJob) {
      setJobDescription(changedLastJob, { persist: false });
      showStatus('Job description updated from page.', 'success');
    }
  });
})();
