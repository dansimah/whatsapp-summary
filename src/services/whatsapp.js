/**
 * WhatsApp Service for WhatsApp to Telegram Bot
 * 
 * This module handles all WhatsApp Web operations including connection,
 * session management, message listening, and batch processing. It uses
 * whatsapp-web.js with Puppeteer for headless operation in LXC containers.
 * 
 * Features:
 * - WhatsApp Web connection with session persistence
 * - QR code authentication and automatic reconnection
 * - Real-time message listening from configured groups
 * - Batch message processing with configurable intervals
 * - Robust error handling and status reporting
 * - Headless browser support for containerized deployment
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const databaseService = require('./database');
const qrcode = require('qrcode-terminal');

class WhatsAppService {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.get('whatsapp.sessionManagement.maxReconnectAttempts') || 5;
        this.reconnectInterval = config.get('whatsapp.sessionManagement.reconnectInterval') || 30000;
        this.batchInterval = config.get('whatsapp.batchIntervalMinutes') || 5;
        this.pendingMessages = [];
        this.monitoredGroups = new Set(config.get('whatsapp.groups') || []);
        this.batchJob = null;
        this.statusCallback = null;
    }

    /**
     * Initialize WhatsApp client with headless browser
     */
    async initialize() {
        try {
            logger.whatsapp('Initializing WhatsApp service');

            // Ensure sessions directory exists
            const sessionDir = path.dirname(config.get('whatsapp.sessionFilePath'));
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }

            // Configure Puppeteer for headless operation
            const browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu'
                ]
            });

            // Create WhatsApp client
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: 'whatsapp-telegram-bot',
                    dataPath: sessionDir
                }),
                puppeteer: {
                    browser: browser
                },
                webVersion: '2.2402.5',
                webVersionCache: {
                    type: 'local'
                }
            });

            // Set up event handlers
            this.setupEventHandlers();

            // Start batch processing
            this.startBatchProcessing();

            logger.whatsapp('WhatsApp service initialized successfully');
        } catch (error) {
            logger.error('WhatsApp service initialization failed', error);
            throw error;
        }
    }

    /**
     * Set up WhatsApp client event handlers
     */
    setupEventHandlers() {
        // Authentication events
        this.client.on('qr', (qr) => {
            logger.whatsapp('QR Code received, please scan to authenticate');
            // Display QR code in terminal
            qrcode.generate(qr, { small: true });
            // Send QR code string to Telegram status group
            this.sendStatusUpdate('WhatsApp QR Code (scan to authenticate):\n' + '```' + qr + '\n```');
        });

        this.client.on('ready', () => {
            logger.whatsapp('WhatsApp client is ready');
            this.isConnected = true;
            this.isAuthenticated = true;
            this.reconnectAttempts = 0;
            this.sendStatusUpdate('WhatsApp client connected and ready');
        });

        this.client.on('authenticated', () => {
            logger.whatsapp('WhatsApp client authenticated');
            this.isAuthenticated = true;
            this.sendStatusUpdate('WhatsApp client authenticated successfully');
        });

        this.client.on('auth_failure', (msg) => {
            logger.error('WhatsApp authentication failed', { message: msg });
            this.isAuthenticated = false;
            this.sendStatusUpdate(`WhatsApp authentication failed: ${msg}`);
        });

        // Connection events
        this.client.on('disconnected', (reason) => {
            logger.warn('WhatsApp client disconnected', { reason });
            this.isConnected = false;
            this.sendStatusUpdate(`WhatsApp client disconnected: ${reason}`);
            
            if (config.get('whatsapp.sessionManagement.autoReconnect')) {
                this.scheduleReconnect();
            }
        });

        this.client.on('loading_screen', (percent, message) => {
            logger.whatsapp('Loading screen', { percent, message });
        });

        // Message events
        this.client.on('message', async (message) => {
            await this.handleIncomingMessage(message);
        });

        this.client.on('message_create', async (message) => {
            // Handle messages sent by the user (if needed)
            if (message.fromMe) {
                logger.whatsapp('Message sent by user', { 
                    chatId: message.from, 
                    content: message.body.substring(0, 100) 
                });
            }
        });

        // Error handling
        this.client.on('error', (error) => {
            logger.error('WhatsApp client error', error);
            this.sendStatusUpdate(`WhatsApp client error: ${error.message}`);
        });
    }

    /**
     * Handle incoming WhatsApp messages
     * @param {Object} message - WhatsApp message object
     */
    async handleIncomingMessage(message) {
        try {
            // Skip system messages and messages from self
            if (message.isStatus || message.fromMe) {
                return;
            }

            // Get chat information
            const chat = await message.getChat();
            
            // Only process messages from monitored groups
            if (!chat.isGroup || !this.monitoredGroups.has(chat.name)) {
                return;
            }

            // Extract message data
            const messageData = {
                waMessageId: message.id._serialized,
                chatId: chat.id._serialized,
                chatName: chat.name,
                senderId: message.from,
                senderName: message._data.notifyName || message.author || 'Unknown',
                timestamp: moment(message.timestamp * 1000).format('YYYY-MM-DD HH:mm:ss'),
                content: message.body,
                isGroup: chat.isGroup
            };

            // Add to pending messages for batch processing
            this.pendingMessages.push(messageData);

            logger.whatsapp('Message received', {
                chatName: messageData.chatName,
                senderName: messageData.senderName,
                contentLength: messageData.content.length
            });

            // If batch processing is disabled, process immediately
            if (!config.get('whatsapp.batchProcessing.enabled')) {
                await this.processMessage(messageData);
            }

        } catch (error) {
            logger.error('Error handling incoming message', error);
        }
    }

    /**
     * Process a single message (store in database)
     * @param {Object} messageData - Message data object
     */
    async processMessage(messageData) {
        try {
            if (!databaseService.isReady()) {
                logger.warn('Database not ready, skipping message processing');
                return;
            }

            await databaseService.storeMessage(messageData);
            
            logger.whatsapp('Message processed successfully', {
                messageId: messageData.waMessageId,
                chatName: messageData.chatName
            });

        } catch (error) {
            logger.error('Error processing message', { messageData, error });
        }
    }

    /**
     * Start batch processing of messages
     */
    startBatchProcessing() {
        if (!config.get('whatsapp.batchProcessing.enabled')) {
            logger.whatsapp('Batch processing disabled');
            return;
        }

        const intervalMinutes = config.get('whatsapp.batchProcessing.intervalMinutes') || 5;
        const cronExpression = `*/${intervalMinutes} * * * *`;

        this.batchJob = cron.schedule(cronExpression, async () => {
            await this.processBatchMessages();
        }, {
            scheduled: false
        });

        this.batchJob.start();
        logger.whatsapp(`Batch processing started with ${intervalMinutes}-minute intervals`);
    }

    /**
     * Process all pending messages in batch
     */
    async processBatchMessages() {
        if (this.pendingMessages.length === 0) {
            return;
        }

        try {
            logger.whatsapp(`Processing batch of ${this.pendingMessages.length} messages`);

            const maxMessagesPerBatch = config.get('whatsapp.batchProcessing.maxMessagesPerBatch') || 100;
            const messagesToProcess = this.pendingMessages.splice(0, maxMessagesPerBatch);

            // Process messages in parallel with concurrency limit
            const concurrencyLimit = 10;
            for (let i = 0; i < messagesToProcess.length; i += concurrencyLimit) {
                const batch = messagesToProcess.slice(i, i + concurrencyLimit);
                await Promise.all(batch.map(message => this.processMessage(message)));
            }

            logger.whatsapp(`Batch processing completed: ${messagesToProcess.length} messages processed`);

        } catch (error) {
            logger.error('Error in batch processing', error);
        }
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            logger.error('Max reconnection attempts reached');
            this.sendStatusUpdate('Max reconnection attempts reached, manual intervention required');
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectInterval * this.reconnectAttempts;

        logger.whatsapp(`Scheduling reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay/1000}s`);

        setTimeout(async () => {
            try {
                await this.reconnect();
            } catch (error) {
                logger.error('Reconnection failed', error);
                this.scheduleReconnect();
            }
        }, delay);
    }

    /**
     * Attempt to reconnect to WhatsApp
     */
    async reconnect() {
        try {
            logger.whatsapp('Attempting to reconnect to WhatsApp');
            this.sendStatusUpdate('Attempting to reconnect to WhatsApp');

            if (this.client) {
                await this.client.destroy();
            }

            await this.initialize();
            await this.client.initialize();

        } catch (error) {
            logger.error('Reconnection failed', error);
            throw error;
        }
    }

    /**
     * Send status update to Telegram status group
     * @param {string} message - Status message
     */
    sendStatusUpdate(message) {
        if (this.statusCallback) {
            this.statusCallback(message);
        }
    }

    /**
     * Set status callback function
     * @param {Function} callback - Callback function for status updates
     */
    setStatusCallback(callback) {
        this.statusCallback = callback;
    }

    /**
     * Get current connection status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            isConnected: this.isConnected,
            isAuthenticated: this.isAuthenticated,
            reconnectAttempts: this.reconnectAttempts,
            pendingMessages: this.pendingMessages.length,
            monitoredGroups: Array.from(this.monitoredGroups)
        };
    }

    /**
     * Get monitored groups
     * @returns {Array} Array of group names
     */
    getMonitoredGroups() {
        return Array.from(this.monitoredGroups);
    }

    /**
     * Add a group to monitoring list
     * @param {string} groupName - Group name to monitor
     */
    addMonitoredGroup(groupName) {
        this.monitoredGroups.add(groupName);
        logger.whatsapp(`Added group to monitoring: ${groupName}`);
    }

    /**
     * Remove a group from monitoring list
     * @param {string} groupName - Group name to stop monitoring
     */
    removeMonitoredGroup(groupName) {
        this.monitoredGroups.delete(groupName);
        logger.whatsapp(`Removed group from monitoring: ${groupName}`);
    }

    /**
     * Initialize WhatsApp client
     */
    async start() {
        try {
            await this.client.initialize();
            logger.whatsapp('WhatsApp client started successfully');
        } catch (error) {
            logger.error('Error starting WhatsApp client', error);
            throw error;
        }
    }

    /**
     * Stop WhatsApp client
     */
    async stop() {
        try {
            if (this.batchJob) {
                this.batchJob.stop();
            }

            if (this.client) {
                await this.client.destroy();
            }

            this.isConnected = false;
            this.isAuthenticated = false;
            logger.whatsapp('WhatsApp client stopped');
        } catch (error) {
            logger.error('Error stopping WhatsApp client', error);
        }
    }

    /**
     * Check if WhatsApp service is ready
     * @returns {boolean} True if ready
     */
    isReady() {
        return this.isConnected && this.isAuthenticated;
    }
}

// Create singleton instance
const whatsappService = new WhatsAppService();

module.exports = whatsappService; 