const fs = require('fs');
const path = require('path');

// Load system prompt from text file (single source of truth)
const RESUME_SYSTEM_PROMPT = fs.readFileSync(
    path.join(__dirname, 'resume-system-prompt.txt'),
    'utf-8'
);

module.exports = { RESUME_SYSTEM_PROMPT };
