class HARAnalyzer {
  constructor(harContent) {
    this.harContent = harContent;
    this.metrics = {
      general: {
        totalRequests: 0,
        totalSize: 0,
        totalDuration: 0,
        uniqueDomains: new Set(),
        timestamp: new Date()
      },
      performance: {
        timings: {
          dns: [],
          connect: [],
          ssl: [],
          wait: [],
          receive: []
        },
        slowRequests: [],
        largePayloads: [],
        compressionOpportunities: []
      },
      errors: {
        clientErrors: [],
        serverErrors: [],
        corsIssues: [],
        sslIssues: [],
        malformedRequests: []
      },
      security: {
        insecureRequests: [],
        sensitiveData: [],
        missingHeaders: []
      },
      api: {
        endpoints: {},
        responsePatterns: {},
        statusDistribution: {}
      }
    };
  }

  analyze() {
    this.harContent.log.entries.forEach(entry => {
      this.processEntry(entry);
    });
    
    return {
      metrics: this.metrics,
      insights: this.generatePersonaInsights()
    };
  }

  processEntry(entry) {
    this.analyzeRequest(entry);
    this.analyzeResponse(entry);
    this.analyzePerformance(entry);
    this.analyzeAPI(entry);
    this.analyzeSecurity(entry);
  }

  generatePersonaInsights() {
    return {
      developer: this.generateDeveloperInsights(),
      qa: this.generateQAInsights(),
      salesEngineer: this.generateSalesEngineerInsights()
    };
  }
} 