# Use Node.js LTS version
FROM node:20-alpine

# Install pdflatex for local LaTeX compilation (optional but recommended)
# Uncomment if you want local LaTeX support
# RUN apk add --no-cache texlive-full

# Set working directory
WORKDIR /app

# Copy package files
COPY backend/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy backend source
COPY backend/ ./

# Copy frontend for serving static files at root
COPY frontend/ ../frontend/

# Create output directory
RUN mkdir -p output

# Expose port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start server
CMD ["node", "server.js"]
