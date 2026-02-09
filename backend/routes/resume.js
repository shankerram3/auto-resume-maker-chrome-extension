const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { RESUME_SYSTEM_PROMPT } = require('../config/prompt');
const { compileLatexToPDF, compileLatexWithRetry, extractLatexFromResponse, sanitizeLatex, getPdfPageCount } = require('../utils/latex-compiler');
const { buildUserContent, FILES_API_BETA } = require('../utils/files-api');

const router = express.Router();
const progressClients = new Map();
const progressLast = new Map();

// ── In-memory resume cache ──────────────────────────────────────────
const resumeCache = new Map();
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '3600000', 10); // 1 hour default
const CACHE_MAX_ENTRIES = 100;

function getCacheKey(jobDescription, masterResume) {
    const hash = crypto.createHash('sha256');
    hash.update(jobDescription.trim());
    hash.update('|||');
    hash.update(masterResume.trim());
    return hash.digest('hex');
}

function getCachedResume(key) {
    const entry = resumeCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        resumeCache.delete(key);
        return null;
    }
    return entry.pdfBuffer;
}

function cacheResume(key, pdfBuffer) {
    resumeCache.set(key, { pdfBuffer, timestamp: Date.now() });
    // Evict expired entries when cache grows large
    if (resumeCache.size > CACHE_MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of resumeCache.entries()) {
            if (now - v.timestamp > CACHE_TTL_MS) resumeCache.delete(k);
        }
    }
}
// ── Cost tracking & pricing ─────────────────────────────────────────
// Pricing per million tokens (as of 2025-2026)
const MODEL_PRICING = {
    'claude-sonnet-4-5-20250929':   { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-3-5-sonnet-20241022':   { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
    'claude-3-5-haiku-20241022':    { input: 0.80, output: 4.00,  cacheWrite: 1.00, cacheRead: 0.08 },
    'claude-haiku-4-5-20250414':    { input: 1.00, output: 5.00,  cacheWrite: 1.25, cacheRead: 0.10 },
};

// Fallback pricing if model not found
const DEFAULT_PRICING = { input: 3.00, output: 15.00, cacheWrite: 3.75, cacheRead: 0.30 };

function getPricing(model) {
    return MODEL_PRICING[model] || DEFAULT_PRICING;
}

/**
 * Calculate cost from Anthropic usage object.
 * Returns { inputCost, outputCost, cacheWriteCost, cacheReadCost, totalCost, breakdown }
 */
function calculateCost(usage, model) {
    const pricing = getPricing(model);
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    const cacheWriteCost = (cacheCreationTokens / 1_000_000) * pricing.cacheWrite;
    const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheRead;
    const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

    return {
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalInputTokens: inputTokens + cacheCreationTokens + cacheReadTokens,
        inputCost,
        outputCost,
        cacheWriteCost,
        cacheReadCost,
        totalCost,
    };
}

/**
 * Format a cost breakdown into a readable log string.
 */
function formatCostLog(label, cost, model, durationMs) {
    const lines = [
        `┌─── ${label} ───`,
        `│ Model:           ${model}`,
        `│ Duration:        ${(durationMs / 1000).toFixed(1)}s`,
        `│ Input tokens:    ${cost.inputTokens.toLocaleString()}${cost.cacheReadTokens > 0 ? ` (+ ${cost.cacheReadTokens.toLocaleString()} cached)` : ''}`,
        `│ Output tokens:   ${cost.outputTokens.toLocaleString()}`,
    ];
    if (cost.cacheCreationTokens > 0) {
        lines.push(`│ Cache written:   ${cost.cacheCreationTokens.toLocaleString()} tokens`);
    }
    if (cost.cacheReadTokens > 0) {
        lines.push(`│ Cache read:      ${cost.cacheReadTokens.toLocaleString()} tokens (💰 saved!)`);
    }
    lines.push(
        `│ Cost breakdown:  input $${cost.inputCost.toFixed(5)} + output $${cost.outputCost.toFixed(5)}` +
            (cost.cacheWriteCost > 0 ? ` + cache-write $${cost.cacheWriteCost.toFixed(5)}` : '') +
            (cost.cacheReadCost > 0 ? ` + cache-read $${cost.cacheReadCost.toFixed(5)}` : ''),
        `│ 💰 Call cost:    $${cost.totalCost.toFixed(5)}`,
        `└${'─'.repeat(40)}`,
    );
    return lines.join('\n');
}

// Session-level cumulative stats
const sessionStats = {
    totalResumes: 0,
    totalCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    cacheHits: 0,
    refinements: 0,
    startedAt: Date.now(),
};

function printSessionStats() {
    const uptime = Math.round((Date.now() - sessionStats.startedAt) / 1000);
    const lines = [
        '',
        '╔══════════════════════════════════════════╗',
        '║        📊 SESSION CUMULATIVE STATS       ║',
        '╠══════════════════════════════════════════╣',
        `║ Resumes generated:  ${String(sessionStats.totalResumes).padStart(18)} ║`,
        `║ Cache hits:         ${String(sessionStats.cacheHits).padStart(18)} ║`,
        `║ Refinements needed: ${String(sessionStats.refinements).padStart(18)} ║`,
        `║ Total input tokens: ${String(sessionStats.totalInputTokens.toLocaleString()).padStart(18)} ║`,
        `║ Total output tokens:${String(sessionStats.totalOutputTokens.toLocaleString()).padStart(18)} ║`,
        `║ Cache read tokens:  ${String(sessionStats.totalCacheReadTokens.toLocaleString()).padStart(18)} ║`,
        `║ Cache write tokens: ${String(sessionStats.totalCacheWriteTokens.toLocaleString()).padStart(18)} ║`,
        `║ Total cost:        $${sessionStats.totalCost.toFixed(5).padStart(17)} ║`,
        `║ Avg cost/resume:   $${(sessionStats.totalResumes > 0 ? sessionStats.totalCost / sessionStats.totalResumes : 0).toFixed(5).padStart(17)} ║`,
        `║ Uptime:            ${String(uptime + 's').padStart(18)} ║`,
        '╚══════════════════════════════════════════╝',
        '',
    ];
    console.log(lines.join('\n'));
}
// ────────────────────────────────────────────────────────────────────

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

        // Check cache before calling API
        const cacheKey = getCacheKey(jobDescription, masterResume);
        const cachedPdf = getCachedResume(cacheKey);
        if (cachedPdf) {
            const cacheElapsed = Date.now() - startedAt;
            sessionStats.cacheHits += 1;
            sessionStats.totalResumes += 1;
            console.log(`✅ Cache HIT — returning cached resume (${cachedPdf.length} bytes, ${cacheElapsed}ms)`);
            console.log(`   💰 Cost: $0.00000 (served from cache)`);
            printSessionStats();
            sendProgress(requestId, {
                stage: 'done',
                percent: 100,
                message: 'Resume ready (from cache)',
                etaSeconds: 0,
            });
            closeProgress(requestId);
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', 'attachment; filename="resume.pdf"');
            return res.send(cachedPdf);
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

        // Build user content (uses Files API for master resume if enabled)
        const generationModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';
        console.log(`🤖 Calling Anthropic API (model: ${generationModel})...`);
        sendProgress(requestId, {
            stage: 'llm_start',
            percent: 15,
            message: 'Calling AI model...',
            etaSeconds: estimateRemaining(['llm', 'compile']),
        });

        const { content: userContent, usedFilesApi, systemPromptInUserMessage } = await buildUserContent(jobDescription, masterResume, apiKey, RESUME_SYSTEM_PROMPT);
        if (usedFilesApi) {
            console.log('📁 Using Files API for master resume and system prompt');
        }

        const requestStart = Date.now();
        const controller = new AbortController();
        const timeoutMs = parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '120000', 10);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const progressId = setInterval(() => {
            const elapsed = Math.round((Date.now() - requestStart) / 1000);
            console.log(`⏳ Waiting for Anthropic response... ${elapsed}s`);
        }, 5000);

        // Build request headers — include Files API beta header when needed
        const requestHeaders = {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        };
        if (usedFilesApi) {
            requestHeaders['anthropic-beta'] = FILES_API_BETA;
        }

        let llmResponse;
        try {
            // When Files API is used, the system prompt is included as a document
            // in the user message, so we omit the system parameter.
            // When falling back to inline, keep the system parameter with prompt caching.
            const requestBody = {
                model: generationModel,
                messages: [
                    { role: 'user', content: userContent },
                ],
                max_tokens: 4096,
                // Always include a system message. When the full prompt is in
                // the user message via Files API, use a lightweight reinforcement.
                // Otherwise use the full inline prompt with ephemeral caching.
                system: [
                    {
                        type: 'text',
                        text: systemPromptInUserMessage
                            ? 'You are a LaTeX resume generator. Follow the instructions in the attached document exactly. Output ONLY valid LaTeX code — no markdown, no commentary, no explanations, no XML tags. Start with \\documentclass and end with \\end{document}.'
                            : RESUME_SYSTEM_PROMPT,
                        cache_control: { type: 'ephemeral' },
                    },
                ],
            };

            llmResponse = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(requestBody),
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
        const llmDuration = Date.now() - requestStart;

        // ── Verbose LLM cost logging ──
        let requestCost = 0;
        const genUsage = data.usage || {};
        const genCost = calculateCost(genUsage, generationModel);
        requestCost += genCost.totalCost;
        console.log(formatCostLog('🤖 Generation LLM Call', genCost, generationModel, llmDuration));

        const content = data.content?.[0]?.text;
        console.log(`📝 Response: ${content?.length || 0} chars | stop_reason: ${data.stop_reason || 'unknown'}`);
        const latex = extractLatexFromResponse(content);
        console.log(`📄 LaTeX extracted: ${latex ? 'Yes' : 'No'}`);

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
            const { pdfBuffer, finalLatex, pageCount, refineCost } = await compileWithTwoPageGuard(latex, apiKey, requestId);
            if (refineCost) {
                requestCost += refineCost;
                sessionStats.refinements += 1;
            }
            console.log(`✅ PDF compiled successfully (${pageCount} pages), size: ${pdfBuffer.length} bytes`);

            // Save a copy to backend/output
            const outputDir = path.join(__dirname, '..', 'output');
            await fs.mkdir(outputDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outputPath = path.join(outputDir, `resume-${timestamp}.pdf`);
            await fs.writeFile(outputPath, pdfBuffer);
            console.log('💾 Saved PDF to:', outputPath);

            // Cache the result for future identical requests
            cacheResume(cacheKey, pdfBuffer);

            const totalElapsed = Math.round((Date.now() - startedAt) / 1000);

            // ── Final per-request cost summary ──
            sessionStats.totalResumes += 1;
            sessionStats.totalCost += requestCost;
            sessionStats.totalInputTokens += genCost.totalInputTokens;
            sessionStats.totalOutputTokens += genCost.outputTokens;
            sessionStats.totalCacheReadTokens += genCost.cacheReadTokens;
            sessionStats.totalCacheWriteTokens += genCost.cacheCreationTokens;

            const summaryLines = [
                '',
                '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
                '┃     📋 RESUME GENERATION COMPLETE           ┃',
                '┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫',
                `┃ Total time:        ${String(totalElapsed + 's').padStart(21)} ┃`,
                `┃ Pages:             ${String(pageCount).padStart(21)} ┃`,
                `┃ PDF size:          ${String((pdfBuffer.length / 1024).toFixed(1) + ' KB').padStart(21)} ┃`,
                `┃ Model:             ${String(generationModel.replace('claude-', '')).padStart(21)} ┃`,
                `┃ Files API:         ${String(usedFilesApi ? 'Yes' : 'No').padStart(21)} ┃`,
                `┃ Prompt via file:   ${String(systemPromptInUserMessage && usedFilesApi ? 'Yes' : 'No (inline)').padStart(21)} ┃`,
                `┃ Prompt cached:     ${String(genCost.cacheReadTokens > 0 ? 'Yes ✓' : 'No (cold)').padStart(21)} ┃`,
                `┃ Refinement needed: ${String(refineCost ? 'Yes' : 'No').padStart(21)} ┃`,
                `┃ Gen input tokens:  ${String(genCost.totalInputTokens.toLocaleString()).padStart(21)} ┃`,
                `┃ Gen output tokens: ${String(genCost.outputTokens.toLocaleString()).padStart(21)} ┃`,
                `┃ Generation cost:   ${String('$' + genCost.totalCost.toFixed(5)).padStart(21)} ┃`,
                refineCost ? `┃ Refinement cost:   ${String('$' + refineCost.toFixed(5)).padStart(21)} ┃` : null,
                `┃─────────────────────────────────────────────┃`,
                `┃ 💰 TOTAL COST:     ${String('$' + requestCost.toFixed(5)).padStart(21)} ┃`,
                '┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛',
            ].filter(Boolean);
            console.log(summaryLines.join('\n'));
            printSessionStats();

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
            // If compilation fails, return LaTeX source
            console.warn('⚠️  LaTeX compilation failed:', compilationError.message);
            sendProgress(requestId, {
                stage: 'error',
                percent: 100,
                message: 'LaTeX compilation failed. Returning source code.',
            });
            closeProgress(requestId);
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
    let refineCost = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        sendProgress(requestId, {
            stage: 'compile_pass',
            percent: 75,
            message: `Compiling PDF (pass ${attempt}/${maxAttempts})...`,
            etaSeconds: estimateRemaining(['compile']),
        });
        const compileStart = Date.now();
        const compileResult = await compileLatexWithRetry(latex);
        const pdfBuffer = compileResult.pdfBuffer;
        latex = compileResult.latex; // may have been sanitized/fixed
        if (compileResult.fixesApplied.length > 0) {
            console.log(`  🔧 Fixes applied during compilation: ${compileResult.fixesApplied.join(', ')}`);
        }
        const compileDuration = Date.now() - compileStart;
        updateAverage('compile', Math.round(compileDuration / 1000));
        const pageCount = await getPdfPageCount(pdfBuffer);
        console.log(`📄 Compile pass ${attempt}: ${pageCount} pages (${(compileDuration / 1000).toFixed(1)}s)`);

        if (pageCount <= 2) {
            return { pdfBuffer, finalLatex: latex, pageCount, refineCost };
        }

        if (attempt === maxAttempts) {
            throw new Error(`PDF still exceeds 2 pages after ${maxAttempts} attempts.`);
        }

        console.log(`✂️  Page count ${pageCount} > 2 — triggering refinement...`);
        sendProgress(requestId, {
            stage: 'refine_start',
            percent: 65,
            message: 'Compressing content to fit 2 pages...',
            etaSeconds: estimateRemaining(['refine', 'compile']),
        });
        const refineStart = Date.now();
        const refineResult = await refineLatexToTwoPages(latex, apiKey);
        latex = refineResult.latex;
        refineCost = refineResult.cost;

        // Track refinement tokens in session
        if (refineResult.costDetails) {
            sessionStats.totalInputTokens += refineResult.costDetails.totalInputTokens;
            sessionStats.totalOutputTokens += refineResult.costDetails.outputTokens;
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

    const refinementModel = process.env.ANTHROPIC_REFINEMENT_MODEL || 'claude-3-5-haiku-20241022';
    const refineStart = Date.now();
    const llmResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: refinementModel,
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
    const refineDuration = Date.now() - refineStart;

    // ── Verbose refinement cost logging ──
    const refUsage = data.usage || {};
    const refCost = calculateCost(refUsage, refinementModel);
    console.log(formatCostLog('✂️  Refinement LLM Call', refCost, refinementModel, refineDuration));

    const content = data.content?.[0]?.text;
    const refined = extractLatexFromResponse(content) || content?.trim();
    if (!refined || !refined.includes('\\begin{document}')) {
        throw new Error('Refinement did not return valid LaTeX.');
    }
    return { latex: refined, cost: refCost.totalCost, costDetails: refCost };
}
