# HAR Analyzer Backend

A Node.js backend service for analyzing HAR (HTTP Archive) files with AI-powered insights.

## Quick Start
'''bash
Install dependencies
npm install
Start server
npm start
'''

## Environment Variables

Create a `.env` file in the root directory:
'''env
PORT=3001
OPENAI_API_KEY=your_key_here
REDIS_URL=redis://localhost:6379
CORS_ORIGINS=http://localhost:3000,https://har-analyzer-frontend.onrender.com
'''


## API Endpoints

### POST /analyze
Accepts HAR file uploads and initiates analysis
- Body: multipart/form-data with HAR file
- Returns: `{ jobId: string }`

### GET /results/:jobId
Retrieves analysis results
- Returns: Analysis metrics and AI-generated insights

## Architecture

- Express.js server with BullMQ for job processing
- Redis for job queue and caching
- OpenAI integration for persona-specific insights
- HAR parsing and validation using har-validator

## Key Features

- HAR file validation and parsing
- Performance metrics calculation
- AI-powered insights generation
- Persona-based analysis (Developer, QA, Sales Engineer)
- Asynchronous processing with job queue

## Dependencies

Referenced from package.json:
'''
json:backend/package.json
startLine: 16
endLine: 33
'''


## Development

### Prerequisites
- Node.js 18+
- Redis server
- OpenAI API key

### Code Structure
'''

backend/
├── server.js # Main Express server
├── utils/
│ ├── harAnalyzer.js # HAR processing logic
│ ├── insightGenerator.js # AI insight generation
│ └── formatInsights.js # Response formatting
└── config/
└── personas.js # Persona configurations
'''


### Error Handling

The backend implements comprehensive error handling:
- HAR file validation
- Processing timeouts
- API rate limiting
- Invalid job IDs

### Performance Considerations

- Uses streaming for large file uploads
- Implements caching for analysis results
- Batches API requests to OpenAI
- Handles concurrent processing via queue

## Deployment

Configured for deployment on platforms supporting Node.js 18+:
'''
json:backend/package.json
startLine: 6
endLine: 8
'''

## Future Improvements

- [ ] Add WebSocket support for real-time progress
- [ ] Implement result persistence
- [ ] Add batch processing support
- [ ] Enhance error analysis

