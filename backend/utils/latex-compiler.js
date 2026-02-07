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
        // Save a debug copy of the LaTeX source for inspection on failure
        const debugDir = path.join(__dirname, '..', 'output');
        try {
            await fs.mkdir(debugDir, { recursive: true });
            await fs.writeFile(path.join(debugDir, 'last-latex-attempt.tex'), latexSource, 'utf8');
        } catch (_) { }
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

// ── LaTeX sanitizer: fix common LLM-generated errors ──────────────────

/**
 * Sanitize LaTeX source to fix common issues produced by LLMs.
 * Runs a series of safe, idempotent fixes before compilation.
 * @param {string} latex - Raw LaTeX source
 * @returns {string} - Sanitized LaTeX source
 */
function sanitizeLatex(latex) {
    if (!latex) return latex;
    let out = latex;

    // 1. Fix unescaped special chars in text (not inside commands/math)
    //    Common culprits: #, &, % in plain text that the LLM forgot to escape
    //    We only fix inside text regions (after \begin{document} and outside known commands)
    out = fixUnescapedSpecialChars(out);

    // 2. Fix unbalanced braces — count { vs } and append missing ones before \end{document}
    out = fixUnbalancedBraces(out);

    // 3. Fix common command typos from LLMs
    out = fixCommonCommandErrors(out);

    // 4. Remove any stray markdown artifacts the LLM might have left
    out = removeMarkdownArtifacts(out);

    return out;
}

/**
 * Escape unescaped #, &, % in text content (outside of commands and math mode).
 * Very conservative: only fixes obvious cases.
 */
