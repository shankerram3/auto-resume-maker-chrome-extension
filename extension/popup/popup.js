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

  function setJobDescription(text) {
    currentJobDescription = text || '';
    if (jobDescInput) jobDescInput.value = currentJobDescription;
    updateGenerateButton();
  }

  function loadLastJobDescription() {
    chrome.storage.local.get(['lastJobDescription'], (result) => {
      if (!currentJobDescription && result.lastJobDescription) {
        setJobDescription(result.lastJobDescription);
        showStatus('Loaded job description from page.', 'success');
      }
    });
  }

  async function extractFromCurrentTab() {
    showStatus('Extracting job description...', 'info');
    btnExtract.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showStatus('Could not access current tab.', 'error');
        return;
      }
      if (!tab.url || !tab.url.includes('linkedin.com/jobs')) {
        showStatus('Open a LinkedIn job page first, or use "Load from HTML File".', 'error');
        return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractJobDescription' });
      if (response?.success && response.jobDescription) {
        setJobDescription(response.jobDescription);
        showStatus('Job description extracted.', 'success');
      } else {
        showStatus('Could not find job description. Try "Load from HTML File" or paste manually.', 'error');
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
        setJobDescription(text);
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
    updateGenerateButton();
  });

  jobDescInput?.addEventListener('paste', () => {
    setTimeout(() => {
      currentJobDescription = jobDescInput.value;
      updateGenerateButton();
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
  loadLastJobDescription();
})();
