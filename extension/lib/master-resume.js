/**
 * Provides master resume content: default bundled resume or user's custom resume from storage.
 */

(function (global) {
  'use strict';

  const STORAGE_KEY = 'masterResume';
  const DEFAULT_URL = chrome?.runtime?.getURL
    ? chrome.runtime.getURL('assets/master-resume.txt')
    : '';

  let defaultResumeCache = null;

  /**
   * Fetch the default master resume from bundled assets.
   * @returns {Promise<string>}
   */
  async function fetchDefaultResume() {
    if (defaultResumeCache) return defaultResumeCache;
    try {
      const url = chrome.runtime.getURL('assets/master-resume.txt');
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to load default resume');
      defaultResumeCache = await res.text();
      return defaultResumeCache;
    } catch (e) {
      console.warn('Could not load default master resume:', e);
      return '';
    }
  }

  /**
   * Get user's custom master resume from chrome.storage.
   * @returns {Promise<string|null>} - Custom resume text or null if not set
   */
  async function getStoredResume() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        resolve(result[STORAGE_KEY] || null);
      });
    });
  }

  /**
   * Get the master resume: user's custom if set, otherwise default.
   * @returns {Promise<string>}
   */
  async function getMasterResume() {
    const custom = await getStoredResume();
    if (custom && custom.trim().length > 0) return custom.trim();
    return fetchDefaultResume();
  }

  /**
   * Save user's custom master resume.
   * @param {string} text
   */
  function saveMasterResume(text) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set({ [STORAGE_KEY]: text || '' }, () => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    });
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { getMasterResume, fetchDefaultResume, getStoredResume, saveMasterResume };
  } else {
    global.MasterResume = { getMasterResume, fetchDefaultResume, getStoredResume, saveMasterResume };
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
