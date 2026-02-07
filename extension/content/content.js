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
.resume-gen-match-badge {
  position: fixed;
  right: 20px;
  bottom: 72px;
  z-index: 99999;
  background: #0b0f19;
  border: 1px solid #1f2937;
  border-radius: 14px;
  padding: 10px 14px;
  font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #e5e7eb;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
  min-width: 140px;
  cursor: default;
  transition: all 0.2s ease;
  opacity: 0;
  transform: translateY(6px);
}
.resume-gen-match-badge.show {
  opacity: 1;
  transform: translateY(0);
}
.resume-gen-match-badge .match-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.resume-gen-match-badge .match-percent {
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}
.resume-gen-match-badge .match-label {
  font-size: 11px;
  color: #9ca3af;
  line-height: 1.2;
}
.resume-gen-match-badge .match-ring {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
}
.resume-gen-match-badge .match-ring circle {
  fill: none;
  stroke-width: 3.5;
  stroke-linecap: round;
}
.resume-gen-match-badge .match-ring .ring-bg {
  stroke: #1f2937;
}
.resume-gen-match-badge .match-ring .ring-fill {
  transition: stroke-dashoffset 0.6s ease;
}
.resume-gen-match-badge .match-bar {
  height: 4px;
  background: #1f2937;
  border-radius: 4px;
  overflow: hidden;
  margin-top: 4px;
}
.resume-gen-match-badge .match-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.5s ease;
}
.resume-gen-match-badge .match-details {
  display: none;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #1f2937;
  font-size: 11px;
  color: #9ca3af;
  max-height: 160px;
  overflow-y: auto;
}
.resume-gen-match-badge:hover .match-details {
  display: block;
}
.resume-gen-match-badge .match-details .match-found {
  color: #4ade80;
}
.resume-gen-match-badge .match-details .match-missing {
  color: #f87171;
}
.resume-gen-match-badge .match-details div {
  margin-bottom: 3px;
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
    const base = backendUrl.replace(/\/+$/, '');
    const url = base + '/api/progress/' + encodeURIComponent(requestId);
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

  // ── Match Score Logic ──────────────────────────────────────────────

  // Common filler words to ignore during keyword extraction
  const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with','by',
    'from','as','is','are','was','were','be','been','being','have','has','had',
    'do','does','did','will','would','could','should','may','might','shall',
    'can','need','must','about','above','after','before','between','into','through',
    'during','without','within','along','following','across','behind','beyond','plus',
    'except','up','out','around','down','off','over','under','again','further',
    'then','once','here','there','when','where','why','how','all','each','every',
    'both','few','more','most','other','some','such','no','nor','not','only',
    'own','same','so','than','too','very','just','because','if','while','although',
    'though','after','before','until','unless','since','that','this','these','those',
    'it','its','we','our','you','your','they','their','them','he','she','his','her',
    'who','which','what','whom','whose','also','like','well','get','make','take',
    'work','use','know','new','way','able','etc','via','per','using','based',
    'including','related','preferred','required','strong','experience','years','year',
    'team','role','position','company','ability','skills','knowledge','understanding',
    'working','building','developing','looking','join','ideal','candidate','responsible',
    'minimum','plus','equivalent','bachelor','master','degree','education',
  ]);

  /**
   * Extract meaningful keywords/phrases from text.
   * Returns a Set of lowercase normalized terms.
   */
  function extractKeywords(text) {
    if (!text) return new Set();
    const normalized = text.toLowerCase().replace(/[^a-z0-9+#.\-\/\s]/g, ' ');
    const words = normalized.split(/\s+/).filter(w => w.length > 1);
    const keywords = new Set();

    // Single meaningful words (tech terms, tools, etc.)
    for (const word of words) {
      if (!STOP_WORDS.has(word) && word.length > 2) {
        keywords.add(word);
      }
    }

    // Bigrams for multi-word tech terms (e.g., "machine learning", "ci/cd")
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (!STOP_WORDS.has(words[i]) && !STOP_WORDS.has(words[i + 1])) {
        keywords.add(bigram);
      }
    }

    return keywords;
  }

  // Well-known tech skills/tools to prioritize in matching
  const TECH_TERMS = new Set([
    'python','java','javascript','typescript','react','angular','vue','node.js','nodejs',
    'express','django','flask','fastapi','spring','docker','kubernetes','k8s','aws','azure',
    'gcp','terraform','ansible','jenkins','ci/cd','git','github','gitlab','sql','nosql',
    'postgresql','mysql','mongodb','redis','elasticsearch','kafka','rabbitmq','graphql',
    'rest','api','microservices','agile','scrum','jira','confluence','figma',
    'machine learning','deep learning','nlp','computer vision','pytorch','tensorflow',
    'pandas','numpy','scikit-learn','spark','hadoop','databricks','snowflake','airflow',
    'linux','bash','shell','c++','c#','rust','go','golang','kotlin','swift','scala',
    'html','css','sass','tailwind','webpack','vite','next.js','nextjs','nuxt',
    'redux','mobx','zustand','storybook','jest','cypress','selenium','playwright',
    'firebase','supabase','vercel','netlify','heroku','cloudflare',
    'langchain','openai','llm','rag','vector','embeddings','fine-tuning',
    'oauth','jwt','saml','sso','rbac',
    'prometheus','grafana','datadog','splunk','new relic',
    'figma','sketch','adobe','photoshop','illustrator',
    's3','ec2','lambda','dynamodb','rds','ecs','eks','fargate','sagemaker',
    'blockchain','web3','solidity','ethereum',
  ]);

  /**
   * Calculate match score between job description and master resume.
   * Returns { percent, matched, missing, total }
   */
  function calculateMatchScore(jobText, resumeText) {
    const jobKeywords = extractKeywords(jobText);
    const resumeLower = resumeText.toLowerCase();

    // Focus on the most relevant keywords (tech terms that appear in both sets, or job-specific terms)
    const relevantKeywords = new Set();
    for (const kw of jobKeywords) {
      // Prioritize known tech terms
      if (TECH_TERMS.has(kw)) {
        relevantKeywords.add(kw);
        continue;
      }
      // Include terms that look technical (contain digits, dots, slashes, hashes, plus)
      if (/[0-9.+#\/]/.test(kw) && kw.length > 1) {
        relevantKeywords.add(kw);
        continue;
      }
      // Include capitalized-looking bigrams or longer single words (likely proper nouns/tools)
      if (kw.length >= 4 && !STOP_WORDS.has(kw)) {
        relevantKeywords.add(kw);
      }
    }

    if (relevantKeywords.size === 0) {
      return { percent: 0, matched: [], missing: [], total: 0 };
    }

    const matched = [];
    const missing = [];

    for (const kw of relevantKeywords) {
      if (resumeLower.includes(kw)) {
        matched.push(kw);
      } else {
        missing.push(kw);
      }
    }

    // Weight tech terms higher
    let matchedWeight = 0;
    let totalWeight = 0;
    for (const kw of relevantKeywords) {
      const weight = TECH_TERMS.has(kw) ? 2 : 1;
      totalWeight += weight;
      if (resumeLower.includes(kw)) {
        matchedWeight += weight;
      }
    }

    const percent = totalWeight > 0 ? Math.round((matchedWeight / totalWeight) * 100) : 0;

    // Sort: tech terms first, then alphabetically
    const sortFn = (a, b) => {
      const aIsTech = TECH_TERMS.has(a) ? 0 : 1;
      const bIsTech = TECH_TERMS.has(b) ? 0 : 1;
      if (aIsTech !== bIsTech) return aIsTech - bIsTech;
      return a.localeCompare(b);
    };
    matched.sort(sortFn);
    missing.sort(sortFn);

    return { percent, matched, missing, total: relevantKeywords.size };
  }

  /**
   * Get the color for a match percentage.
   */
  function getMatchColor(percent) {
    if (percent >= 70) return '#4ade80'; // green
    if (percent >= 45) return '#facc15'; // yellow
    return '#f87171'; // red
  }

  let lastMatchJobText = null;
  let matchBadgeTimer = null;

  /**
   * Debounced wrapper for match badge updates.
   */
  function updateMatchBadge() {
    if (matchBadgeTimer) return; // already scheduled
    matchBadgeTimer = setTimeout(() => {
      matchBadgeTimer = null;
      _updateMatchBadgeImpl();
    }, 300);
  }

  /**
   * Create or update the floating match badge.
   */
  async function _updateMatchBadgeImpl() {
    const jobText = extractAboutJob();
    if (!jobText || jobText.length < 50) {
      // Remove badge if no job description
      const existing = document.querySelector('.resume-gen-match-badge');
      if (existing) existing.classList.remove('show');
      lastMatchJobText = null;
      return;
    }

    // Skip if job text hasn't changed
    if (lastMatchJobText === jobText) return;
    lastMatchJobText = jobText;

    // Get master resume
    let resumeText = '';
    if (typeof MasterResume !== 'undefined') {
      resumeText = await MasterResume.getMasterResume();
    } else {
      resumeText = await new Promise((resolve) => {
        chrome.storage.local.get(['masterResume'], (r) => resolve(r.masterResume || ''));
      });
    }

    if (!resumeText || resumeText.length < 50) {
      const existing = document.querySelector('.resume-gen-match-badge');
      if (existing) existing.classList.remove('show');
      return;
    }

    const score = calculateMatchScore(jobText, resumeText);

    // Build or update the badge
    let badge = document.querySelector('.resume-gen-match-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'resume-gen-match-badge';
      document.body.appendChild(badge);
    }

    const color = getMatchColor(score.percent);
    const circumference = 2 * Math.PI * 15; // radius = 15
    const dashOffset = circumference - (score.percent / 100) * circumference;

    const topMatched = score.matched.slice(0, 8);
    const topMissing = score.missing.slice(0, 8);

    badge.innerHTML = `
      <div class="match-header">
        <svg class="match-ring" viewBox="0 0 38 38">
          <circle class="ring-bg" cx="19" cy="19" r="15"/>
          <circle class="ring-fill" cx="19" cy="19" r="15"
            stroke="${color}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashOffset}"
            transform="rotate(-90 19 19)"/>
        </svg>
        <div>
          <div class="match-percent" style="color:${color}">${score.percent}%</div>
          <div class="match-label">Job Match</div>
        </div>
      </div>
      <div class="match-bar">
        <div class="match-bar-fill" style="width:${score.percent}%;background:${color}"></div>
      </div>
      <div class="match-details">
        ${topMatched.length > 0 ? `<div style="margin-bottom:5px;color:#6b7280;font-size:10px">✅ Matched Skills</div>` : ''}
        ${topMatched.map(k => `<div class="match-found">✓ ${k}</div>`).join('')}
        ${topMissing.length > 0 ? `<div style="margin-top:6px;margin-bottom:5px;color:#6b7280;font-size:10px">⚠️ Missing Skills</div>` : ''}
        ${topMissing.map(k => `<div class="match-missing">✗ ${k}</div>`).join('')}
        ${score.matched.length + score.missing.length > 16 ? `<div style="margin-top:4px;color:#6b7280;font-size:10px">and ${score.total - 16} more…</div>` : ''}
      </div>
    `;

    // Show with animation
    requestAnimationFrame(() => badge.classList.add('show'));
  }

  // ────────────────────────────────────────────────────────────────────

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
    updateMatchBadge();

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
