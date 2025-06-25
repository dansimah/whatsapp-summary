/**
 * Logger Utility for WhatsApp to Telegram Bot
 * 
 * This module provides centralized logging functionality using Winston.
 * It supports file rotation, console output, structured logging with
 * different log levels for development and production environments,
 * and Telegram notifications for important events.
 * 
 * Features:
 * - File and console logging
 * - Log rotation with size limits
 * - Structured JSON logging
 * - Different log levels for different environments
 * - Error tracking and monitoring
 * - Telegram notifications for important events
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../config');

/**
 * Custom Winston transport for Telegram notifications
 */
class TelegramTransport extends winston.Transport {
    constructor(options = {}) {
        super(options);
        this.telegramService = null;
        this.enabledLevels = options.enabledLevels || ['error', 'warn'];
        this.enabledServices = options.enabledServices || ['*']; // '*' means all services
        this.maxMessageLength = options.maxMessageLength || 4000;
        this.serviceFilters = options.serviceFilters || {}; // Service-specific level filters
        
        // Rate limiting and batching
        this.messageQueue = [];
        this.isProcessing = false;
        this.rateLimitDelay = options.rateLimiting?.delayBetweenMessages || 1000; // 1 second between messages
        this.batchSize = options.rateLimiting?.batchSize || 5; // Max messages per batch
        this.batchTimeout = options.rateLimiting?.batchTimeout || 5000; // 5 seconds max wait for batch
        this.lastMessageTime = 0;
    }

    setTelegramService(telegramService) {
        this.telegramService = telegramService;
    }

    /**
     * Configure which services and levels should be sent to Telegram
     * @param {Object} config - Configuration object
     * @param {Array} config.enabledLevels - Log levels to send (e.g., ['error', 'warn', 'info'])
     * @param {Array} config.enabledServices - Services to monitor (e.g., ['whatsapp', 'telegram']) or ['*'] for all
     * @param {Object} config.serviceFilters - Service-specific level filters
     */
    configure(config) {
        if (config.enabledLevels) {
            this.enabledLevels = config.enabledLevels;
        }
        if (config.enabledServices) {
            this.enabledServices = config.enabledServices;
        }
        if (config.serviceFilters) {
            this.serviceFilters = config.serviceFilters;
        }
    }

    /**
     * Check if a log entry should be sent to Telegram
     * @param {Object} info - Log entry info
     * @returns {boolean} - Whether to send to Telegram
     */
    shouldSendToTelegram(info) {
        const { level, message, service } = info;
        
        // Check if service is enabled
        const serviceEnabled = this.enabledServices.includes('*') || 
                              this.enabledServices.includes(service);
        
        if (!serviceEnabled) {
            return false;
        }
        
        // Check service-specific level filter first
        if (service && this.serviceFilters[service]) {
            return this.serviceFilters[service].includes(level);
        }
        
        // Fall back to global level filter
        return this.enabledLevels.includes(level);
    }

    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        // Only queue for Telegram if service is set and should send
        if (this.telegramService && this.shouldSendToTelegram(info)) {
            try {
                const message = this.formatMessage(info);
                if (message) {
                    this.queueMessage(message);
                }
            } catch (error) {
                console.error('Error formatting log message for Telegram:', error);
            }
        }

