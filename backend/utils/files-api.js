const crypto = require('crypto');
const fetch = require('node-fetch');
const FormData = require('form-data');

const FILES_API_BETA = 'files-api-2025-04-14';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com/v1';

// In-memory map: resumeHash → { fileId, createdAt }
const fileIdCache = new Map();

/**
 * Get a stable hash for a master resume to use as cache key.
 */
function getResumeHash(masterResume) {
    return crypto.createHash('sha256').update(masterResume.trim()).digest('hex');
}

/**
 * Upload a plain-text master resume to Anthropic Files API.
 * Returns the file_id.
 */
async function uploadResumeFile(masterResume, apiKey) {
    const form = new FormData();
    form.append('file', Buffer.from(masterResume, 'utf-8'), {
        filename: 'master-resume.txt',
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
    console.log(`📁 Uploaded master resume to Files API: ${data.id} (${data.size_bytes} bytes)`);
    return data.id;
}

/**
 * Get or create a file_id for a given master resume.
 * Caches file_ids in memory so the same resume is only uploaded once.
 */
async function getOrUploadResumeFile(masterResume, apiKey) {
    const hash = getResumeHash(masterResume);
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
 * Build the user message content array using file_id for the master resume.
 * Falls back to inline text if Files API is disabled or fails.
 */
async function buildUserContent(jobDescription, masterResume, apiKey) {
    const useFilesApi = (process.env.USE_FILES_API || 'true').toLowerCase() === 'true';

    if (!useFilesApi) {
        return {
            content: `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`,
            usedFilesApi: false,
        };
    }

    try {
        const fileId = await getOrUploadResumeFile(masterResume, apiKey);
        return {
            content: [
                {
                    type: 'text',
                    text: `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME (see attached document):`,
                },
                {
                    type: 'document',
                    source: {
                        type: 'file',
                        file_id: fileId,
                    },
                    title: 'Master Resume',
                },
            ],
            usedFilesApi: true,
        };
    } catch (err) {
        console.warn('⚠️  Files API failed, falling back to inline text:', err.message);
        return {
            content: `### JOB DESCRIPTION:\n${jobDescription}\n\n### MASTER RESUME:\n${masterResume}`,
            usedFilesApi: false,
        };
    }
}

module.exports = {
    buildUserContent,
    getOrUploadResumeFile,
    FILES_API_BETA,
};
