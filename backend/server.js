require('dotenv').config();
const express = require('express');
const cors = require('cors');
const resumeRouter = require('./routes/resume');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
    origin: '*', // Allow Chrome extension to access
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '10mb' })); // Allow large resume content

// Routes
app.use('/api', resumeRouter);

// Root endpoint - API information
app.get('/', (req, res) => {
    res.json({
        name: 'Resume Generator API',
        version: '1.0.0',
        status: 'running',
        endpoints: {
            health: '/health',
            generateResume: 'POST /api/generate-resume',
        },
        documentation: 'https://github.com/shankerram3/auto-resume-maker-chrome-extension',
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Resume Generator Backend running on http://localhost:${PORT}`);
    console.log(`📋 API endpoint: http://localhost:${PORT}/api/generate-resume`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});
