function parseAIResponse(aiResponse) {
  try {
    const sections = typeof aiResponse === 'string' 
      ? aiResponse.split(/(?=### )/g)
      : [aiResponse];

    return formatInsights(sections.map(section => ({
      category: section.match(/### ([^\n]+)/)?.[1] || 'General',
      content: section.replace(/^### .+?\n/gm, ''),
      severity: 'info'
    })));
  } catch (error) {
    console.error('Failed to parse AI response:', error);
    return [{
      category: 'error',
      severity: 'error',
      message: 'Failed to parse insights',
      content: aiResponse,
      timestamp: new Date().toISOString()
    }];
  }
}
