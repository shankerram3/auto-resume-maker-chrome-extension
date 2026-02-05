/**
 * Extracts the "About the job" / job description from LinkedIn DOM or HTML string.
 * Uses multiple fallback selectors for robustness against LinkedIn's dynamic structure.
 */

(function (global) {
  'use strict';

  const JOB_HEADINGS = [
    'About the job',
    'About this job',
    'About the role',
    'Job description',
    'Description',
    'About'
  ];

  /**
   * Normalize text: trim, collapse whitespace.
   */
  function normalizeText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Check if an element's text matches any job heading (case-insensitive).
   */
  function isJobHeading(el) {
    const text = normalizeText(el.textContent || '');
    return JOB_HEADINGS.some(
      (h) => text.toLowerCase() === h.toLowerCase() || text.toLowerCase().startsWith(h.toLowerCase() + ' ')
    );
  }

  /**
   * Find the job description container by heading.
   */
  function findByHeading(doc) {
    const all = doc.querySelectorAll('h1, h2, h3, h4, h5, h6, span, div[class*="title"], strong');
    for (const el of all) {
      if (!isJobHeading(el)) continue;
      let container = el.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        const text = normalizeText(container.innerText || container.textContent || '');
        if (text.length > 200) return text;
        container = container.parentElement;
      }
      const next = el.nextElementSibling || el.parentElement?.nextElementSibling;
      if (next) {
        const text = normalizeText(next.innerText || next.textContent || '');
        if (text.length > 100) return text;
      }
    }
    return null;
  }

  /**
   * Find job description by JobDetails-related attributes.
   */
  function findByJobDetails(doc) {
    const candidates = doc.querySelectorAll('[componentkey*="JobDetails"], [data-view-name*="job"], [class*="job-details"], [class*="jobs-details"]');
    for (const el of candidates) {
      const parent = el.closest('section, article, [role="main"]') || el.parentElement;
      if (parent) {
        const text = normalizeText(parent.innerText || parent.textContent || '');
        if (text.length > 300) return text;
      }
      const text = normalizeText(el.innerText || el.textContent || '');
      if (text.length > 300) return text;
    }
    return null;
  }

  /**
   * Heuristic: find the longest meaningful text block that looks like a job description.
   */
  function findByHeuristic(doc) {
    const articles = doc.querySelectorAll('article, [role="main"], main, .jobs-search__job-details, .job-view-layout');
    let best = { text: '', len: 0 };
    for (const el of articles) {
      const text = normalizeText(el.innerText || el.textContent || '');
      if (text.length > 400 && text.length > best.len) {
        best = { text, len: text.length };
      }
    }
    if (best.len > 0) return best.text;

    const divs = doc.querySelectorAll('div');
    for (const el of divs) {
      const directText = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) directText.push(child.textContent);
      }
      const hasStructure = el.querySelector('p, ul, li, strong');
      const text = normalizeText(el.innerText || el.textContent || '');
      if (hasStructure && text.length > 500 && text.length > best.len) {
        best = { text, len: text.length };
      }
    }
    return best.len > 0 ? best.text : null;
  }

  /**
   * Extract job description from a document (DOM or parsed from HTML).
   * @param {Document} doc - DOM document
   * @returns {string|null} - Extracted job description or null
   */
  function extractFromDocument(doc) {
    if (!doc || !doc.querySelector) return null;
    const result = findByHeading(doc) || findByJobDetails(doc) || findByHeuristic(doc);
    return result && result.length > 100 ? result : null;
  }

  /**
   * Extract from a live DOM (e.g., document in content script).
   * @param {Document} [doc=document] - Optional document
   * @returns {string|null}
   */
  function extractFromDOM(doc) {
    return extractFromDocument(doc || (typeof document !== 'undefined' ? document : null));
  }

  /**
   * Extract from an HTML string (e.g., file content).
   * @param {string} html - Raw HTML string
   * @returns {string|null}
   */
  function extractFromHTML(html) {
    if (!html || typeof html !== 'string') return null;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      return extractFromDocument(doc);
    } catch (e) {
      return null;
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { extractFromDOM, extractFromHTML, extractFromDocument };
  } else {
    global.JobExtractor = { extractFromDOM, extractFromHTML, extractFromDocument };
  }
})(typeof window !== 'undefined' ? window : this);
