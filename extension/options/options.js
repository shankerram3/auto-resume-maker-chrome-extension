(function () {
  'use strict';

  const backendUrlEl = document.getElementById('backendUrl');
  const masterResumeEl = document.getElementById('masterResume');
  const btnUseDefault = document.getElementById('btnUseDefault');
  const btnSave = document.getElementById('btnSave');
  const saveStatusEl = document.getElementById('saveStatus');

  const resumeUpload = document.getElementById('resumeUpload');

  function showSaveStatus(text) {
    saveStatusEl.textContent = text;
    setTimeout(() => { saveStatusEl.textContent = ''; }, 3000);
  }

  async function load() {
    try {
      console.log('Options page loading...');

      if (typeof pdfjsLib === 'undefined') {
        console.warn('pdfjsLib is not defined. PDF upload may not work.');
      } else {
        console.log('pdfjsLib loaded.');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
      }

      const result = await new Promise((resolve) => {
        chrome.storage.local.get(['backendUrl'], (r) => {
          if (chrome.runtime.lastError) console.error(chrome.runtime.lastError);
          resolve(r);
        });
      });
      backendUrlEl.value = result.backendUrl || '';

      const masterResume = await (typeof MasterResume !== 'undefined' ? MasterResume.getStoredResume() : null);
      const defaultResume = await (typeof MasterResume !== 'undefined' ? MasterResume.fetchDefaultResume() : '');
      masterResumeEl.value = masterResume ?? defaultResume ?? '';
    } catch (error) {
      console.error('Error in load():', error);
      showSaveStatus('Error loading: ' + error.message);
    }
  }

  async function useDefaultResume() {
    const defaultResume = await (typeof MasterResume !== 'undefined' ? MasterResume.fetchDefaultResume() : '');
    masterResumeEl.value = defaultResume;
    showSaveStatus('Loaded default resume.');
  }

  async function save() {
    const backendUrl = backendUrlEl.value.trim();
    const masterResume = masterResumeEl.value.trim();

    chrome.storage.local.set({ backendUrl }, () => {
      if (chrome.runtime.lastError) {
        showSaveStatus('Error saving settings.');
        return;
      }
    });

    if (typeof MasterResume !== 'undefined') {
      try {
        await MasterResume.saveMasterResume(masterResume);
        showSaveStatus('Saved.');
      } catch (error) {
        console.error('Error saving master resume:', error);
        showSaveStatus('Error: Resume too large or storage quota exceeded.');
      }
    } else {
      chrome.storage.local.set({ masterResume }, () => {
        if (chrome.runtime.lastError) {
          showSaveStatus('Error saving resume.');
        } else {
          showSaveStatus('Saved.');
        }
      });
    }
  }

  async function extractTextFromPdf(file) {
    if (typeof pdfjsLib === 'undefined') {
      console.error('pdf.js library is not loaded.');
      return '';
    }

    // Set worker source
    pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str).join(' ');
      fullText += pageText + '\n\n';
    }

    return fullText;
  }

  function handleFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    showSaveStatus('Reading file...');

    if (file.type === 'application/pdf') {
      extractTextFromPdf(file).then((text) => {
        masterResumeEl.value = text;
        showSaveStatus('PDF loaded. Please review formatting.');
      }).catch((err) => {
        console.error(err);
        showSaveStatus('Error reading PDF.');
      });
    } else {
      // Assume text/latex
      const reader = new FileReader();
      reader.onload = (ev) => {
        masterResumeEl.value = ev.target.result;
        showSaveStatus('File loaded.');
      };
      reader.onerror = () => showSaveStatus('Error reading file.');
      reader.readAsText(file);
    }

    // Reset input so same file can be selected again
    e.target.value = '';
  }

  btnUseDefault?.addEventListener('click', useDefaultResume);
  btnSave?.addEventListener('click', save);
  resumeUpload?.addEventListener('change', handleFileSelect);

  load();
})();