function fixUnescapedSpecialChars(latex) {
    // Split into lines and process each
    const lines = latex.split('\n');
    const processed = lines.map(line => {
        // Skip comment lines, command definitions, math lines
        const trimmed = line.trim();
        if (trimmed.startsWith('%') || trimmed.startsWith('\\def') ||
            trimmed.startsWith('\\newcommand') || trimmed.startsWith('\\renewcommand') ||
            trimmed.startsWith('\\usepackage') || trimmed.startsWith('\\documentclass') ||
            trimmed.startsWith('\\input') || trimmed.startsWith('\\include')) {
            return line;
        }

        // Fix unescaped & in text (not in tabular/align environments)
        // Only fix & that aren't already escaped (\&) and aren't in tabular-like contexts
        // We leave & alone since it's used as column separator in tabular

        // Fix unescaped # in text (not in command definitions)
        line = line.replace(/(?<!\\)#(?!\d)/g, '\\#');

        // Fix unescaped % that aren't comments (mid-line unescaped %)
        // If % appears after actual text content and there's more content after it,
        // it's likely meant to be a literal percent sign
        // Actually, % as comment is valid LaTeX — skip this to avoid breaking intentional comments

        return line;
    });
    return processed.join('\n');
}

/**
 * Count braces and fix imbalances.
 * If there are more { than }, add missing } before \end{document}.
 * If there are more } than {, remove trailing excess }.
 */
function fixUnbalancedBraces(latex) {
    let depth = 0;
    let inVerbatim = false;

    for (let i = 0; i < latex.length; i++) {
        const ch = latex[i];
        // Skip escaped braces
        if (ch === '\\' && i + 1 < latex.length) {
            i++; // skip next char
            continue;
        }
        // Track verbatim environments (don't count braces inside them)
        if (latex.substring(i, i + 16) === '\\begin{verbatim}') {
            inVerbatim = true;
            continue;
        }
        if (latex.substring(i, i + 14) === '\\end{verbatim}') {
            inVerbatim = false;
            continue;
        }
        if (inVerbatim) continue;

        if (ch === '{') depth++;
        else if (ch === '}') depth--;
    }

    if (depth > 0) {
        // More { than } — add missing closing braces before \end{document}
        const closingBraces = '}'.repeat(depth);
        console.log(`  🔧 LaTeX fix: adding ${depth} missing closing brace(s)`);
        const endDocIdx = latex.lastIndexOf('\\end{document}');
        if (endDocIdx !== -1) {
            return latex.substring(0, endDocIdx) + closingBraces + '\n' + latex.substring(endDocIdx);
        }
        return latex + closingBraces;
    }

    if (depth < 0) {
        // More } than { — remove excess closing braces (from the end, before \end{document})
        console.log(`  🔧 LaTeX fix: removing ${-depth} excess closing brace(s)`);
        let result = latex;
        let toRemove = -depth;
        const endDocIdx = result.lastIndexOf('\\end{document}');
        const beforeEnd = endDocIdx !== -1 ? result.substring(0, endDocIdx) : result;
        const afterEnd = endDocIdx !== -1 ? result.substring(endDocIdx) : '';

        // Remove excess } from end of content (before \end{document})
        let cleaned = beforeEnd;
        while (toRemove > 0) {
            const lastBrace = cleaned.lastIndexOf('}');
            if (lastBrace === -1) break;
            // Make sure this } isn't part of an \end{...} command
            const before = cleaned.substring(Math.max(0, lastBrace - 20), lastBrace);
            if (/\\end\{[^}]*$/.test(before)) break;
            cleaned = cleaned.substring(0, lastBrace) + cleaned.substring(lastBrace + 1);
            toRemove--;
        }
        return cleaned + afterEnd;
    }

    return latex; // balanced
}

/**
 * Fix common LLM command errors.
 */
function fixCommonCommandErrors(latex) {
    let out = latex;

    // Fix doubled backslashes in commands: \\section -> \section (outside of line breaks)
    // Only fix when \\command appears at start of line or after whitespace (not after \\)
    out = out.replace(/^([ \t]*)\\\\(section|subsection|textbf|textit|href|item|begin|end|vspace|hspace|newpage|noindent)(\{)/gm,
        '$1\\$2$3');

    // Fix \\ before \begin or \section that creates unwanted line breaks
    // e.g., "\\\n\section{Summary}" — the \\ creates a "Missing { inserted" error
    //        because LaTeX tries to parse \\ as a line break in text mode
    out = out.replace(/\\\\\s*\n([ \t]*\\(?:section|subsection|begin))/g, '\n$1');

    // Fix empty \textbf{} or \textit{} — remove them to avoid weird spacing
    out = out.replace(/\\textbf\{\s*\}/g, '');
    out = out.replace(/\\textit\{\s*\}/g, '');

    // Fix blank lines within \titlespacing and \titleformat commands
    // LaTeX treats blank lines as \par, which breaks these commands
    out = fixTitlesecCommands(out);

    return out;
}

/**
 * Fix titlesec commands (\titleformat, \titlespacing) that LLMs often break.
 * Common issues:
 * - Blank lines in the middle of the command (causes "Runaway argument" / \par error)
 * - Missing braces around arguments
 * - Missing closing braces from \titleformat causing \titlespacing to be consumed
 * - \titleformat with too few brace groups (eats \titlespacing as its arguments)
 */
function fixTitlesecCommands(latex) {
    let out = latex;

    // Strategy 1: Collapse blank lines within titlesec commands
    out = collapseTitlesecCommand(out, 'titleformat');
    out = collapseTitlesecCommand(out, 'titlespacing');
    out = collapseTitlesecCommand(out, 'titlespacing\\*');

    // Strategy 2: Fix \uppercase / \MakeUppercase inside \titleformat
    // These commands consume the next token as an argument, breaking brace parsing
    out = fixUppercaseInTitleformat(out);

    // Strategy 3: Validate \titleformat has correct number of brace groups
    // If \titleformat has fewer than 5 groups, it will eat the next command
    out = validateTitleformatArgs(out);

    return out;
}

/**
 * Fix \uppercase and \MakeUppercase used inside \titleformat format argument.
 * These primitives require {text} as argument, but LLMs put them bare inside the
 * format arg, e.g.: \titleformat{\section}{\large\bfseries\MakeUppercase}{...
 * This causes \MakeUppercase to consume the next brace group as its argument,
 * throwing off the entire \titleformat parsing.
 *
 * Fix: Remove \uppercase/\MakeUppercase from the format argument and instead
 * wrap the before-code (5th arg) appropriately.
 */
function fixUppercaseInTitleformat(latex) {
    // Find all lines containing \titleformat and fix \MakeUppercase/\uppercase inside any brace group.
    // These primitives consume the next token as an argument, which breaks titlesec's brace parsing.
    // We simply remove them — the section headings will render in normal case.
    const lines = latex.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('\\titleformat')) {
            const before = lines[i];
            lines[i] = lines[i]
                .replace(/\\MakeUppercase\s*/g, '')
                .replace(/\\MakeLowercase\s*/g, '')
                .replace(/\\uppercase\s*/g, '')
                .replace(/\\lowercase\s*/g, '');
            if (lines[i] !== before) {
                console.log(`  🔧 LaTeX fix: removed \\MakeUppercase/\\uppercase from \\titleformat (line ${i + 1})`);
            }
        }
    }
    return lines.join('\n');
}

