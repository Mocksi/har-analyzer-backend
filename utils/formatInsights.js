function formatInsights(insights) {
  const categories = {
    'Performance Metrics & Bottlenecks': [],
    'Security Configurations': [],
    'Technical Recommendations': [],
    'Overall Recommendations': []
  };

  insights.forEach(insight => {
    const cleanContent = insight.content
      .replace(/^### .+?\n/gm, '') // Remove markdown headers
      .replace(/\*\*(.+?)\*\*/g, (_, p1) => `**${p1.trim()}**`) // Clean up bold text
      .trim();

    if (insight.category.includes('Performance')) {
      categories['Performance Metrics & Bottlenecks'].push(cleanContent);
    } else if (insight.category.includes('Security')) {
      categories['Security Configurations'].push(cleanContent);
    } else if (insight.category.includes('Technical')) {
      categories['Technical Recommendations'].push(cleanContent);
    } else {
      categories['Overall Recommendations'].push(cleanContent);
    }
  });

  return Object.entries(categories)
    .filter(([_, items]) => items.length > 0)
    .map(([category, items]) => ({
      category,
      content: items.join('\n\n'),
      severity: determineSeverity(items.join(' ')),
      timestamp: new Date().toISOString()
    }));
} 