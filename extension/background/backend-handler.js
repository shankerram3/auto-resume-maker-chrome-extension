/**
 * Sanitize a job title into a safe filename slug.
 */
function slugifyJobTitle(title) {
    if (!title || typeof title !== 'string') return '';
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')  // non-alphanumeric → hyphens
        .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
        .slice(0, 60);                 // cap length
}

/**
 * Handle resume generation via backend API
 */
async function handleGenerateResumeViaBackend(backendUrl, jobDescription, masterResume, downloadOptions = {}) {
    try {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (downloadOptions.requestId) {
            headers['X-Request-Id'] = downloadOptions.requestId;
        }
        const response = await fetch(`${backendUrl}/api/generate-resume`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jobDescription,
                masterResume,
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return {
                success: false,
                error: errorData.error || `Backend error: ${response.status}`,
            };
        }

        // Check if response is PDF or JSON
        const contentType = response.headers.get('Content-Type');

        if (contentType && contentType.includes('application/pdf')) {
            // Backend returned PDF directly
            const blob = await response.blob();
            const reader = new FileReader();
            const dataUrl = await new Promise((resolve, reject) => {
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Failed to read blob'));
                reader.readAsDataURL(blob);
            });

            const slug = slugifyJobTitle(downloadOptions.jobTitle);
            const filenameBase = slug ? `${slug}-resume.pdf` : 'job-tailored-resume.pdf';
            const safeSubfolder = (downloadOptions.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '');
            const filename = safeSubfolder ? `${safeSubfolder}/${filenameBase}` : filenameBase;
            const saveAs = downloadOptions.saveAs !== false;

            const downloadId = await new Promise((resolve, reject) => {
                chrome.downloads.download(
                    {
                        url: dataUrl,
                        filename,
                        saveAs,
                    },
                    (id) => (chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(id))
                );
            });

            return {
                success: true,
                downloadId,
            };
        } else if (contentType && (contentType.includes('text/plain') || contentType.includes('application/x-tex') || contentType.includes('text/x-tex'))) {
            const latexText = await response.text();
            const base64 = btoa(unescape(encodeURIComponent(latexText)));
            const url = `data:text/plain;charset=utf-8;base64,${base64}`;
            const texSlug = slugifyJobTitle(downloadOptions.jobTitle);
            const filenameBase = texSlug ? `${texSlug}-resume-error.tex` : 'resume-error.tex';
            const safeSubfolder = (downloadOptions.subfolder || '').replace(/^[\\/]+|[\\/]+$/g, '');
            const filename = safeSubfolder ? `${safeSubfolder}/${filenameBase}` : filenameBase;
            const saveAs = true;

            const downloadId = await new Promise((resolve, reject) => {
                chrome.downloads.download(
                    {
                        url,
                        filename,
                        saveAs,
                    },
                    (id) => (chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(id))
                );
            });

            return {
                success: false,
                downloadId,
                compilationFailed: true,
                error: 'LaTeX compilation failed. Downloaded .tex file for manual fixes.',
            };
        } else {
            // Backend returned JSON (likely LaTeX source due to compilation failure)
            const data = await response.json();
            return data;
        }
    } catch (error) {
        return {
            success: false,
            error: `Failed to connect to backend: ${error.message}`,
        };
    }
}
