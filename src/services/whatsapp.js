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
        this.monitoredGroups = new Set();
        this.groupsFilePath = './data/monitored-groups.json';
        this.batchJob = null;
        this.statusCallback = null;
        this.availableGroups = []; // Store groups retrieved in ready event
        
        // Safety measures to avoid WhatsApp bans
        this.lastActivityTime = Date.now();
        this.activityCount = 0;
        this.maxActivityPerHour = config.get('whatsapp.safety.maxActivityPerHour') || 100;
        this.minDelayBetweenActions = config.get('whatsapp.safety.minDelayBetweenActions') || 2000;
        this.randomDelayMax = config.get('whatsapp.safety.randomDelayMax') || 3000;
        this.enableHumanLikeBehavior = config.get('whatsapp.safety.enableHumanLikeBehavior') !== false;
        this.enableRateLimiting = config.get('whatsapp.safety.enableRateLimiting') !== false;
        
        // Load monitored groups from file
        this.loadMonitoredGroups();
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
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-features=TranslateUI',
                    '--disable-ipc-flooding-protection',
                    '--disable-default-apps',
                    '--disable-extensions',
                    '--disable-plugins',
                    '--disable-sync',
                    '--disable-translate',
                    '--hide-scrollbars',
                    '--mute-audio',
                    '--no-default-browser-check',
                    '--safebrowsing-disable-auto-update',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-background-networking',
                    '--disable-component-extensions-with-background-pages',
                    '--disable-domain-reliability',
                    '--disable-features=AudioServiceOutOfProcess',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    '--disable-sync-preferences',
                    '--disable-threaded-animation',
                    '--disable-threaded-scrolling',
                    '--disable-web-resources',
                    '--enable-automation',
                    '--force-color-profile=srgb',
                    '--metrics-recording-only',
                    '--no-crash-upload',
                    '--no-pings',
                    '--password-store=basic',
                    '--use-mock-keychain'
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

        this.client.on('ready', async () => {
            logger.whatsapp('WhatsApp client is ready');
            this.isConnected = true;
            this.isAuthenticated = true;
            this.reconnectAttempts = 0;
            this.sendStatusUpdate('WhatsApp client connected and ready');
            
            // Debug: Log ready state details
            logger.whatsapp('DEBUG: Ready state details', {
                isConnected: this.isConnected,
                isAuthenticated: this.isAuthenticated,
                hasClient: !!this.client,
                hasPupPage: !!(this.client && this.client.pupPage),
                isReady: this.isReady(),
                isReadyForChats: this.isReadyForChats()
            });
            
            // Debug: Log all chats the client has access to
            this.client.getChats().then(chats => {
                logger.whatsapp('DEBUG: Available chats', {
                    totalChats: chats.length,
                    groups: chats.filter(chat => chat.isGroup).map(chat => chat.name),
                    privateChats: chats.filter(chat => !chat.isGroup).length
                });
                
                // Store the groups for later use
                this.availableGroups = chats.filter(chat => chat.isGroup).map(chat => ({
                    id: chat.id._serialized || chat.id || 'unknown',
                    name: chat.name || 'Unknown Group',
                    participantsCount: chat.participantsCount || 0
                }));
                
                logger.whatsapp('Stored available groups', { 
                    totalGroups: this.availableGroups.length,
                    groupNames: this.availableGroups.map(g => g.name)
                });
            }).catch(error => {
                logger.error('Error getting chats', error);
            });

            // Wait for WhatsApp Web to be fully loaded before loading historical messages
            logger.whatsapp('Waiting for WhatsApp Web to be fully loaded...');
            this.sendStatusUpdate('⏳ Waiting for WhatsApp Web to be fully loaded...');
            
            // Wait 10 seconds to ensure WhatsApp Web is fully loaded
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            logger.whatsapp('WhatsApp Web should be fully loaded now');
            this.sendStatusUpdate('✅ WhatsApp Web fully loaded');

            // Historical message loading disabled - will be implemented better later
            // await this.loadHistoricalMessages();
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
            logger.whatsapp('DEBUG: message event triggered', {
                from: message.from,
                isGroup: message.from.includes('@g.us'),
                isFromMe: message.fromMe,
                isStatus: message.isStatus
            });
            await this.handleIncomingMessage(message);
        });

        this.client.on('message_create', async (message) => {
            logger.whatsapp('DEBUG: message_create event triggered', {
                from: message.from,
                isGroup: message.from.includes('@g.us'),
                isFromMe: message.fromMe,
                isStatus: message.isStatus
            });
            // Handle messages sent by the user (if needed)
            if (message.fromMe) {
                logger.whatsapp('Message sent by user', { 
                    chatId: message.from, 
                    content: message.body.substring(0, 100) 
                });
                // Also process user's own messages
                await this.handleIncomingMessage(message);
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
            // Skip system messages but allow user's own messages
            if (message.isStatus) {
                return;
            }

            // Get chat information
            const chat = await message.getChat();
            
            // Handle different ways to get chat ID
            let chatId;
            if (chat.id && chat.id._serialized) {
                chatId = chat.id._serialized;
            } else if (chat.id && typeof chat.id === 'string') {
                chatId = chat.id;
            } else if (chat._serialized) {
                chatId = chat._serialized;
            } else {
                chatId = chat.id || 'unknown';
            }

            // Handle different ways to get message ID
            let messageId;
            if (message.id && message.id._serialized) {
                messageId = message.id._serialized;
            } else if (message.id && typeof message.id === 'string') {
                messageId = message.id;
            } else if (message._serialized) {
                messageId = message._serialized;
            } else {
                messageId = message.id || 'unknown';
            }
            
            // Debug: Log all incoming messages with group ID mapping
            logger.whatsapp('DEBUG: Message received from chat', {
                chatId: chatId,
                chatName: chat.name,
                isGroup: chat.isGroup,
                isMonitored: this.monitoredGroups.has(chat.name),
                monitoredGroups: Array.from(this.monitoredGroups)
            });
            
            // Only process messages from monitored groups
            if (!chat.isGroup || !this.monitoredGroups.has(chat.name)) {
                return; // Silently ignore non-monitored groups
            }

            // Debug: Log only monitored group messages
            logger.whatsapp('DEBUG: Message received from monitored group', {
                chatName: chat.name,
                isFromMe: message.fromMe
            });

            // Extract message data
            const messageData = {
                waMessageId: messageId,
                chatId: chatId,
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
                contentLength: messageData.content.length,
                isFromMe: message.fromMe
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

            // Check if message already exists to prevent duplicates
            const existingMessage = await databaseService.getMessageByWhatsAppId(messageData.waMessageId);
            if (existingMessage) {
                logger.whatsapp('Message already exists, skipping', { 
                    messageId: messageData.waMessageId, 
                    chatName: messageData.chatName 
                });
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
        // Use the logger to send status updates, which will handle Telegram routing
        logger.whatsapp(`Status: ${message}`);
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
            isReady: this.isReady(),
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
     * Add a group to monitoring
     * @param {string} groupName - Name of the group to add
     * @returns {boolean} True if added successfully, false if already exists
     */
    addMonitoredGroup(groupName) {
        if (!this.monitoredGroups.has(groupName)) {
            this.monitoredGroups.add(groupName);
            this.saveMonitoredGroups();
            logger.whatsapp('Group added to monitoring', { groupName });
            this.sendStatusUpdate(`✅ Added group to monitoring: ${groupName}`);
            return true;
        } else {
            logger.whatsapp('Group already in monitoring', { groupName });
            return false;
        }
    }

    /**
     * Remove a group from monitoring
     * @param {string} groupName - Name of the group to remove
     * @returns {boolean} True if removed successfully, false if not found
     */
    removeMonitoredGroup(groupName) {
        if (this.monitoredGroups.has(groupName)) {
            this.monitoredGroups.delete(groupName);
            this.saveMonitoredGroups();
            logger.whatsapp('Group removed from monitoring', { groupName });
            this.sendStatusUpdate(`❌ Removed group from monitoring: ${groupName}`);
            return true;
        } else {
            logger.whatsapp('Group not found in monitoring', { groupName });
            return false;
        }
    }

    /**
     * Save monitored groups to file
     */
    saveMonitoredGroups() {
        try {
            const fs = require('fs');
            const path = require('path');
            
            // Ensure data directory exists
            const dataDir = path.dirname(this.groupsFilePath);
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            // Save groups as array of objects with metadata
            const groupsData = Array.from(this.monitoredGroups).map(groupName => ({
                name: groupName,
                addedAt: new Date().toISOString()
            }));
            
            fs.writeFileSync(this.groupsFilePath, JSON.stringify(groupsData, null, 2));
            
            logger.whatsapp('Monitored groups saved to file', { 
                totalGroups: this.monitoredGroups.size,
                groupNames: Array.from(this.monitoredGroups),
                filePath: this.groupsFilePath
            });
        } catch (error) {
            logger.error('Error saving monitored groups to file', error);
        }
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
        return this.isConnected && this.isAuthenticated && this.client && this.client.pupPage;
    }

    /**
     * Check if WhatsApp client is ready to get chats
     * @returns {boolean} True if ready to get chats
     */
    isReadyForChats() {
        return this.isConnected && this.isAuthenticated && this.client && this.client.pupPage && this.client.pupPage.url().includes('web.whatsapp.com');
    }

    /**
     * Get all available groups from WhatsApp
     * @returns {Promise<Array>} Array of group objects
     */
    async getAllGroups() {
        try {
            // Safety check before making API calls
            await this.safetyCheck();
            
            if (!this.isReadyForChats()) {
                logger.warn('WhatsApp client not ready for getting groups');
                return [];
            }

            // Return the groups that were successfully retrieved in the ready event
            if (this.availableGroups.length > 0) {
                logger.whatsapp('Returning stored groups', { 
                    totalGroups: this.availableGroups.length,
                    groupNames: this.availableGroups.map(g => g.name)
                });
                return this.availableGroups;
            }

            // Fallback: try to get groups directly
            logger.whatsapp('No stored groups, trying to get groups directly');
            const chats = await this.client.getChats();
            const groups = chats.filter(chat => chat.isGroup);
            
            logger.whatsapp('Retrieved groups directly', { 
                totalGroups: groups.length,
                groupNames: groups.map(g => g.name)
            });
            
            return groups;
        } catch (error) {
            logger.error('Error getting all groups', { error: error.message });
            return [];
        }
    }

    /**
     * Get all groups with their last message information, ordered by most recent
     * @returns {Promise<Array>} Array of groups with last message info
     */
    async getAllGroupsWithLastMessage() {
        // This method is removed as per the instructions
        logger.whatsapp('getAllGroupsWithLastMessage method is removed');
        return [];
    }

    /**
     * Load historical messages from monitored groups
     */
    async loadHistoricalMessages() {
        // Historical message loading disabled - will be implemented better later
        logger.whatsapp('Historical message loading is disabled');
        return;
    }

    /**
     * Safety check to prevent too many API calls
     * @returns {boolean} True if safe to proceed
     */
    async safetyCheck() {
        if (!this.enableRateLimiting && !this.enableHumanLikeBehavior) {
            return true; // Skip safety checks if disabled
        }

        const now = Date.now();
        const timeSinceLastActivity = now - this.lastActivityTime;
        
        // Reset activity count if more than an hour has passed
        if (timeSinceLastActivity > 3600000) { // 1 hour
            this.activityCount = 0;
        }
        
        // Check if we're within rate limits
        if (this.enableRateLimiting && this.activityCount >= this.maxActivityPerHour) {
            logger.whatsapp('Rate limit reached, waiting before next action');
            await this.delay(30000); // Wait 30 seconds
            this.activityCount = 0;
        }
        
        // Ensure minimum delay between actions
        if (this.enableRateLimiting && timeSinceLastActivity < this.minDelayBetweenActions) {
            const waitTime = this.minDelayBetweenActions - timeSinceLastActivity;
            await this.delay(waitTime);
        }
        
        // Add random delay to make behavior more human-like
        if (this.enableHumanLikeBehavior) {
            const randomDelay = Math.random() * this.randomDelayMax;
            await this.delay(randomDelay);
        }
        
        this.lastActivityTime = Date.now();
        this.activityCount++;
        
        return true;
    }

    /**
     * Add a delay with random variation
     * @param {number} ms - Base delay in milliseconds
     */
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Load monitored groups from file
     */
    loadMonitoredGroups() {
        try {
            const fs = require('fs');
            if (fs.existsSync(this.groupsFilePath)) {
                const groupsData = JSON.parse(fs.readFileSync(this.groupsFilePath, 'utf-8'));
                groupsData.forEach(group => {
                    if (group.name) {
                        this.monitoredGroups.add(group.name);
                    }
                });
                logger.whatsapp('Monitored groups loaded from file', { 
                    totalGroups: this.monitoredGroups.size,
                    groupNames: Array.from(this.monitoredGroups)
                });
            } else {
                logger.whatsapp('No monitored groups file found, starting with empty list');
            }
        } catch (error) {
            logger.error('Error loading monitored groups from file', error);
        }
    }
}

// Create singleton instance
const whatsappService = new WhatsAppService();

module.exports = whatsappService; 