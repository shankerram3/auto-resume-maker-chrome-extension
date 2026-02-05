require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'frontend')));

// API Routes
app.use('/api', resumeRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve frontend for all other routes (SPA fallback)
app.get('*', (req, res) => {
    // Don't serve index.html for API routes
    if (req.path.startsWith('/api') || req.path === '/health') {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, 'frontend/index.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`✅ Resume Generator Backend running on http://localhost:${PORT}`);
    console.log(`📋 API endpoint: http://localhost:${PORT}/api/generate-resume`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`🌐 Frontend: http://localhost:${PORT}`);
});
