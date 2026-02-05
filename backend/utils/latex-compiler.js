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

        await execFileAsync(engine, ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], {
            cwd: tmpDir,
            timeout: 30000,
        });

        const pdfBuffer = await fs.readFile(pdfPath);
        console.log('  ✅ Local LaTeX compilation successful');
        return pdfBuffer;
    } catch (err) {
        const msg = err?.message || String(err);
        if (err && err.code === 'ENOENT') {
            throw new Error(`Local LaTeX compilation failed: ${engine} not found. Install a TeX distribution or set LATEX_COMPILER=remote.`);
        }
        throw new Error(`Local LaTeX compilation failed: ${msg}`);
    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (_) { }
    }
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
    extractLatexFromResponse,
    getPdfPageCount,
};

async function getPdfPageCount(pdfBuffer) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    return pdfDoc.getPageCount();
}
