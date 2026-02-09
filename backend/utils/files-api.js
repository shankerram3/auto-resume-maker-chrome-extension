const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');

const FILES_API_BETA = 'files-api-2025-04-14';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

// In-memory map: resumeHash → { fileId, createdAt }
const fileIdCache = new Map();

// In-memory map: promptHash → { fileId, createdAt }
const systemPromptCache = new Map();

/**
 * Get a stable hash for content to use as cache key.
 */
function getContentHash(content) {
    return crypto.createHash('sha256').update(content.trim()).digest('hex');
}

// Keep backward-compatible alias
const getResumeHash = getContentHash;

/**
 * Upload a plain-text file to Anthropic Files API.
 * Returns the file_id.
 */
async function uploadTextFile(content, filename, apiKey) {
    const form = new FormData();
    form.append('file', Buffer.from(content, 'utf-8'), {
        filename,
        contentType: 'text/plain',
    });

    const response = await fetch(`${ANTHROPIC_API_BASE}/files`, {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': FILES_API_BETA,
            ...form.getHeaders(),
        },
        body: form,
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Files API upload failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    console.log(`📁 Uploaded ${filename} to Files API: ${data.id} (${data.size_bytes} bytes)`);
    return data.id;
}

/**
 * Upload a plain-text master resume to Anthropic Files API.
 * Returns the file_id.
 */
async function uploadResumeFile(masterResume, apiKey) {
    return uploadTextFile(masterResume, 'master-resume.txt', apiKey);
}

/**
 * Get or create a file_id for a given master resume.
 * Caches file_ids in memory so the same resume is only uploaded once.
 */
async function getOrUploadResumeFile(masterResume, apiKey) {
    const hash = getContentHash(masterResume);
    const cached = fileIdCache.get(hash);

    if (cached) {
        console.log(`📁 Using cached file_id for master resume: ${cached.fileId}`);
        return cached.fileId;
    }

    const fileId = await uploadResumeFile(masterResume, apiKey);
    fileIdCache.set(hash, { fileId, createdAt: Date.now() });
    return fileId;
}

/**
 * Get or create a file_id for the system prompt.
 * Caches file_id in memory so the prompt is only uploaded once.
 */
async function getOrUploadSystemPromptFile(promptContent, apiKey) {
    const hash = getContentHash(promptContent);
    const cached = systemPromptCache.get(hash);

    if (cached) {
        console.log(`📁 Using cached file_id for system prompt: ${cached.fileId}`);
        return cached.fileId;
    }

    const fileId = await uploadTextFile(promptContent, 'system-prompt.txt', apiKey);
    systemPromptCache.set(hash, { fileId, createdAt: Date.now() });
    return fileId;
}

/**
 * Build the user message content array.
 * When Files API is enabled, uploads both system prompt and master resume as files
 * and references them as document blocks in the user content.
 * Falls back to inline text if Files API is disabled or fails.
 *
 * Returns { content, usedFilesApi, systemPromptInUserMessage }
 */
async function buildUserContent(jobDescription, masterResume, apiKey, systemPrompt) {
    const useFilesApi = (process.env.USE_FILES_API || 'true').toLowerCase() === 'true';

    if (!useFilesApi || !systemPrompt) {
        return {
            content: systemPrompt
                ? `### INSTRUCTIONS:\n${systemPrompt}\n\n### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`
                : `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`,
            usedFilesApi: false,
            systemPromptInUserMessage: !!systemPrompt,
        };
    }

    try {
        const [promptFileId, resumeFileId] = await Promise.all([
            getOrUploadSystemPromptFile(systemPrompt, apiKey),
            getOrUploadResumeFile(masterResume, apiKey),
        ]);

        return {
            content: [
                {
                    type: 'document',
                    source: {
                        type: 'file',
                        file_id: promptFileId,
                    },
                    title: 'Resume Generation Instructions',
                },
                {
                    type: 'text',
                    text: `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME (see attached document):`,
                },
                {
                    type: 'document',
                    source: {
                        type: 'file',
                        file_id: resumeFileId,
                    },
                    title: 'Master Resume',
                },
            ],
            usedFilesApi: true,
            systemPromptInUserMessage: true,
        };
    } catch (err) {
        console.warn('⚠️  Files API failed, falling back to inline text:', err.message);
        return {
            content: `### INSTRUCTIONS:\n${systemPrompt}\n\n### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`,
            usedFilesApi: false,
            systemPromptInUserMessage: true,
        };
    }
}

module.exports = {
    buildUserContent,
    getOrUploadResumeFile,
    getOrUploadSystemPromptFile,
    FILES_API_BETA,
};
