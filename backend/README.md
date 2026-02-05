# Backend Setup Instructions

## Prerequisites
- Node.js installed
- OpenRouter API key

## Installation

1. Navigate to backend directory:
```bash
cd backend
```

2. Install dependencies (already done):
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Edit `.env` and add your OpenRouter API key:
```
OPENROUTER_API_KEY=sk-or-v1-your-key-here
PORT=3000
```

## Running the Backend

Start the server:
```bash
npm start
```

The backend will run on `http://localhost:3000`

## Testing

Test the health endpoint:
```bash
curl http://localhost:3000/health
```

## Chrome Extension Configuration

1. **Reload the extension** in Chrome
2. Go to **Options** page
3. Enter backend URL: `http://localhost:3000`
4. (Optional) Add OpenRouter API key if using direct mode
5. **Save** settings

## Usage Modes

### Backend Mode (Recommended)
- Backend URL configured: `http://localhost:3000`
- API key stored securely on backend
- All processing happens server-side

### Direct Mode
- Backend URL empty
- API key required in extension options
- Extension calls OpenRouter directly
