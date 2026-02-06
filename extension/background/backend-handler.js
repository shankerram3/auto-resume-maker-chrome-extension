/**
 * Handle resume generation via backend API
 */
async function handleGenerateResumeViaBackend(backendUrl, jobDescription, masterResume, downloadOptions = {}) {
    try {
        const response = await fetch(`${backendUrl}/api/generate-resume`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
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

            const filenameBase = 'job-tailored-resume.pdf';
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
