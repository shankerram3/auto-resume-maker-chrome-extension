# Auto Resume Maker - Chrome Extension

AI-powered Chrome extension that generates ATS-optimized LaTeX resumes tailored to job descriptions using Claude 4.5 Sonnet.

## Features

- 🎯 **Job-Tailored Resumes**: Automatically customizes your resume for each job posting
- 🤖 **Claude 4.5 Sonnet**: Uses Anthropic's latest AI model for intelligent content selection
- 📄 **2-Page Enforcement**: Automatically compresses content to fit exactly 2 pages
- 📝 **LaTeX Output**: Professional, ATS-optimized LaTeX resumes
- 🔄 **Multiple Formats**: Supports PDF, LaTeX, and TXT master resume uploads
- 🌐 **Backend Processing**: Secure server-side API calls and PDF compilation

## Architecture

```
Chrome Extension → Backend Server → Anthropic API → LaTeX Compiler → PDF
```

## Setup

### Backend

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Add your Anthropic API key to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-your-key-here
PORT=3000
```

5. Start the backend:
```bash
npm start
```

### Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` directory
5. Open extension options and set backend URL: `http://localhost:3000`

## Usage

1. Navigate to a LinkedIn job posting
2. Click the extension icon
3. Click "Extract from Current Tab" to get the job description
4. Click "Generate Resume"
5. Download the tailored PDF resume

## Tech Stack

- **Backend**: Node.js, Express
- **AI**: Anthropic Claude 4.5 Sonnet
- **LaTeX**: latexonline.cc (with local fallback)
- **Extension**: Chrome Extension Manifest V3

## Environment Variables

- `ANTHROPIC_API_KEY`: Your Anthropic API key (required)
- `PORT`: Backend server port (default: 3000)
- `LATEX_COMPILER`: Set to "local" to prefer local LaTeX compilation
- `LATEX_ENGINE`: LaTeX engine to use (default: pdflatex)
- `ANTHROPIC_TIMEOUT_MS`: API timeout in milliseconds (default: 120000)

## License

MIT
