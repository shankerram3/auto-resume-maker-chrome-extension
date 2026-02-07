const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { RESUME_SYSTEM_PROMPT } = require('../config/prompt');
const {
    compileLatexToPDF,
    extractLatexFromResponse,
    getPdfPageCount,
    postProcessLatex,
    addErrorNoteToLatex,
} = require('../utils/latex-compiler');

const router = express.Router();
const progressClients = new Map();
const progressLast = new Map();
const stageAverages = {
    llm: 60,
    refine: 20,
    compile: 8,
};

function updateAverage(stage, durationSeconds) {
    if (!durationSeconds || durationSeconds <= 0 || !Number.isFinite(durationSeconds)) return;
    const prev = stageAverages[stage] || durationSeconds;
    stageAverages[stage] = Math.round(prev * 0.7 + durationSeconds * 0.3);
}

function estimateRemaining(stages) {
    return Math.max(
        0,
        Math.round(stages.reduce((sum, stage) => sum + (stageAverages[stage] || 0), 0))
    );
}

function sendProgress(requestId, payload) {
    if (!requestId) return;
    const data = {
        timestamp: new Date().toISOString(),
        ...payload,
    };
    progressLast.set(requestId, data);
    const client = progressClients.get(requestId);
    if (client) {
        client.res.write(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
    }
}

function closeProgress(requestId) {
    if (!requestId) return;
    const client = progressClients.get(requestId);
    if (client) {
        clearInterval(client.keepAlive);
        client.res.end();
        progressClients.delete(requestId);
    }
    setTimeout(() => progressLast.delete(requestId), 300000);
}

router.get('/progress/:id', (req, res) => {
    const { id } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders?.();

    const keepAlive = setInterval(() => {
        res.write('event: ping\ndata: {}\n\n');
    }, 15000);

    progressClients.set(id, { res, keepAlive });
    const last = progressLast.get(id);
    if (last) {
        res.write(`event: progress\ndata: ${JSON.stringify(last)}\n\n`);
    } else {
        res.write(`event: progress\ndata: ${JSON.stringify({ stage: 'connected', percent: 0 })}\n\n`);
    }

    req.on('close', () => {
        clearInterval(keepAlive);
        progressClients.delete(id);
    });
});

/**
 * POST /api/generate-resume
 * Generate a resume from job description and master resume
 */
router.post('/generate-resume', async (req, res) => {
    console.log('📥 Received resume generation request');
    try {
        const requestId = req.get('x-request-id') || req.body?.requestId || null;
        const { jobDescription, masterResume } = req.body;
        console.log('📝 Job description length:', jobDescription?.length || 0);
        console.log('📄 Master resume length:', masterResume?.length || 0);
        const startedAt = Date.now();
        sendProgress(requestId, {
            stage: 'received',
            percent: 5,
            message: 'Request received',
            etaSeconds: estimateRemaining(['llm', 'compile']),
        });

        // Validation
        if (!jobDescription || jobDescription.trim().length < 50) {
            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'Job description is too short or missing.',
            });
            return res.status(400).json({
                success: false,
                error: 'Job description is too short or missing.',
            });
        }

        if (!masterResume || masterResume.trim().length < 100) {
            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'Master resume is missing or too short.',
            });
            return res.status(400).json({
                success: false,
                error: 'Master resume is missing or too short.',
            });
        }

        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.error('❌ Anthropic API key not configured');
            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'Anthropic API key not configured.',
            });
            return res.status(500).json({
                success: false,
                error: 'Anthropic API key not configured on server.',
            });
        }
        console.log('✅ API key found');

        // Call Anthropic API
        console.log('🤖 Calling Anthropic API...');
        sendProgress(requestId, {
            stage: 'llm_start',
            percent: 15,
            message: 'Calling AI model...',
            etaSeconds: estimateRemaining(['llm', 'compile']),
        });
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
            updateAverage('llm', elapsed);
            sendProgress(requestId, {
                stage: 'llm_done',
                percent: 60,
                message: 'AI response received',
                etaSeconds: estimateRemaining(['compile']),
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                sendProgress(requestId, {
                    stage: 'error',
                    percent: 100,
                    message: `Anthropic API timed out after ${Math.round(timeoutMs / 1000)}s.`,
                });
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
            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'LLM did not return valid LaTeX.',
            });
            return res.status(500).json({
                success: false,
                error: 'LLM did not return valid LaTeX.',
                rawContent: content ? content.substring(0, 500) : '',
            });
        }

        // Compile LaTeX to PDF with 2-page guard
        console.log('🔨 Compiling LaTeX to PDF...');
        sendProgress(requestId, {
            stage: 'compile_start',
            percent: 75,
            message: 'Compiling LaTeX to PDF...',
            etaSeconds: estimateRemaining(['compile']),
        });
        try {
            const { pdfBuffer, finalLatex, pageCount } = await compileWithTwoPageGuard(latex, apiKey, requestId);
            console.log(`✅ PDF compiled successfully (${pageCount} pages), size:`, pdfBuffer.length, 'bytes');

            // Save a copy to backend/output
            const outputDir = path.join(__dirname, '..', 'output');
            await fs.mkdir(outputDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = path.join(outputDir, `resume-${timestamp}.pdf`);
            await fs.writeFile(outputPath, pdfBuffer);
            console.log('💾 Saved PDF to:', outputPath);
            const totalElapsed = Math.round((Date.now() - startedAt) / 1000);
            sendProgress(requestId, {
                stage: 'done',
                percent: 100,
                message: `Resume ready (took ${totalElapsed}s)`,
                etaSeconds: 0,
            });
            closeProgress(requestId);

            // Send PDF as response
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
            res.send(pdfBuffer);
        } catch (compilationError) {
            // If compilation fails, save LaTeX and return .tex download with error note
            console.warn('⚠️  LaTeX compilation failed:', compilationError.message);
            const failedLatex = compilationError.lastLatex || latex;
            const noteLines = [
                'AUTOMATIC ERROR NOTE (Resume Generator)',
                `Timestamp: ${new Date().toISOString()}`,
                `Compilation error: ${String(compilationError.message || 'Unknown error')}`.slice(0, 2000),
            ];
            if (compilationError.postProcessNotes?.length) {
                noteLines.push(`Post-processing: ${compilationError.postProcessNotes.join(' ')}`);
            }
            const notedLatex = addErrorNoteToLatex(failedLatex, noteLines);

            try {
                const outputDir = path.join(__dirname, '..', 'output');
                await fs.mkdir(outputDir, { recursive: true });
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const outputPath = path.join(outputDir, `resume-${timestamp}-failed.tex`);
                await fs.writeFile(outputPath, notedLatex, 'utf8');
                console.log('💾 Saved failed LaTeX to:', outputPath);
            } catch (writeErr) {
                console.warn('⚠️  Failed to save LaTeX file:', writeErr?.message || writeErr);
            }

            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'LaTeX compilation failed. Returning .tex for manual fixes.',
            });
            closeProgress(requestId);
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="resume-error.tex"');
            return res.status(200).send(notedLatex);
        }
    } catch (error) {
        console.error('❌ Error in /generate-resume:', error);
        console.error('Stack trace:', error.stack);
        const requestId = req.get('x-request-id') || req.body?.requestId || null;
        sendProgress(requestId, {
            stage: 'error',
            percent: 100,
            message: error.message || 'Internal server error',
        });
        closeProgress(requestId);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error',
        });
    }
});

