const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PDFDocument } = require('pdf-lib');

const execFileAsync = promisify(execFile);

const REMOTE_MAX_CHARS = 6000;
const DEFAULT_ENGINE = 'pdflatex';
const ERROR_NOTE_MARKER = '% === resume-generator error note ===';

/**
 * Compile LaTeX source to PDF using latexonline.cc
 * @param {string} latexSource - LaTeX source code
 * @returns {Promise<Buffer>} - PDF file as buffer
 */
async function compileLatexToPDF(latexSource) {
    const preferLocal = (process.env.LATEX_COMPILER || '').toLowerCase() === 'local';
    const shouldUseRemote = !preferLocal && latexSource.length <= REMOTE_MAX_CHARS;

    if (shouldUseRemote) {
        console.log('  → Preparing LaTeX compilation request...');
        console.log('  → Sending request to latexonline.cc...');
        const response = await fetch('https://latexonline.cc/compile?text=' + encodeURIComponent(latexSource), {
            method: 'GET',
        });

        if (response.ok) {
            console.log('  ✅ LaTeX compilation successful');
            return await response.buffer();
        }

        const errorText = await response.text();
        console.error('  ❌ LaTeX compilation failed:', response.status);
        console.error('  Error details:', errorText.substring(0, 200));

        if (response.status !== 414) {
            throw new Error(`LaTeX compilation failed: ${response.status} - ${errorText}`);
        }

        console.warn('  ⚠️  Remote compile rejected (414). Falling back to local compiler...');
    } else {
        console.log('  → Skipping remote compiler (document too large or local preferred)');
    }

    return await compileLatexLocally(latexSource);
}

async function compileLatexLocally(latexSource) {
    const engine = (process.env.LATEX_ENGINE || DEFAULT_ENGINE).trim() || DEFAULT_ENGINE;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tex-'));
    const texPath = path.join(tmpDir, 'main.tex');
    const pdfPath = path.join(tmpDir, 'main.pdf');

    try {
        await fs.writeFile(texPath, latexSource, 'utf8');
        console.log(`  → Compiling locally with ${engine}...`);

        await execFileAsync(engine, ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex'], {
            cwd: tmpDir,
            timeout: 30000,
            maxBuffer: 10 * 1024 * 1024,
        });

        const pdfBuffer = await fs.readFile(pdfPath);
        console.log('  ✅ Local LaTeX compilation successful');
        return pdfBuffer;
    } catch (err) {
        const msg = err?.message || String(err);
        let logSnippet = '';
        try {
            const logText = await fs.readFile(path.join(tmpDir, 'main.log'), 'utf8');
            const lines = logText.trim().split(/\r?\n/);
            logSnippet = lines.slice(-40).join('\n');
        } catch (_) { }

        if (logSnippet) {
            console.error('  LaTeX log tail:\n' + logSnippet);
        }

        if (err && err.code === 'ENOENT') {
            throw new Error(`Local LaTeX compilation failed: ${engine} not found. Install a TeX distribution or set LATEX_COMPILER=remote.`);
        }
        const details = logSnippet ? `\nLaTeX log tail:\n${logSnippet}` : '';
        throw new Error(`Local LaTeX compilation failed: ${msg}${details}`);
    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (_) { }
    }
}

function postProcessLatex(latexSource) {
    if (!latexSource || typeof latexSource !== 'string') {
        return { latex: latexSource || '', notes: ['Empty LaTeX source'], stats: {} };
    }

    const beginTag = '\\begin{document}';
    const endTag = '\\end{document}';
    const beginIndex = latexSource.indexOf(beginTag);
    const endIndex = latexSource.lastIndexOf(endTag);

    if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
        return { latex: latexSource, notes: ['Document markers not found'], stats: {} };
    }

    const preamble = latexSource.slice(0, beginIndex + beginTag.length);
    const body = latexSource.slice(beginIndex + beginTag.length, endIndex);
    const tail = latexSource.slice(endIndex);

    const stats = {
        escapedSpecials: 0,
        escapedRightBraces: 0,
        addedRightBraces: 0,
    };

    const escapedBody = escapeSpecialsInBody(body, stats);
    const balancedBody = balanceBracesInBody(escapedBody, stats);

    const notes = [];
    if (stats.escapedSpecials) notes.push(`Escaped ${stats.escapedSpecials} special characters.`);
    if (stats.escapedRightBraces) notes.push(`Escaped ${stats.escapedRightBraces} stray right braces.`);
    if (stats.addedRightBraces) notes.push(`Added ${stats.addedRightBraces} missing right braces.`);

    return {
        latex: preamble + balancedBody + tail,
        notes,
        stats,
    };
}

function escapeSpecialsInBody(body, stats) {
    let out = '';

    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        const prev = i > 0 ? body[i - 1] : '';

        if (ch === '%' && prev !== '\\') {
            const window = body.slice(Math.max(0, i - 3), i);
            if (/\d\s*$/.test(window)) {
                out += '\\%';
                stats.escapedSpecials += 1;
            } else {
                out += '%';
            }
            continue;
        }

        if ((ch === '#' || ch === '$' || ch === '_') && prev !== '\\') {
            out += `\\${ch}`;
            stats.escapedSpecials += 1;
            continue;
        }

        out += ch;
    }

    return out;
}

function balanceBracesInBody(body, stats) {
    let out = '';
    let depth = 0;
    let inComment = false;

    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        const prev = i > 0 ? body[i - 1] : '';

        if (inComment) {
            out += ch;
            if (ch === '\n') inComment = false;
            continue;
        }

        if (ch === '%' && prev !== '\\') {
            inComment = true;
            out += ch;
            continue;
        }

        if (ch === '{' && prev !== '\\') {
            depth += 1;
            out += ch;
            continue;
        }

        if (ch === '}' && prev !== '\\') {
            if (depth === 0) {
                out += '\\}';
                stats.escapedRightBraces += 1;
            } else {
                depth -= 1;
                out += ch;
            }
            continue;
        }

        out += ch;
    }

    if (depth > 0) {
        out += '}'.repeat(depth);
        stats.addedRightBraces += depth;
    }

    return out;
}

function addErrorNoteToLatex(latexSource, noteLines) {
    if (!latexSource || typeof latexSource !== 'string') return latexSource || '';
    if (latexSource.includes(ERROR_NOTE_MARKER)) return latexSource;

    const safeLines = Array.isArray(noteLines) ? noteLines : [String(noteLines || '')];
    const flattened = safeLines
        .flatMap((line) => String(line).split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const commentBlock = [
        ERROR_NOTE_MARKER,
        ...flattened.map((line) => `% ${line}`),
        '% === end note ===',
        '',
    ].join('\n');

    return commentBlock + latexSource;
}

/**
 * Extract LaTeX code from LLM response
 * @param {string} text - Response text from LLM
 * @returns {string|null} - Extracted LaTeX code or null
 */
function extractLatexFromResponse(text) {
    if (!text || typeof text !== 'string') return null;

    let latex = text.trim();

    // Try to extract from code fence
    const fenceMatch = latex.match(/```(?:latex|tex)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        latex = fenceMatch[1].trim();
    }

    // Validate it looks like LaTeX
    if (latex.includes('\\documentclass') && latex.includes('\\end{document}')) {
        return latex;
    }

    return null;
}

module.exports = {
    compileLatexToPDF,
    postProcessLatex,
    addErrorNoteToLatex,
    extractLatexFromResponse,
    getPdfPageCount,
};

async function getPdfPageCount(pdfBuffer) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    return pdfDoc.getPageCount();
}
