/**
 * Database Service for WhatsApp to Telegram Bot
 * 
 * This module handles all database operations using SQLite for storing
 * WhatsApp messages and related data. It provides a clean interface for
 * CRUD operations with proper error handling and connection management.
 * 
 * Features:
 * - SQLite database with WAL mode for better concurrency
 * - Message storage and retrieval
 * - Automatic schema creation and migration
 * - Data cleanup and maintenance
 * - Connection pooling and error handling
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const moment = require('moment');
const config = require('../config');
const logger = require('../utils/logger');

class DatabaseService {
    constructor() {
        this.db = null;
        this.isInitialized = false;
    }

    /**
     * Initialize database connection and create tables
     */
    async initialize() {
        try {
            // Ensure data directory exists
            const dbDir = path.dirname(config.get('database.path'));
            if (!fs.existsSync(dbDir)) {
                fs.mkdirSync(dbDir, { recursive: true });
            }

            // Create database connection
            this.db = new sqlite3.Database(config.get('database.path'), (err) => {
                if (err) {
                    logger.error('Error opening database', err);
                    throw err;
                }
                logger.database('Database connection established');
            });

            // Enable WAL mode for better concurrency
            await this.run('PRAGMA journal_mode = WAL');
            await this.run('PRAGMA synchronous = NORMAL');
            await this.run('PRAGMA cache_size = 10000');
            await this.run('PRAGMA temp_store = MEMORY');

            // Create tables
            await this.createTables();
            
            this.isInitialized = true;
            logger.database('Database initialized successfully');
        } catch (error) {
            logger.error('Database initialization failed', error);
            throw error;
        }
    }

    /**
     * Create database tables if they don't exist
     */
    async createTables() {
        const messagesTable = `
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                wa_message_id TEXT UNIQUE NOT NULL,
                chat_id TEXT NOT NULL,
                chat_name TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                sender_name TEXT NOT NULL,
                timestamp DATETIME NOT NULL,
                content TEXT NOT NULL,
                is_group BOOLEAN NOT NULL DEFAULT 1,
                processed BOOLEAN NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const groupsTable = `
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT UNIQUE NOT NULL,
                chat_name TEXT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const summariesTable = `
            CREATE TABLE IF NOT EXISTS summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                group_name TEXT NOT NULL,
                date TEXT NOT NULL,
                summary TEXT NOT NULL,
                message_count INTEGER NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_name, date)
            )
        `;

        // Create indexes for better performance
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id)',
            'CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id)',
            'CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed)',
            'CREATE INDEX IF NOT EXISTS idx_summaries_group_date ON summaries(group_name, date)'
        ];

        try {
            await this.run(messagesTable);
            await this.run(groupsTable);
            await this.run(summariesTable);
            
            for (const index of indexes) {
                await this.run(index);
            }

            logger.database('Database tables created successfully');
        } catch (error) {
            logger.error('Error creating database tables', error);
            throw error;
        }
    }

    /**
     * Execute a database query with parameters
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise} Query result
     */
    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) {
                    logger.error('Database run error', { sql, params, error: err.message });
                    reject(err);
                } else {
                    resolve({ id: this.lastID, changes: this.changes });
                }
            });
        });
    }

    /**
     * Execute a database query and return first row
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Object>} First row result
     */
    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) {
                    logger.error('Database get error', { sql, params, error: err.message });
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });
    }

    /**
     * Execute a database query and return all rows
     * @param {string} sql - SQL query
     * @param {Array} params - Query parameters
     * @returns {Promise<Array>} All rows result
     */
    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    logger.error('Database all error', { sql, params, error: err.message });
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    /**
     * Store a WhatsApp message in the database
     * @param {Object} message - Message object
     * @returns {Promise<Object>} Insert result
     */
    async storeMessage(message) {
        const sql = `
            INSERT OR REPLACE INTO messages 
            (wa_message_id, chat_id, chat_name, sender_id, sender_name, timestamp, content, is_group)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
            message.waMessageId,
            message.chatId,
            message.chatName,
            message.senderId,
            message.senderName,
            message.timestamp,
            message.content,
            message.isGroup ? 1 : 0
        ];

        try {
            const result = await this.run(sql, params);
            logger.database('Message stored successfully', { 
                messageId: message.waMessageId, 
                chatName: message.chatName 
            });
            return result;
        } catch (error) {
            logger.error('Error storing message', { message, error });
            throw error;
        }
    }

    /**
     * Get messages for a specific group and date range
     * @param {string} groupName - Group name
     * @param {string} startDate - Start date (YYYY-MM-DD)
     * @param {string} endDate - End date (YYYY-MM-DD)
     * @returns {Promise<Array>} Messages array
     */
    async getMessagesByGroupAndDate(groupName, startDate, endDate) {
        const sql = `
            SELECT * FROM messages 
            WHERE chat_name = ? 
            AND DATE(timestamp) BETWEEN ? AND ?
            ORDER BY timestamp ASC
        `;

        try {
            const messages = await this.all(sql, [groupName, startDate, endDate]);
            
            // Debug: Log messages retrieved
            logger.database('DEBUG: Messages retrieved by group and date', { 
                groupName, 
                startDate, 
                endDate, 
                count: messages.length,
                messageIds: messages.map(m => m.id).slice(0, 5),
                sampleMessages: messages.slice(0, 3).map(m => ({
                    id: m.id,
                    sender: m.sender_name,
                    content: m.content ? m.content.substring(0, 50) + '...' : 'empty',
                    timestamp: m.timestamp
                }))
            });
            
            logger.database('Retrieved messages by group and date', { 
                groupName, startDate, endDate, count: messages.length 
            });
            return messages;
        } catch (error) {
            logger.error('Error retrieving messages', { groupName, startDate, endDate, error });
            throw error;
        }
    }

    /**
     * Get all active groups
     * @returns {Promise<Array>} Groups array
     */
    async getActiveGroups() {
        const sql = 'SELECT * FROM groups WHERE is_active = 1 ORDER BY chat_name';
        
        try {
            const groups = await this.all(sql);
            logger.database('Retrieved active groups', { count: groups.length });
            return groups;
        } catch (error) {
            logger.error('Error retrieving active groups', error);
            throw error;
        }
    }

    /**
     * Store a summary for a group and date
     * @param {string} groupName - Group name
     * @param {string} date - Date (YYYY-MM-DD)
     * @param {string} summary - Summary text
     * @param {number} messageCount - Number of messages summarized
     * @returns {Promise<Object>} Insert result
     */
    async storeSummary(groupName, date, summary, messageCount) {
        const sql = `
            INSERT OR REPLACE INTO summaries 
            (group_name, date, summary, message_count)
            VALUES (?, ?, ?, ?)
        `;

        try {
            const result = await this.run(sql, [groupName, date, summary, messageCount]);
            logger.database('Summary stored successfully', { groupName, date, messageCount });
            return result;
        } catch (error) {
            logger.error('Error storing summary', { groupName, date, error });
            throw error;
        }
    }

    /**
     * Get existing summary for a group and date
     * @param {string} groupName - Group name
     * @param {string} date - Date (YYYY-MM-DD)
     * @returns {Promise<Object|null>} Summary object or null
     */
    async getSummary(groupName, date) {
        const sql = 'SELECT * FROM summaries WHERE group_name = ? AND date = ?';
        
        try {
            const summary = await this.get(sql, [groupName, date]);
            return summary;
        } catch (error) {
            logger.error('Error retrieving summary', { groupName, date, error });
            throw error;
        }
    }

    /**
     * Get message by WhatsApp message ID
     * @param {string} waMessageId - WhatsApp message ID
     * @returns {Promise<Object|null>} Message object or null
     */
    async getMessageByWhatsAppId(waMessageId) {
        const sql = 'SELECT * FROM messages WHERE wa_message_id = ?';
        
        try {
            const message = await this.get(sql, [waMessageId]);
            return message;
        } catch (error) {
            logger.error('Error retrieving message by WhatsApp ID', { waMessageId, error });
            throw error;
        }
    }

    /**
     * Clean up old messages based on retention policy
     * @returns {Promise<Object>} Cleanup result
     */
    async cleanupOldMessages() {
        const retentionDays = config.get('database.cleanup.retentionDays') || 30;
        const cutoffDate = moment().subtract(retentionDays, 'days').format('YYYY-MM-DD');
        
        const sql = 'DELETE FROM messages WHERE DATE(timestamp) < ?';
        
        try {
            const result = await this.run(sql, [cutoffDate]);
            logger.database('Old messages cleaned up', { 
                cutoffDate, deletedCount: result.changes 
            });
            return result;
        } catch (error) {
            logger.error('Error cleaning up old messages', error);
            throw error;
        }
    }

    /**
     * Close database connection
     */
    async close() {
        if (this.db) {
            return new Promise((resolve, reject) => {
                this.db.close((err) => {
                    if (err) {
                        logger.error('Error closing database', err);
                        reject(err);
                    } else {
                        logger.database('Database connection closed');
                        resolve();
                    }
                });
            });
        }
    }

    /**
     * Check if database is ready
     * @returns {boolean} True if database is initialized
     */
    isReady() {
        return this.isInitialized && this.db;
    }

    /**
     * Delete summary for a group and date
     * @param {string} groupName - Group name
     * @param {string} date - Date (YYYY-MM-DD)
     * @returns {Promise<Object>} Delete result
     */
    async deleteSummary(groupName, date) {
        const sql = 'DELETE FROM summaries WHERE group_name = ? AND date = ?';
        
        try {
            const result = await this.run(sql, [groupName, date]);
            logger.database('Summary deleted successfully', { groupName, date, deletedCount: result.changes });
            return result;
        } catch (error) {
            logger.error('Error deleting summary', { groupName, date, error });
            throw error;
        }
    }

    /**
     * Clear all summaries (for testing purposes)
     * @returns {Promise<Object>} Clear result
     */
    async clearAllSummaries() {
        const sql = 'DELETE FROM summaries';
        
        try {
            const result = await this.run(sql);
            logger.database('All summaries cleared successfully', { deletedCount: result.changes });
            return result;
        } catch (error) {
            logger.error('Error clearing all summaries', error);
            throw error;
        }
    }

    /**
     * Get the most recent message for a specific group
     * @param {string} groupName - Name of the group
     * @returns {Promise<Object>} Most recent message or null
     */
    async getLastMessageForGroup(groupName) {
        const sql = `
            SELECT * FROM messages 
            WHERE chat_name = ? AND is_group = 1
            ORDER BY timestamp DESC 
            LIMIT 1
        `;
        
        try {
            const message = await this.get(sql, [groupName]);
            return message;
        } catch (error) {
            logger.error('Error getting last message for group', { groupName, error: error.message });
            return null;
        }
    }

    /**
     * Get all groups with their last message timestamps, ordered by most recent
     * @returns {Promise<Array>} Array of groups with last message info
     */
    async getGroupsWithLastMessage() {
        const sql = `
            SELECT 
                m.chat_name as name,
                m.chat_id as id,
                MAX(m.timestamp) as last_message_time,
                COUNT(m.id) as message_count
            FROM messages m
            WHERE m.is_group = 1
            GROUP BY m.chat_name, m.chat_id
            ORDER BY last_message_time DESC
        `;
        
        try {
            const groups = await this.all(sql);
            logger.database('Retrieved groups with last message timestamps', { count: groups.length });
            return groups;
        } catch (error) {
            logger.error('Error getting groups with last message', error);
            return [];
        }
    }
}

// Create singleton instance
const databaseService = new DatabaseService();

module.exports = databaseService; 