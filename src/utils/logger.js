/**
 * Logger Utility for WhatsApp to Telegram Bot
 * 
 * This module provides centralized logging functionality using Winston.
 * It supports file rotation, console output, and structured logging with
 * different log levels for development and production environments.
 * 
 * Features:
 * - File and console logging
 * - Log rotation with size limits
 * - Structured JSON logging
 * - Different log levels for different environments
 * - Error tracking and monitoring
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const config = require('../config');

class Logger {
    constructor() {
        this.logger = null;
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
            })
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