        callback();
    }

    /**
     * Queue a message for sending to Telegram
     * @param {string} message - Formatted message
     */
    queueMessage(message) {
        this.messageQueue.push(message);
        
        // Start processing if not already running
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    /**
     * Process the message queue with rate limiting
     */
    async processQueue() {
        if (this.isProcessing || this.messageQueue.length === 0) {
            return;
        }

        this.isProcessing = true;

        try {
            while (this.messageQueue.length > 0) {
                // Take up to batchSize messages
                const batch = this.messageQueue.splice(0, this.batchSize);
                
                // Send each message with rate limiting
                for (const message of batch) {
                    await this.sendMessageWithRateLimit(message);
                }
                
                // If there are more messages, wait before next batch
                if (this.messageQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, this.batchTimeout));
                }
            }
        } catch (error) {
            console.error('Error processing Telegram message queue:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Send a message with rate limiting
     * @param {string} message - Message to send
     */
    async sendMessageWithRateLimit(message) {
        try {
            // Ensure rate limiting
            const now = Date.now();
            const timeSinceLastMessage = now - this.lastMessageTime;
            
            if (timeSinceLastMessage < this.rateLimitDelay) {
                const waitTime = this.rateLimitDelay - timeSinceLastMessage;
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }

            // Send message
            await this.telegramService.sendStatusUpdate(message);
            this.lastMessageTime = Date.now();
            
        } catch (error) {
            console.error('Error sending message to Telegram:', error);
            
            // If it's a rate limit error, wait longer
            if (error.code === 'ETELEGRAM' && error.response && error.response.statusCode === 429) {
                const retryAfter = error.response.body.parameters?.retry_after || 5;
                console.log(`Rate limited by Telegram, waiting ${retryAfter} seconds...`);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            }
        }
    }

    formatMessage(info) {
        const { level, message, timestamp, service, ...meta } = info;
        
        // Create a formatted message
        let formattedMessage = `📋 *${level.toUpperCase()}*`;
        
        if (service) {
            formattedMessage += ` [${service}]`;
        }
        
        formattedMessage += `\n${message}`;
        
        // Add timestamp if available
        if (timestamp) {
            formattedMessage += `\n⏰ ${timestamp}`;
        }
        
        // Add relevant metadata (excluding sensitive info)
        const relevantMeta = { ...meta };
        delete relevantMeta.stack; // Don't include stack traces in Telegram
        
        if (Object.keys(relevantMeta).length > 0) {
            const metaStr = JSON.stringify(relevantMeta, null, 2);
            if (metaStr.length < 500) { // Only include short metadata
                formattedMessage += `\n📊 \`\`\`\n${metaStr}\n\`\`\``;
            }
        }
        
        // Truncate if too long
        if (formattedMessage.length > this.maxMessageLength) {
            formattedMessage = formattedMessage.substring(0, this.maxMessageLength - 3) + '...';
        }
        
        return formattedMessage;
    }
}

class Logger {
    constructor() {
        this.logger = null;
        this.telegramTransport = null;
        this.initializeLogger();
    }

    /**
     * Initialize Winston logger with file and console transports
     */
    initializeLogger() {
        // Ensure log directory exists
        const logDir = path.dirname(config.get('logging.filePath'));
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }

        // Define log format
        const logFormat = winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.errors({ stack: true }),
            winston.format.json()
        );

        // Define console format for development
        const consoleFormat = winston.format.combine(
            winston.format.colorize(),
            winston.format.timestamp({
                format: 'HH:mm:ss'
            }),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                let msg = `${timestamp} [${level}]: ${message}`;
                if (Object.keys(meta).length > 0) {
                    msg += ` ${JSON.stringify(meta)}`;
                }
                return msg;
            })
        );

        // Create Telegram transport
        this.telegramTransport = new TelegramTransport({
            level: 'info',
            enabledLevels: config.get('logging.telegram.enabledLevels') || ['error', 'warn'],
            maxMessageLength: config.get('logging.telegram.maxMessageLength') || 4000
        });

        // Create transports
        const transports = [
            // File transport with rotation
            new winston.transports.File({
                filename: config.get('logging.filePath'),
                level: config.get('logging.level'),
                format: logFormat,
                maxsize: config.get('logging.fileRotation.maxSize') || '10m',
                maxFiles: config.get('logging.fileRotation.maxFiles') || 5
            }),
            // Error file transport
            new winston.transports.File({
                filename: path.join(logDir, 'error.log'),
                level: 'error',
                format: logFormat,
                maxsize: '10m',
                maxFiles: 5
            }),
            // Telegram transport
            this.telegramTransport
        ];

        // Add console transport for development
        if (config.get('app.nodeEnv') === 'development') {
            transports.push(
                new winston.transports.Console({
                    level: 'debug',
                    format: consoleFormat
                })
            );
        }

        // Create logger instance
        this.logger = winston.createLogger({
            level: config.get('logging.level'),
            format: logFormat,
            transports: transports,
            exitOnError: false
        });

        // Handle uncaught exceptions
        this.logger.exceptions.handle(
            new winston.transports.File({
                filename: path.join(logDir, 'exceptions.log'),
                maxsize: '10m',
                maxFiles: 5
            })
        );

        // Handle unhandled rejections
        this.logger.rejections.handle(
            new winston.transports.File({
                filename: path.join(logDir, 'rejections.log'),
                maxsize: '10m',
                maxFiles: 5
            })
        );
    }

    /**
     * Set Telegram service for sending log messages
     * @param {Object} telegramService - Telegram service instance
     */
    setTelegramService(telegramService) {
        if (this.telegramTransport) {
            this.telegramTransport.setTelegramService(telegramService);
        }
    }

    /**
     * Configure Telegram logging with granular control
     * @param {Object} config - Configuration object
     * @param {Array} config.enabledLevels - Log levels to send (e.g., ['error', 'warn', 'info'])
     * @param {Array} config.enabledServices - Services to monitor (e.g., ['whatsapp', 'telegram']) or ['*'] for all
     * @param {Object} config.serviceFilters - Service-specific level filters
     * @param {number} config.maxMessageLength - Maximum message length for Telegram
     */
    configureTelegramLogging(config) {
        if (this.telegramTransport) {
            this.telegramTransport.configure(config);
        }
    }

    /**
     * Configure which log levels should be sent to Telegram (global)
     * @param {Array} levels - Array of log levels to send to Telegram
     */
    setTelegramLevels(levels) {
        if (this.telegramTransport) {
            this.telegramTransport.configure({ enabledLevels: levels });
        }
    }

    /**
     * Configure which services should send logs to Telegram
     * @param {Array} services - Array of service names or ['*'] for all services
     */
    setTelegramServices(services) {
        if (this.telegramTransport) {
            this.telegramTransport.configure({ enabledServices: services });
        }
    }

    /**
     * Configure service-specific log level filters
     * @param {Object} filters - Object with service names as keys and arrays of log levels as values
     * @example { 'whatsapp': ['error', 'warn'], 'telegram': ['error'] }
     */
    setTelegramServiceFilters(filters) {
        if (this.telegramTransport) {
            this.telegramTransport.configure({ serviceFilters: filters });
        }
    }

    /**
     * Send a custom message to Telegram (bypasses log level filtering)
     * @param {string} message - Message to send
     */
    sendToTelegram(message) {
        if (this.telegramTransport && this.telegramTransport.telegramService) {
            this.telegramTransport.telegramService.sendStatusUpdate(message).catch(error => {
                console.error('Error sending custom message to Telegram:', error);
            });
        }
    }

    /**
     * Log info message
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    info(message, meta = {}) {
        this.logger.info(message, meta);
    }

    /**
     * Log error message
     * @param {string} message - Log message
     * @param {Error|object} error - Error object or metadata
     */
    error(message, error = {}) {
        const meta = error instanceof Error ? {
            error: error.message,
            stack: error.stack,
            ...error
        } : error;
        
        this.logger.error(message, meta);
    }

    /**
     * Log warning message
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    warn(message, meta = {}) {
        this.logger.warn(message, meta);
    }

    /**
     * Log debug message
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    debug(message, meta = {}) {
        this.logger.debug(message, meta);
    }

    /**
     * Log WhatsApp-specific messages
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    whatsapp(message, meta = {}) {
        this.logger.info(`[WhatsApp] ${message}`, { service: 'whatsapp', ...meta });
    }

    /**
     * Log Telegram-specific messages
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    telegram(message, meta = {}) {
        this.logger.info(`[Telegram] ${message}`, { service: 'telegram', ...meta });
    }

    /**
     * Log Gemini AI-specific messages
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    gemini(message, meta = {}) {
        this.logger.info(`[Gemini] ${message}`, { service: 'gemini', ...meta });
    }

    /**
     * Log database-specific messages
     * @param {string} message - Log message
     * @param {object} meta - Additional metadata
     */
    database(message, meta = {}) {
        this.logger.info(`[Database] ${message}`, { service: 'database', ...meta });
    }

    /**
     * Get logger instance for advanced usage
     * @returns {winston.Logger} Winston logger instance
     */
    getLogger() {
        return this.logger;
    }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger; 