/**
 * Validate that \titleformat commands have the correct number of brace groups.
 * \titleformat requires: {command}[shape]{format}{label}{sep}{before-code}[after-code]
 * That's 5 required {} groups (command, format, label, sep, before-code) + optional [shape] and [after-code]
 * If there are too few, add empty {} groups.
 * If the command eats into the next line, truncate it.
 */
function validateTitleformatArgs(latex) {
    const lines = latex.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const tfMatch = line.match(/^(\s*\\titleformat\s*)/);

        if (!tfMatch) {
            result.push(line);
            i++;
            continue;
        }

        // Found \titleformat — collect all content until we have 5 balanced {} groups
        // or hit another command (\titlespacing, \section, \begin, etc.)
        let fullCmd = line;
        let j = i + 1;

        // First, collect continuation lines (lines that are part of this command)
        while (j < lines.length) {
            const nextLine = lines[j].trim();
            // Stop if we hit another top-level command or blank line followed by a command
            if (nextLine.startsWith('\\titlespacing') ||
                nextLine.startsWith('\\titleformat') ||
                nextLine.startsWith('\\begin{') ||
                nextLine.startsWith('\\section') ||
                nextLine.startsWith('\\subsection') ||
                nextLine.startsWith('\\renewcommand') ||
                nextLine.startsWith('\\newcommand') ||
                nextLine.startsWith('\\setlength') ||
                nextLine.startsWith('\\pagestyle')) {
                break;
            }
            // Stop if the current accumulated command is already balanced
            const braceCount = countBraceGroups(fullCmd);
            if (braceCount.groups >= 5 && braceCount.depth === 0) {
                break;
            }
            if (nextLine === '') {
                // Blank line — include only if we're in the middle of braces
                const bc = countBraceGroups(fullCmd);
                if (bc.depth > 0) {
                    fullCmd += ' '; // collapse blank line
                    j++;
                    continue;
                }
                break; // balanced, stop here
            }
            fullCmd += ' ' + nextLine;
            j++;
        }

        // Now count how many brace groups we actually have
        const braceInfo = countBraceGroups(fullCmd);

        if (braceInfo.groups < 5 && braceInfo.depth === 0) {
            // Not enough groups — add empty ones
            const missing = 5 - braceInfo.groups;
            fullCmd = fullCmd.trimEnd() + '{}' .repeat(missing);
            console.log(`  🔧 LaTeX fix: \\titleformat had ${braceInfo.groups}/5 required groups, added ${missing} empty {}`);
        } else if (braceInfo.depth > 0) {
            // Unclosed braces — close them
            fullCmd = fullCmd.trimEnd() + '}'.repeat(braceInfo.depth);
            console.log(`  🔧 LaTeX fix: \\titleformat had ${braceInfo.depth} unclosed brace(s), added closing }`);
        }

        result.push(fullCmd);
        i = j;
    }

    return result.join('\n');
}

/**
 * Count the number of top-level brace groups {} and current brace depth in a string.
 * Skips escaped braces and optional [] arguments.
 */
function countBraceGroups(text) {
    let groups = 0;
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
            i++; // skip escaped char
            continue;
        }
        if (ch === '{') {
            if (depth === 0) groups++;
            depth++;
        } else if (ch === '}') {
            depth--;
        }
        // Skip [] optional args (don't count as brace groups)
    }

    return { groups, depth };
}

