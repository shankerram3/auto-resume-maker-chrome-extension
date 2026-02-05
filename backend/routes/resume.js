const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { RESUME_SYSTEM_PROMPT } = require('../config/prompt');
const { compileLatexToPDF, extractLatexFromResponse, getPdfPageCount } = require('../utils/latex-compiler');

const router = express.Router();

/**
 * POST /api/generate-resume
 * Generate a resume from job description and master resume
 */
router.post('/generate-resume', async (req, res) => {
    console.log('📥 Received resume generation request');
    try {
        const { jobDescription, masterResume } = req.body;
        console.log('📝 Job description length:', jobDescription?.length || 0);
        console.log('📄 Master resume length:', masterResume?.length || 0);

        // Validation
        if (!jobDescription || jobDescription.trim().length < 50) {
            return res.status(400).json({
                success: false,
                error: 'Job description is too short or missing.',
            });
        }

        if (!masterResume || masterResume.trim().length < 100) {
            return res.status(400).json({
                success: false,
                error: 'Master resume is missing or too short.',
            });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.error('❌ Anthropic API key not configured');
            return res.status(500).json({
                success: false,
                error: 'Anthropic API key not configured on server.',
            });
        }
        console.log('✅ API key found');

        // Call Anthropic API
        console.log('🤖 Calling Anthropic API...');
        const userMessage = `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`;
        const requestStart = Date.now();
        const controller = new AbortController();
        const timeoutMs = parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '120000', 10);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const progressId = setInterval(() => {
            const elapsed = Math.round((Date.now() - requestStart) / 1000);
            console.log(`⏳ Waiting for Anthropic response... ${elapsed}s`);
        }, 5000);

        let llmResponse;
        try {
            llmResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: 'claude-sonnet-4-5-20250929',
                    system: RESUME_SYSTEM_PROMPT,
                    messages: [
                        { role: 'user', content: userMessage },
                    ],
                    max_tokens: 4096,
                }),
                signal: controller.signal,
            });
            const elapsed = Math.round((Date.now() - requestStart) / 1000);
            console.log(`✅ Anthropic responded in ${elapsed}s (status ${llmResponse.status})`);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                return res.status(504).json({
                    success: false,
                    error: `Anthropic API timed out after ${Math.round(timeoutMs / 1000)}s.`,
                });
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            clearInterval(progressId);
        }

        if (!llmResponse.ok) {
            const errBody = await llmResponse.text();
            console.error('❌ Anthropic API error:', llmResponse.status);
            console.error('Error body:', errBody);
            let errMsg = `Anthropic API error: ${llmResponse.status}`;
            try {
                const j = JSON.parse(errBody);
                if (j.error?.message) errMsg = j.error.message;
            } catch (_) { }
            return res.status(500).json({ success: false, error: errMsg });
        }

        const data = await llmResponse.json();
        console.log('✅ Received response from Anthropic');
        const content = data.content?.[0]?.text;
        console.log('📝 Response content length:', content?.length || 0);
        const latex = extractLatexFromResponse(content);
        console.log('📄 LaTeX extracted:', latex ? 'Yes' : 'No');

        if (!latex) {
            return res.status(500).json({
                success: false,
                error: 'LLM did not return valid LaTeX.',
                rawContent: content ? content.substring(0, 500) : '',
            });
        }

        // Compile LaTeX to PDF with 2-page guard
        console.log('🔨 Compiling LaTeX to PDF...');
        try {
            const { pdfBuffer, finalLatex, pageCount } = await compileWithTwoPageGuard(latex, apiKey);
            console.log(`✅ PDF compiled successfully (${pageCount} pages), size:`, pdfBuffer.length, 'bytes');

            // Save a copy to backend/output
            const outputDir = path.join(__dirname, '..', 'output');
            await fs.mkdir(outputDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = path.join(outputDir, `resume-${timestamp}.pdf`);
            await fs.writeFile(outputPath, pdfBuffer);
            console.log('💾 Saved PDF to:', outputPath);

            // Send PDF as response
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
            res.send(pdfBuffer);
        } catch (compilationError) {
            // If compilation fails, return LaTeX source
            console.warn('⚠️  LaTeX compilation failed:', compilationError.message);
            return res.status(200).json({
                success: true,
                latex,
                compilationFailed: true,
                error: 'LaTeX compilation failed. Returning source code.',
            });
        }
    } catch (error) {
        console.error('❌ Error in /generate-resume:', error);
        console.error('Stack trace:', error.stack);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error',
        });
    }
});

module.exports = router;

async function compileWithTwoPageGuard(initialLatex, apiKey) {
    let latex = initialLatex;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const pdfBuffer = await compileLatexToPDF(latex);
        const pageCount = await getPdfPageCount(pdfBuffer);
        console.log(`📄 PDF page count: ${pageCount}`);

        if (pageCount <= 2) {
            return { pdfBuffer, finalLatex: latex, pageCount };
        }

        if (attempt === maxAttempts) {
            throw new Error(`PDF still exceeds 2 pages after ${maxAttempts} attempts.`);
        }

        console.log('✂️  Compressing LaTeX to fit 2 pages without losing quality...');
        latex = await refineLatexToTwoPages(latex, apiKey);
    }

    throw new Error('Unexpected error while enforcing 2-page limit.');
}

async function refineLatexToTwoPages(latex, apiKey) {
    const system = `You are a LaTeX resume editor. Your job is to compress a resume to fit exactly 2 pages WITHOUT abrupt cuts or loss of quality.
Rules:
- Preserve meaning and impact. Prefer rewriting and merging bullets over deleting.
- Shorten wording, remove filler, merge closely related bullets.
- Keep the same overall template and section order.
- Only drop content if absolutely necessary after compression.
- Output ONLY LaTeX (no markdown, no commentary).`;

    const user = `Compress the following LaTeX resume so it compiles to exactly 2 pages. Keep it high-quality and professional.

LaTeX:
${latex}`;

    const llmResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-5-20250929',
            system,
            messages: [{ role: 'user', content: user }],
            max_tokens: 4096,
        }),
    });

    if (!llmResponse.ok) {
        const errBody = await llmResponse.text();
        throw new Error(`Anthropic refine error: ${llmResponse.status} - ${errBody}`);
    }

    const data = await llmResponse.json();
    const content = data.content?.[0]?.text;
    const refined = extractLatexFromResponse(content) || content?.trim();
    if (!refined || !refined.includes('\\begin{document}')) {
        throw new Error('Refinement did not return valid LaTeX.');
    }
    return refined;
}
