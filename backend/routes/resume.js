const express = require('express');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch');
const { RESUME_SYSTEM_PROMPT } = require('../config/prompt');
const { generateResume } = require('../utils/docx-generator');

const router = express.Router();
const progressClients = new Map();
const progressLast = new Map();

// ── In-memory resume cache ──────────────────────────────────────────
const resumeCache = new Map();
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '3600000', 10);
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
    return entry.buffer;
}

function cacheResume(key, buffer) {
    resumeCache.set(key, { buffer, timestamp: Date.now() });
    if (resumeCache.size > CACHE_MAX_ENTRIES) {
        const now = Date.now();
        for (const [k, v] of resumeCache.entries()) {
            if (now - v.timestamp > CACHE_TTL_MS) resumeCache.delete(k);
        }
    }
}

// ── Progress SSE ────────────────────────────────────────────────────
function sendProgress(requestId, payload) {
    if (!requestId) return;
    const data = { timestamp: new Date().toISOString(), ...payload };
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

// ── Extract JSON from LLM response ─────────────────────────────────
function extractJson(text) {
    // Try direct parse
    try { return JSON.parse(text); } catch (_) {}

    // Try extracting from code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
    }

    // Try finding a JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    }

    throw new Error('Could not extract JSON from LLM response');
}

// ── POST /api/generate-resume ───────────────────────────────────────
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
        });

        // Validation
        if (!jobDescription || jobDescription.trim().length < 50) {
            sendProgress(requestId, { stage: 'error', percent: 100, message: 'Job description is too short or missing.' });
            return res.status(400).json({ success: false, error: 'Job description is too short or missing.' });
        }
        if (!masterResume || masterResume.trim().length < 100) {
            sendProgress(requestId, { stage: 'error', percent: 100, message: 'Master resume is missing or too short.' });
            return res.status(400).json({ success: false, error: 'Master resume is missing or too short.' });
        }

        // Check cache
        const cacheKey = getCacheKey(jobDescription, masterResume);
        const cached = getCachedResume(cacheKey);
        if (cached) {
            console.log(`✅ Cache HIT — returning cached resume (${cached.length} bytes)`);
            sendProgress(requestId, { stage: 'done', percent: 100, message: 'Resume ready (from cache)' });
            closeProgress(requestId);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', 'attachment; filename="resume.docx"');
            return res.send(cached);
        }

        // API config
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            console.error('❌ API key not configured');
            sendProgress(requestId, { stage: 'error', percent: 100, message: 'API key not configured.' });
            return res.status(500).json({ success: false, error: 'API key not configured on server.' });
        }
        console.log('✅ API key found');

        const apiUrl = process.env.LLM_API_URL || 'https://api.cerebras.ai/v1/chat/completions';
        const model = process.env.LLM_MODEL || 'qwen-3-235b-a22b-instruct-2507';

        console.log(`🤖 Calling LLM (model: ${model})...`);
        sendProgress(requestId, {
            stage: 'llm_start',
            percent: 15,
            message: 'Calling AI model...',
        });

        const requestStart = Date.now();
        const controller = new AbortController();
        const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const progressId = setInterval(() => {
            const elapsed = Math.round((Date.now() - requestStart) / 1000);
            console.log(`⏳ Waiting for LLM response... ${elapsed}s`);
        }, 5000);

        let llmResponse;
        try {
            llmResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: RESUME_SYSTEM_PROMPT },
                        {
                            role: 'user',
                            content: `JOB DESCRIPTION:\n${jobDescription}\n\nMASTER RESUME:\n${masterResume}`,
                        },
                    ],
                    max_tokens: 4096,
                    temperature: 0.7,
                }),
                signal: controller.signal,
            });
            const elapsed = Math.round((Date.now() - requestStart) / 1000);
            console.log(`✅ LLM responded in ${elapsed}s (status ${llmResponse.status})`);
            sendProgress(requestId, {
                stage: 'llm_done',
                percent: 60,
                message: 'AI response received',
            });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                sendProgress(requestId, { stage: 'error', percent: 100, message: `LLM timed out after ${Math.round(timeoutMs / 1000)}s.` });
                return res.status(504).json({ success: false, error: `LLM timed out after ${Math.round(timeoutMs / 1000)}s.` });
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            clearInterval(progressId);
        }

        if (!llmResponse.ok) {
            const errBody = await llmResponse.text();
            console.error('❌ LLM API error:', llmResponse.status, errBody);
            return res.status(500).json({ success: false, error: `LLM API error: ${llmResponse.status}` });
        }

        const data = await llmResponse.json();
        const content = data.choices?.[0]?.message?.content;
        const usage = data.usage || {};
        console.log(`📝 Response: ${content?.length || 0} chars`);
        console.log(`📊 Tokens — prompt: ${usage.prompt_tokens || '?'}, completion: ${usage.completion_tokens || '?'}, total: ${usage.total_tokens || '?'}`);

        if (!content) {
            sendProgress(requestId, { stage: 'error', percent: 100, message: 'LLM returned empty response.' });
            return res.status(500).json({ success: false, error: 'LLM returned empty response.' });
        }

        // Parse JSON from LLM response
        let resumeData;
        try {
            resumeData = extractJson(content);
            console.log('✅ JSON parsed successfully');
        } catch (parseErr) {
            console.error('❌ Failed to parse JSON from LLM response:', parseErr.message);
            console.error('Raw content (first 500 chars):', content.substring(0, 500));
            sendProgress(requestId, { stage: 'error', percent: 100, message: 'LLM did not return valid JSON.' });
            return res.status(500).json({
                success: false,
                error: 'LLM did not return valid JSON.',
                rawContent: content.substring(0, 500),
            });
        }

        // Generate .docx
        console.log('🔨 Generating .docx...');
        sendProgress(requestId, {
            stage: 'docx_generate',
            percent: 80,
            message: 'Building resume document...',
        });

        const docxBuffer = await generateResume(resumeData);
        console.log(`✅ .docx generated (${docxBuffer.length} bytes)`);

        // Save a copy
        const outputDir = path.join(__dirname, '..', 'output');
        await fs.mkdir(outputDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputPath = path.join(outputDir, `resume-${timestamp}.docx`);
        await fs.writeFile(outputPath, docxBuffer);
        console.log('💾 Saved to:', outputPath);

        // Cache
        cacheResume(cacheKey, docxBuffer);

        const totalElapsed = Math.round((Date.now() - startedAt) / 1000);
        console.log(`✅ Resume generated in ${totalElapsed}s`);

        sendProgress(requestId, {
            stage: 'done',
            percent: 100,
            message: `Resume ready (took ${totalElapsed}s)`,
        });
        closeProgress(requestId);

        // Send .docx response
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', 'attachment; filename="resume.docx"');
        res.send(docxBuffer);
    } catch (error) {
        console.error('❌ Error in /generate-resume:', error);
        const requestId = req.get('x-request-id') || req.body?.requestId || null;
        sendProgress(requestId, { stage: 'error', percent: 100, message: error.message || 'Internal server error' });
        closeProgress(requestId);
        res.status(500).json({ success: false, error: error.message || 'Internal server error' });
    }
});

module.exports = router;