/**
 * Find a titlesec command and collapse it into a single line,
 * removing blank lines that would cause \par errors.
 */
function collapseTitlesecCommand(latex, cmdName) {
    // Regex to find the start of the command
    const cmdRegex = new RegExp(`(\\\\${cmdName})\\s*\\{`, 'g');
    let result = latex;
    let match;
    let offset = 0;

    // Process each occurrence
    while ((match = cmdRegex.exec(latex)) !== null) {
        const startIdx = match.index + offset;
        const cmdText = match[1];
        const afterCmd = startIdx + cmdText.length;

        // Find the extent of the command by counting brace groups
        // \titleformat has 6 required {} groups (+ 1 optional [])
        // \titlespacing has 4 required {} groups
        const expectedGroups = cmdName.startsWith('titleformat') ? 6 : 4;
        let pos = afterCmd;
        let groupCount = 0;
        let depth = 0;
        let foundEnd = false;

        // Scan forward to find the end of all brace groups
        while (pos < result.length && groupCount < expectedGroups) {
            const ch = result[pos];
            if (ch === '\\' && pos + 1 < result.length) {
                pos += 2; // skip escaped char
                continue;
            }
            if (ch === '[' && depth === 0) {
                // Optional argument — skip it
                let bracketDepth = 1;
                pos++;
                while (pos < result.length && bracketDepth > 0) {
                    if (result[pos] === '[') bracketDepth++;
                    else if (result[pos] === ']') bracketDepth--;
                    pos++;
                }
                continue;
            }
            if (ch === '{') {
                if (depth === 0) groupCount++;
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0 && groupCount >= expectedGroups) {
                    foundEnd = true;
                    pos++;
                    break;
                }
            }
            pos++;
        }

        if (foundEnd || groupCount >= expectedGroups) {
            // Extract the full command span
            const fullCmd = result.substring(startIdx, pos);

            // Check if it contains blank lines (the problem)
            if (/\n\s*\n/.test(fullCmd)) {
                // Collapse: remove blank lines, normalize whitespace between arguments
                const collapsed = fullCmd
                    .replace(/\n\s*\n/g, '\n')  // remove blank lines
                    .replace(/\}\s*\n\s*\{/g, '}{')  // collapse }  \n  { into }{
                    .replace(/\}\s*\n\s*\[/g, '}[')  // collapse }  \n  [ into }[
                    .replace(/\]\s*\n\s*\{/g, ']{'); // collapse ]  \n  { into ]{

                result = result.substring(0, startIdx) + collapsed + result.substring(pos);
                offset += collapsed.length - fullCmd.length;
                console.log(`  🔧 LaTeX fix: collapsed blank lines in \\${cmdName} command`);
            }
        }
    }

    return result;
}


/**
 * Remove markdown artifacts that LLMs sometimes leave in LaTeX output.
 */
