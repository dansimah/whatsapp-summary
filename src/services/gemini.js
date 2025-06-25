/**
 * Gemini AI Service for WhatsApp to Telegram Bot
 * 
 * This module handles all interactions with Google's Gemini AI API for
 * message summarization and information extraction. It provides intelligent
 * processing of WhatsApp messages with configurable prompts and parameters.
 * 
 * Features:
 * - Message summarization using Gemini 1.5 Flash
 * - Homework and information extraction
 * - Configurable prompts and parameters
 * - Rate limiting and error handling
 * - Response formatting and validation
 * - Token usage tracking
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const logger = require('../utils/logger');

class GeminiService {
    constructor() {
        this.genAI = null;
        this.model = null;
        this.isInitialized = false;
        this.rateLimitDelay = 1000; // 1 second between requests
        this.lastRequestTime = 0;
    }

    /**
     * Initialize Gemini AI client
     */
    async initialize() {
        try {
            logger.gemini('Initializing Gemini AI service');

            const apiKey = config.get('gemini.apiKey');
            if (!apiKey) {
                throw new Error('Gemini API key not configured');
            }

            this.genAI = new GoogleGenerativeAI(apiKey);
            const modelName = config.get('gemini.model') || 'gemini-1.5-flash';
            this.model = this.genAI.getGenerativeModel({ 
                model: modelName,
                generationConfig: {
                    temperature: config.get('gemini.temperature') || 0.3,
                    maxOutputTokens: config.get('gemini.maxTokens') || 1000000,
                }
            });

            this.isInitialized = true;
            logger.gemini(`Gemini AI service initialized with model: ${modelName}`);
        } catch (error) {
            logger.error('Gemini AI service initialization failed', error);
            throw error;
        }
    }

    /**
     * Apply rate limiting to prevent API quota issues
     */
    async applyRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.rateLimitDelay) {
            const delay = this.rateLimitDelay - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        this.lastRequestTime = Date.now();
    }

    /**
     * Generate a summary of WhatsApp messages
     * @param {Array} messages - Array of message objects
     * @param {string} groupName - Name of the group
     * @param {string} date - Date for the summary
     * @returns {Promise<string>} Generated summary
     */
    async generateSummary(messages, groupName, date) {
        try {
            if (!this.isInitialized) {
                throw new Error('Gemini AI service not initialized');
            }

            if (!messages || messages.length === 0) {
                return 'No messages found for the specified period.';
            }

            await this.applyRateLimit();

            // Debug: Log messages received by Gemini
            logger.gemini('DEBUG: Messages received for summary generation', {
                groupName,
                date,
                messageCount: messages.length,
                messageIds: messages.map(m => m.id || m.wa_message_id).slice(0, 5),
                totalContentLength: messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0),
                sampleContents: messages.slice(0, 3).map(m => ({
                    id: m.id || m.wa_message_id,
                    content: m.content ? m.content.substring(0, 100) + '...' : 'empty',
                    sender: m.sender_name
                }))
            });

            // Format messages for the prompt
            const formattedMessages = this.formatMessagesForPrompt(messages);
            
            // Debug: Log formatted messages
            logger.gemini('DEBUG: Formatted messages for prompt', {
                formattedLength: formattedMessages.length,
                preview: formattedMessages.substring(0, 500) + '...'
            });
            
            // Create the prompt with enhanced instructions
            const basePrompt = config.get('gemini.prompts.summarization') || 
                'Analyze the following WhatsApp messages and create a comprehensive summary. IMPORTANT: Respond in the same language as the majority of the messages (Hebrew, French, English, etc.).\n\nStructure your summary as follows:\n1. Identify the main topics discussed\n2. For each topic, specify how many messages were about that topic\n3. Include key details, announcements, and important information\n4. Use bullet points for clarity\n\nExample format:\n• Electricity shutdown - should be fixed at 15:40 (15 messages)\n• New parking regulations announced (8 messages)\n• Community event planning for next week (12 messages)\n\nFocus on practical information that people need to know.';
            
            const fullPrompt = `${basePrompt}\n\nGroup: ${groupName}\nDate: ${date}\nTotal Messages: ${messages.length}\n\nMessages:\n${formattedMessages}`;

            // Debug: Log full prompt
            logger.gemini('DEBUG: Full prompt for Gemini', {
                promptLength: fullPrompt.length,
                promptPreview: fullPrompt.substring(0, 1000) + '...'
            });

            logger.gemini('Generating summary', { 
                groupName, 
                date, 
                messageCount: messages.length 
            });

            // Generate content
            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            const summary = response.text();

            if (!summary || summary.trim().length === 0) {
                throw new Error('Empty response from Gemini AI');
            }

            // Debug: Log Gemini response
            logger.gemini('DEBUG: Gemini response received', {
                responseLength: summary.length,
                responsePreview: summary.substring(0, 300) + '...',
                fullResponse: summary
            });

            logger.gemini('Summary generated successfully', { 
                groupName, 
                date, 
                summaryLength: summary.length 
            });

            return summary;

        } catch (error) {
            logger.error('Error generating summary', { 
                groupName, 
                date, 
                messageCount: messages?.length, 
                error 
            });
            throw error;
        }
    }

    /**
     * Extract homework assignments from messages
     * @param {Array} messages - Array of message objects
     * @param {string} groupName - Name of the group
     * @param {string} date - Date for the extraction
     * @returns {Promise<string>} Extracted homework information
     */
    async extractHomework(messages, groupName, date) {
        try {
            if (!this.isInitialized) {
                throw new Error('Gemini AI service not initialized');
            }

            if (!messages || messages.length === 0) {
                return 'No messages found for the specified period.';
            }

            await this.applyRateLimit();

            // Format messages for the prompt
            const formattedMessages = this.formatMessagesForPrompt(messages);
            
            // Create the prompt
            const basePrompt = config.get('gemini.prompts.homeworkExtraction') || 
                'Extract homework assignments from the following messages. Format as: Subject - Due Date - Description:';
            
            const fullPrompt = `${basePrompt}\n\nGroup: ${groupName}\nDate: ${date}\n\nMessages:\n${formattedMessages}`;

            logger.gemini('Extracting homework', { 
                groupName, 
                date, 
                messageCount: messages.length 
            });

            // Generate content
            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            const homework = response.text();

            if (!homework || homework.trim().length === 0) {
                return 'No homework assignments found in the messages.';
            }

            logger.gemini('Homework extracted successfully', { 
                groupName, 
                date, 
                homeworkLength: homework.length 
            });

            return homework;

        } catch (error) {
            logger.error('Error extracting homework', { 
                groupName, 
                date, 
                messageCount: messages?.length, 
                error 
            });
            throw error;
        }
    }

    /**
     * Format messages for AI prompt
     * @param {Array} messages - Array of message objects
     * @returns {string} Formatted messages string
     */
    formatMessagesForPrompt(messages) {
        if (!messages || messages.length === 0) {
            return '';
        }

        return messages.map((msg, index) => {
            const timestamp = new Date(msg.timestamp).toLocaleTimeString();
            const sender = msg.sender_name || 'Unknown';
            const content = msg.content || '';
            
            // Add message number for better reference
            return `${index + 1}. [${timestamp}] ${sender}: ${content}`;
        }).join('\n\n');
    }

    /**
     * Generate a custom analysis based on a specific prompt
     * @param {Array} messages - Array of message objects
     * @param {string} customPrompt - Custom prompt for analysis
     * @param {Object} context - Additional context
     * @returns {Promise<string>} Generated analysis
     */
    async generateCustomAnalysis(messages, customPrompt, context = {}) {
        try {
            if (!this.isInitialized) {
                throw new Error('Gemini AI service not initialized');
            }

            if (!messages || messages.length === 0) {
                return 'No messages found for analysis.';
            }

            await this.applyRateLimit();

            // Format messages for the prompt
            const formattedMessages = this.formatMessagesForPrompt(messages);
            
            // Create the full prompt with context
            const contextStr = Object.keys(context).length > 0 
                ? `\nContext: ${JSON.stringify(context, null, 2)}\n`
                : '';
            
            const fullPrompt = `${customPrompt}${contextStr}\n\nMessages:\n${formattedMessages}`;

            logger.gemini('Generating custom analysis', { 
                promptLength: customPrompt.length,
                messageCount: messages.length,
                context: Object.keys(context)
            });

            // Generate content
            const result = await this.model.generateContent(fullPrompt);
            const response = await result.response;
            const analysis = response.text();

            if (!analysis || analysis.trim().length === 0) {
                throw new Error('Empty response from Gemini AI');
            }

            logger.gemini('Custom analysis generated successfully', { 
                analysisLength: analysis.length 
            });

            return analysis;

        } catch (error) {
            logger.error('Error generating custom analysis', { 
                customPrompt: customPrompt.substring(0, 100),
                messageCount: messages?.length, 
                error 
            });
            throw error;
        }
    }

    /**
     * Test the Gemini AI connection
     * @returns {Promise<boolean>} True if connection is working
     */
    async testConnection() {
        try {
            if (!this.isInitialized) {
                await this.initialize();
            }

            const testPrompt = 'Hello, this is a test message. Please respond with "Connection successful."';
            const result = await this.model.generateContent(testPrompt);
            const response = await result.response;
            const text = response.text();

            logger.gemini('Connection test successful', { response: text });
            return true;

        } catch (error) {
            logger.error('Gemini AI connection test failed', error);
            return false;
        }
    }

    /**
     * Get service status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            model: config.get('gemini.model') || 'gemini-1.5-flash',
            temperature: config.get('gemini.temperature') || 0.3,
            maxTokens: config.get('gemini.maxTokens') || 1000000,
            rateLimitDelay: this.rateLimitDelay
        };
    }

    /**
     * Update rate limit delay
     * @param {number} delay - Delay in milliseconds
     */
    setRateLimitDelay(delay) {
        this.rateLimitDelay = Math.max(100, delay); // Minimum 100ms
        logger.gemini(`Rate limit delay updated to ${this.rateLimitDelay}ms`);
    }

    /**
     * Check if service is ready
     * @returns {boolean} True if ready
     */
    isReady() {
        return this.isInitialized && this.model;
    }
}

// Create singleton instance
const geminiService = new GeminiService();

module.exports = geminiService; 