module.exports = router;

async function compileWithTwoPageGuard(initialLatex, apiKey, requestId) {
    let latex = initialLatex;
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        sendProgress(requestId, {
            stage: 'compile_pass',
            percent: 75,
            message: `Compiling PDF (pass ${attempt}/${maxAttempts})...`,
            etaSeconds: estimateRemaining(['compile']),
        });
        const post = postProcessLatex(latex);
        latex = post.latex;
        if (post.notes.length) {
            console.log('🧹 Post-processed LaTeX:', post.notes.join(' '));
        }
        const compileStart = Date.now();
        let pdfBuffer;
        try {
            pdfBuffer = await compileLatexToPDF(latex);
        } catch (err) {
            err.lastLatex = latex;
            err.postProcessNotes = post.notes;
            throw err;
        }
        updateAverage('compile', Math.round((Date.now() - compileStart) / 1000));
        const pageCount = await getPdfPageCount(pdfBuffer);
        console.log(`📄 PDF page count: ${pageCount}`);

        if (pageCount <= 2) {
            return { pdfBuffer, finalLatex: latex, pageCount };
        }

        if (attempt === maxAttempts) {
            const err = new Error(`PDF still exceeds 2 pages after ${maxAttempts} attempts.`);
            err.lastLatex = latex;
            throw err;
        }

        console.log('✂️  Compressing LaTeX to fit 2 pages without losing quality...');
        sendProgress(requestId, {
            stage: 'refine_start',
            percent: 65,
            message: 'Compressing content to fit 2 pages...',
            etaSeconds: estimateRemaining(['refine', 'compile']),
        });
        const refineStart = Date.now();
        try {
            latex = await refineLatexToTwoPages(latex, apiKey);
        } catch (err) {
            err.lastLatex = latex;
            throw err;
        }
        updateAverage('refine', Math.round((Date.now() - refineStart) / 1000));
        sendProgress(requestId, {
            stage: 'refine_done',
            percent: 70,
            message: 'Compression complete. Recompiling...',
            etaSeconds: estimateRemaining(['compile']),
        });
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
