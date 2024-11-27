function analyzeHAR(harContent) {
  const metrics = {
    // General metrics
    totalRequests: 0,
    totalSize: 0,
    totalTime: 0,
    
    // Primary metrics for overview
    primary: {
      totalRequests: 0,
      avgResponseTime: 0,
      totalSize: 0,
      errorRate: 0
    },

    // Selected metrics for drilldown
    selected: {
      slowestRequests: [],
      largestRequests: [],
      errorRequests: []
    },

    // Time series data
    timeseries: [],

    // Request categorization
    requestsByType: {},
    statusCodes: {},
    domains: [],

    // HTTP specific metrics
    httpMetrics: {
      requests: 0,
      totalSize: 0,
      totalTime: 0,
      statusCodes: {},
      requestsByType: {},
      slowestRequests: [],
      largestRequests: [],
      cacheHits: 0,
      cacheMisses: 0,
      securityIssues: []
    },
    
    // WebSocket specific metrics
    websocketMetrics: {
      connections: 0,
      messageCount: 0,
      sentMessages: 0,
      receivedMessages: 0,
      totalMessageSize: 0,
      averageMessageSize: 0,
      connectionDuration: 0,
      messageTypes: {},
      protocols: new Set(),
      errors: []
    }
  };

  if (!harContent?.log?.entries) {
    return metrics;
  }

  // Process entries and populate metrics
  harContent.log.entries.forEach(entry => {
    metrics.totalRequests++;
    
    if (entry._resourceType === 'websocket') {
      processWebSocketEntry(entry, metrics);
    } else {
      processHTTPEntry(entry, metrics);
    }

    // Build timeseries data
    const timestamp = new Date(entry.startedDateTime).getTime();
    metrics.timeseries.push({
      timestamp,
      responseTime: entry.time,
      size: calculateEntrySize(entry),
      type: entry._resourceType || 'other'
    });
  });

  // Calculate averages and populate primary metrics
  metrics.primary = {
    totalRequests: metrics.totalRequests,
    avgResponseTime: metrics.totalTime / metrics.totalRequests || 0,
    totalSize: metrics.totalSize,
    errorRate: calculateErrorRate(metrics.httpMetrics.statusCodes)
  };

  // Sort and limit arrays
  metrics.selected = {
    slowestRequests: metrics.httpMetrics.slowestRequests.slice(0, 5),
    largestRequests: metrics.httpMetrics.largestRequests.slice(0, 5),
    errorRequests: metrics.httpMetrics.statusCodes['4xx'] || 0
  };

  // Convert Sets to arrays
  metrics.domains = Array.from(metrics.domains);
  metrics.websocketMetrics.protocols = Array.from(metrics.websocketMetrics.protocols);

  return metrics;
}

function processWebSocketEntry(entry, metrics) {
  metrics.websocketMetrics.connections++;
  
  if (entry._webSocketMessages) {
    entry._webSocketMessages.forEach(msg => {
      metrics.websocketMetrics.messageCount++;
      if (msg.type === 'send') metrics.websocketMetrics.sentMessages++;
      if (msg.type === 'receive') metrics.websocketMetrics.receivedMessages++;
      metrics.websocketMetrics.totalMessageSize += msg.data?.length || 0;
      metrics.websocketMetrics.messageTypes[msg.type] = 
        (metrics.websocketMetrics.messageTypes[msg.type] || 0) + 1;
    });
  }

  metrics.websocketMetrics.connectionDuration += entry.time;
}

function processHTTPEntry(entry, metrics) {
  const size = calculateEntrySize(entry);
  const type = entry._resourceType || 'other';
  
  metrics.totalSize += size;
  metrics.totalTime += entry.time;
  metrics.domains.add(new URL(entry.request.url).hostname);
  
  // Update request type counts
  metrics.requestsByType[type] = (metrics.requestsByType[type] || 0) + 1;
  
  // Update status code counts
  const status = entry.response.status;
  const statusCategory = `${Math.floor(status/100)}xx`;
  metrics.statusCodes[statusCategory] = (metrics.statusCodes[statusCategory] || 0) + 1;
  
  // Track slow requests
  if (entry.time > 1000) {
    metrics.httpMetrics.slowestRequests.push({
      url: entry.request.url,
      time: entry.time,
      type: type
    });
  }
}

function calculateEntrySize(entry) {
  return entry.response.bodySize > 0 ? entry.response.bodySize : 0;
}

function calculateErrorRate(statusCodes) {
  const errors = (statusCodes['4xx'] || 0) + (statusCodes['5xx'] || 0);
  const total = Object.values(statusCodes).reduce((sum, count) => sum + count, 0);
  return total > 0 ? errors / total : 0;
}

module.exports = analyzeHAR; 