function removeMarkdownArtifacts(latex) {
    let out = latex;
    // Remove stray **bold** markdown
    out = out.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
    // Remove stray *italic* markdown
    out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '\\textit{$1}');
    // Remove stray `code` markdown
    out = out.replace(/`([^`]+)`/g, '\\texttt{$1}');
    return out;
}

/**
 * Parse LaTeX error log and attempt targeted fixes.
 * @param {string} latex - The LaTeX source that failed
 * @param {string} errorLog - The pdflatex error log
 * @returns {{ fixed: boolean, latex: string, description: string }}
 */
function attemptLatexFix(latex, errorLog) {
    if (!errorLog) return { fixed: false, latex, description: 'No error log available' };

    const fixes = [];

    // Pattern: "Missing { inserted" — often caused by \\ before \section
    if (errorLog.includes('Missing { inserted')) {
        // Extract the line number from the error
        const lineMatch = errorLog.match(/main\.tex:(\d+):\s*Missing \{ inserted/);
        if (lineMatch) {
            const errorLine = parseInt(lineMatch[1], 10);
            const lines = latex.split('\n');
            if (errorLine > 0 && errorLine <= lines.length) {
                // Check if previous line ends with \\ (common cause)
                for (let i = Math.max(0, errorLine - 3); i < errorLine; i++) {
                    if (lines[i] && lines[i].trimEnd().endsWith('\\\\')) {
                        const original = lines[i];
                        lines[i] = lines[i].trimEnd().replace(/\\\\$/, '');
                        fixes.push(`Removed trailing \\\\ from line ${i + 1}: "${original.trim()}" → "${lines[i].trim()}"`);
                    }
                }
                latex = lines.join('\n');
            }
        }

        // Also do a global cleanup: remove \\ right before \section, \subsection, \begin
        const before = latex;
        latex = latex.replace(/\\\\\s*\n([ \t]*\\(?:section|subsection|begin))/g, '\n$1');
        if (latex !== before) {
            fixes.push('Removed \\\\ before \\section/\\subsection/\\begin commands');
        }
    }

    // Pattern: "Runaway argument" with titlesec — various titlesec command issues
    if (errorLog.includes('Runaway argument') || errorLog.includes('ttl@spacing') || errorLog.includes('ttl@format') || errorLog.includes('ttl@row')) {
        const before = latex;
        // Apply all titlesec fixes (blank lines, uppercase, missing args)
        latex = fixTitlesecCommands(latex);

        // Also try: if the error is near a specific line, look for incomplete titlesec commands
        const lineMatch = errorLog.match(/main\.tex:(\d+):/);
        if (lineMatch) {
            const errorLine = parseInt(lineMatch[1], 10);
            const lines = latex.split('\n');

            // Scan backwards from error line to find the start of a titlesec command
            for (let i = Math.max(0, errorLine - 10); i < Math.min(lines.length, errorLine + 2); i++) {
                const line = lines[i];
                // Check if a \titleformat or \titlespacing is missing its closing arguments
                if (line && /\\title(format|spacing)\*?\s*\{/.test(line)) {
                    // Count braces on this line — if unbalanced, the command spans multiple lines
                    let depth = 0;
                    for (const ch of line) {
                        if (ch === '{') depth++;
                        else if (ch === '}') depth--;
                    }
                    if (depth > 0) {
                        // Unbalanced — collapse following lines into this one until balanced
                        let j = i + 1;
                        let combined = line;
                        while (j < lines.length && depth > 0) {
                            const nextLine = lines[j].trim();
                            if (nextLine === '') {
                                // Skip blank line (this is the problem)
                                lines.splice(j, 1);
                                continue;
                            }
                            combined += ' ' + nextLine;
                            for (const ch of nextLine) {
                                if (ch === '{') depth++;
                                else if (ch === '}') depth--;
                            }
                            lines.splice(j, 1); // remove line, we merged it
                        }
                        lines[i] = combined;
                        fixes.push(`Collapsed multi-line titlesec command at line ${i + 1}`);
                    }
                }
            }
            latex = lines.join('\n');
        }

        if (latex !== before) {
            fixes.push('Fixed titlesec command formatting');
        }
    }

    // Pattern: "Paragraph ended before" — often caused by blank lines in command arguments
    if (errorLog.includes('Paragraph ended before') && !errorLog.includes('ttl@')) {
        // Generic fix: find the error line and remove blank lines near it
        const lineMatch = errorLog.match(/main\.tex:(\d+):/);
        if (lineMatch) {
            const errorLine = parseInt(lineMatch[1], 10);
            const lines = latex.split('\n');
            const before = latex;
            // Remove blank lines within 3 lines of the error
            for (let i = Math.max(0, errorLine - 5); i < Math.min(lines.length, errorLine + 2); i++) {
                if (lines[i] && lines[i].trim() === '' && i > 0 && i < lines.length - 1) {
                    // Check if surrounding lines look like they're in a command
                    const prevLine = lines[i - 1] || '';
                    const nextLine = lines[i + 1] || '';
                    if (prevLine.includes('{') || nextLine.includes('}') || nextLine.includes('{')) {
                        lines.splice(i, 1);
                        i--; // re-check this position
                        fixes.push(`Removed blank line near error at line ${errorLine}`);
                    }
                }
            }
            latex = lines.join('\n');
        }
    }

    // Pattern: "Undefined control sequence" — often LLM uses non-standard commands
    if (errorLog.includes('Undefined control sequence')) {
        // Common: \textsc without the right package, or typos
        // We can't do much here, but we can try removing the offending command
        const ucsMatch = errorLog.match(/main\.tex:(\d+):.*Undefined control sequence.*?\\(\w+)/);
        if (ucsMatch) {
            const badCmd = ucsMatch[2];
            // Replace unknown formatting commands with their content
            if (['textsc', 'MakeUppercase', 'MakeLowercase'].includes(badCmd)) {
                const re = new RegExp(`\\\\${badCmd}\\{([^}]*)\\}`, 'g');
                latex = latex.replace(re, '$1');
                fixes.push(`Replaced undefined \\${badCmd} with plain text`);
            }
        }
    }

    // Pattern: "Extra }, or forgotten $" — unmatched braces
    if (errorLog.includes('Extra }') || errorLog.includes('forgotten $')) {
        const fixedLatex = fixUnbalancedBraces(latex);
        if (fixedLatex !== latex) {
            latex = fixedLatex;
            fixes.push('Rebalanced braces');
        }
    }

    // Pattern: "Missing $ inserted" — math mode issue, often & or _ in text
    if (errorLog.includes('Missing $ inserted')) {
        // Fix unescaped _ in text (common LLM mistake)
        // Only fix _ that isn't in math mode and isn't already escaped
        const before = latex;
        latex = latex.replace(/(?<!\\)_(?![{])/g, '\\_');
        if (latex !== before) {
            fixes.push('Escaped unescaped underscores in text');
        }
    }

    if (fixes.length > 0) {
        const desc = fixes.join('; ');
        console.log(`  🔧 Auto-fix applied: ${desc}`);
        return { fixed: true, latex, description: desc };
    }

    return { fixed: false, latex, description: 'No auto-fix available for this error' };
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
    compileLatexWithRetry,
    extractLatexFromResponse,
    sanitizeLatex,
    attemptLatexFix,
    getPdfPageCount,
};

/**
 * Compile LaTeX with auto-sanitization and retry on failure.
 * 1. Sanitize the LaTeX first
 * 2. Try compiling
 * 3. If compilation fails, parse error log and attempt targeted fixes
 * 4. Retry compilation with fixed LaTeX
 * @param {string} latexSource - Raw LaTeX source
 * @param {number} [maxRetries=2] - Max fix-and-retry attempts
 * @returns {Promise<{ pdfBuffer: Buffer, latex: string, fixesApplied: string[] }>}
 */
async function compileLatexWithRetry(latexSource, maxRetries = 2) {
    // Step 1: Always sanitize first
    let latex = sanitizeLatex(latexSource);
    const fixesApplied = [];

    if (latex !== latexSource) {
        fixesApplied.push('Pre-compilation sanitization');
        console.log('  🔧 LaTeX sanitized before compilation');
    }

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const pdfBuffer = await compileLatexToPDF(latex);
            if (fixesApplied.length > 0) {
                console.log(`  ✅ Compilation succeeded after fixes: ${fixesApplied.join(', ')}`);
            }
            return { pdfBuffer, latex, fixesApplied };
        } catch (err) {
            const errMsg = err?.message || String(err);

            if (attempt > maxRetries) {
                // Exhausted retries — throw the final error
                throw err;
            }

            console.log(`  ⚠️ Compilation attempt ${attempt} failed, trying auto-fix...`);

            // Extract error log from the error message
            const logMatch = errMsg.match(/LaTeX log tail:\n([\s\S]+)/);
            const errorLog = logMatch ? logMatch[1] : errMsg;

            const fix = attemptLatexFix(latex, errorLog);
            if (!fix.fixed) {
                console.log(`  ❌ No auto-fix available: ${fix.description}`);
                throw err; // Can't fix, throw original error
            }

            latex = fix.latex;
            fixesApplied.push(fix.description);
            console.log(`  🔄 Retrying compilation (attempt ${attempt + 1})...`);
        }
    }

    // Should not reach here
    throw new Error('Unexpected error in compileLatexWithRetry');
}

async function getPdfPageCount(pdfBuffer) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    return pdfDoc.getPageCount();
}
