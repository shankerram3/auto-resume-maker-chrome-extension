/**
 * Background service worker: LLM API calls, LaTeX compilation, PDF download.
 */

// Import backend handler
importScripts('backend-handler.js');

const RESUME_SYSTEM_PROMPT = `You are an expert technical recruiter and professional resume writer specializing in ATS-optimized LaTeX resumes.

Generate a **custom 2-page resume in Overleaf-compatible LaTeX** using:
1. The **job description** I provide  
2. The **master resume** I provide  

You must:
- Select and reorder skills, projects, and experience to best match the job  
- Rewrite bullet points to emphasize relevance  
- Remove irrelevant content  
- Do NOT fabricate experience  
- Keep the resume **exactly 2 pages**  
- Maintain clean alignment and spacing  
- Output **ONLY LaTeX code** (no explanations)
- **CRITICAL: Escape all special LaTeX characters** (e.g. & -> \&, % -> \%, $ -> \$, _ -> \_)

MANDATORY LaTeX Template (USE THIS EXACT PREAMBLE):
\\documentclass[10.5pt,letterpaper]{article}

% Packages
\\usepackage[left=0.45in,right=0.45in,top=0.4in,bottom=0.4in]{geometry}
\\usepackage{enumitem}
\\usepackage{hyperref}
\\usepackage{titlesec}
\\usepackage{fontawesome5}
\\usepackage{xcolor}
\\usepackage{multicol}

% Colors
\\definecolor{linkblue}{RGB}{0,0,139}

% Hyperlink setup
\\hypersetup{
    colorlinks=true,
    linkcolor=linkblue,
    urlcolor=linkblue,
    pdftitle={Resume},
}

% Remove page numbers
\\pagestyle{empty}

% Section formatting
\\titleformat{\\section}{\\large\\bfseries\\uppercase}{}{0em}{}[\\titlerule]
\\titlespacing*{\\section}{0pt}{10pt}{6pt}

% Custom commands
\\newcommand{\\resumeItem}[1]{\\item{#1}}
\\newcommand{\\resumeSubheading}[4]{
    \\vspace{0pt}\\item[]
    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
        \\textbf{#1} & \\textbf{#2} \\\\
        \\textit{#3} & \\textit{#4} \\\\
    \\end{tabular*}\\vspace{0pt}
}
\\newcommand{\\projectHeading}[2]{
    \\vspace{0pt}\\item[]
    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
        \\textbf{#1} & \\textit{#2} \\\\
    \\end{tabular*}\\vspace{0pt}
}

% List settings
\\setlist[itemize]{leftmargin=0.15in, label={--}, nosep, topsep=2pt, itemsep=1.5pt, parsep=0pt}

\\begin{document}

Section Structure: Header (name, location, phone, email, LinkedIn, GitHub), Summary, Technical Skills, Professional Experience, Projects, Awards (optional), Education. Use the template structure from the user's master resume. Font size 10.5pt, margins 0.45in left/right, 0.4in top/bottom. Fit exactly 2 pages. Output ONLY valid LaTeX code with no markdown, no commentary, no code fences.`;

function extractLatexFromResponse(text) {
  if (!text || typeof text !== 'string') return null;
  let latex = text.trim();
  const fenceMatch = latex.match(/```(?:latex|tex)?\s*([\s\S]*?)```/);
  if (fenceMatch) latex = fenceMatch[1].trim();
  if (latex.includes('\\documentclass') && latex.includes('\\end{document}')) {
    return latex;
  }
  return null;
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['backendUrl', 'downloadSaveAs', 'downloadSubfolder'], (result) => {
      resolve({
        backendUrl: result.backendUrl || '',
        downloadSaveAs: result.downloadSaveAs !== false,
        downloadSubfolder: result.downloadSubfolder || ''
      });
    });
  });
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === 'generateResume') {
    handleGenerateResume(request.jobDescription, request.masterResume, request.requestId, request.jobTitle)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true;
  }
  if (request.action === 'downloadTex') {
    const base64 = btoa(unescape(encodeURIComponent(request.latex)));
    const url = `data:text/plain;charset=utf-8;base64,${base64}`;
    chrome.downloads.download(
      { url, filename: 'resume.tex', saveAs: true },
      () => {
        sendResponse({ success: true });
      }
    );
    return true;
  }
});

async function handleGenerateResume(jobDescription, masterResume, requestId, jobTitle) {
  const settings = await getSettings();

  // Backend URL is now required
  if (!settings.backendUrl) {
    return {
      success: false,
      error: 'Backend URL not configured. Please set backend URL in Options.'
    };
  }

  return await handleGenerateResumeViaBackend(
    settings.backendUrl,
    jobDescription,
    masterResume,
    {
      saveAs: settings.downloadSaveAs,
      subfolder: settings.downloadSubfolder,
      requestId,
      jobTitle
    }
  );
}
