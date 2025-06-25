/**
 * Configuration Manager for WhatsApp to Telegram Bot
 * 
 * This module handles all configuration loading and validation for the application.
 * It loads environment variables from .env file and merges them with config.json
 * to provide a unified configuration interface.
 * 
 * Features:
 * - Environment variable loading with dotenv
 * - Configuration validation
 * - Default value fallbacks
 * - Centralized configuration access
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();

class ConfigManager {
    constructor() {
        this.config = {};
        this.loadConfiguration();
    }

    /**
     * Load and merge configuration from environment variables and config.json
     */
    loadConfiguration() {
        // Load config.json
        const configPath = path.join(process.cwd(), 'config.json');
        let appConfig = {};
        
        try {
            if (fs.existsSync(configPath)) {
                appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            }
        } catch (error) {
            console.error('Error loading config.json:', error.message);
        }

        // Merge environment variables with config.json
        this.config = {
            telegram: {
                botToken: process.env.TELEGRAM_BOT_TOKEN,
                statusGroupId: process.env.TELEGRAM_STATUS_GROUP_ID,
                allowedUsername: process.env.TELEGRAM_ALLOWED_USERNAME || 'dansi',
                ...appConfig.telegram
            },
            gemini: {
                apiKey: process.env.GEMINI_API_KEY,
                ...appConfig.gemini
            },
            whatsapp: {
                sessionFilePath: process.env.WHATSAPP_SESSION_FILE_PATH || './sessions/session.json',
                batchIntervalMinutes: parseInt(process.env.WHATSAPP_BATCH_INTERVAL_MINUTES) || 5,
                ...appConfig.whatsapp
            },
            database: {
                path: process.env.DATABASE_PATH || './data/messages.db',
                ...appConfig.database
            },
            logging: {
                level: process.env.LOG_LEVEL || 'info',
                filePath: process.env.LOG_FILE_PATH || './logs/app.log',
                ...appConfig.logging
            },
            app: {
                nodeEnv: process.env.NODE_ENV || 'development',
                port: parseInt(process.env.PORT) || 3000
            }
        };

        this.validateConfiguration();
    }

    /**
     * Validate required configuration values
     */
    validateConfiguration() {
        const required = [
            'telegram.botToken',
            'telegram.statusGroupId',
            'gemini.apiKey'
        ];

        const missing = required.filter(key => {
            const value = this.get(key);
            return !value || value === 'your_telegram_bot_token_here' || 
                   value === 'your_gemini_api_key_here' || 
                   value === 'your_status_group_chat_id_here';
        });

        if (missing.length > 0) {
            throw new Error(`Missing required configuration: ${missing.join(', ')}`);
        }
    }

    /**
     * Get configuration value using dot notation
     * @param {string} key - Configuration key (e.g., 'telegram.botToken')
     * @returns {any} Configuration value
     */
    get(key) {
        return key.split('.').reduce((obj, k) => obj && obj[k], this.config);
    }

    /**
     * Get entire configuration object
     * @returns {object} Complete configuration
     */
    getAll() {
        return this.config;
    }

    /**
     * Check if configuration is valid for production
     * @returns {boolean} True if valid for production
     */
    isProductionReady() {
        try {
            this.validateConfiguration();
            return true;
        } catch (error) {
            return false;
        }
    }
}

// Create singleton instance
const configManager = new ConfigManager();

module.exports = configManager; 