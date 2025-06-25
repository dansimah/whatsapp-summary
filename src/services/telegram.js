/**
 * Telegram Bot Service for WhatsApp to Telegram Bot
 * 
 * This module handles all Telegram bot interactions including user commands,
 * inline button navigation, user authentication, and integration with other
 * services for message processing and summarization.
 * 
 * Features:
 * - User authentication (only allows 'dansi' username)
 * - Inline button navigation for group and date selection
 * - Message summarization and homework extraction
 * - Status reporting to designated group
 * - Error handling and user feedback
 * - Integration with database and Gemini AI services
 */

const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment');
const config = require('../config');
const logger = require('../utils/logger');
const databaseService = require('./database');
const geminiService = require('./gemini');

class TelegramService {
    constructor() {
        this.bot = null;
        this.isInitialized = false;
        this.allowedUsername = config.get('telegram.allowedUsername') || 'dansi';
        this.statusGroupId = config.get('telegram.statusGroupId');
        this.userStates = new Map(); // Track user interaction states
        this.maxGroupsPerPage = config.get('telegram.inlineButtons.maxGroupsPerPage') || 5;
        this.maxDatesPerPage = config.get('telegram.inlineButtons.maxDatesPerPage') || 7;
        this.userGroupMapping = {}; // Store group mapping for this user's session
        this.userPaginationState = {}; // Store pagination state for each user
        this.userMessageIds = {}; // Store message IDs for each user
    }

    /**
     * Initialize Telegram bot
     */
    async initialize() {
        try {
            logger.telegram('Initializing Telegram bot service');

            const botToken = config.get('telegram.botToken');
            if (!botToken) {
                throw new Error('Telegram bot token not configured');
            }

            this.bot = new TelegramBot(botToken, { polling: true });

            // Set up event handlers
            this.setupEventHandlers();

            this.isInitialized = true;
            logger.telegram('Telegram bot service initialized successfully');
        } catch (error) {
            logger.error('Telegram bot service initialization failed', error);
            throw error;
        }
    }

    /**
     * Set up Telegram bot event handlers
     */
    setupEventHandlers() {
        // Handle /start command
        this.bot.onText(/\/start/, async (msg) => {
            await this.handleStartCommand(msg);
        });

        // Handle /summarize command
        this.bot.onText(/\/summarize/, async (msg) => {
            await this.handleSummarizeCommand(msg);
        });

        // Handle /groups command
        this.bot.onText(/\/groups/, async (msg) => {
            await this.handleGroupsCommand(msg);
        });

        // Handle /status command
        this.bot.onText(/\/status/, async (msg) => {
            await this.handleStatusCommand(msg);
        });

        // Handle callback queries (inline button clicks)
        this.bot.on('callback_query', async (query) => {
            await this.handleCallbackQuery(query);
        });

        // Handle text messages
        this.bot.on('message', async (msg) => {
            await this.handleTextMessage(msg);
        });

        // Handle errors
        this.bot.on('error', (error) => {
            logger.error('Telegram bot error', error);
        });

        // Handle polling errors
        this.bot.on('polling_error', (error) => {
            logger.error('Telegram bot polling error', error);
        });
    }

    /**
     * Handle /start command
     * @param {Object} msg - Telegram message object
     */
    async handleStartCommand(msg) {
        const chatId = msg.chat.id;
        const username = msg.from.username;

        if (!this.isUserAllowed(username)) {
            await this.sendUnauthorizedMessage(chatId);
            return;
        }

        const welcomeMessage = `🤖 *Welcome to WhatsApp Summary Bot!*\n\n` +
            `I can help you summarize WhatsApp group messages using AI.\n\n` +
            `*Available Commands:*\n` +
            `📋 /summarize - Generate summaries for WhatsApp groups\n` +
            `📱 /groups - Manage monitored groups\n` +
            `ℹ️ /status - Check bot status\n\n` +
            `*How to use:*\n` +
            `1. Use /summarize to select a group and date\n` +
            `2. Use /groups to add/remove groups from monitoring\n` +
            `3. I'll automatically capture messages from monitored groups\n` +
            `4. Generate AI-powered summaries on demand`;

        await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
        logger.telegram('Start command handled', { userId: msg.from.id, username });

        // Log interaction to status group if enabled
        if (config.get('telegram.logAllInteractions')) {
            await this.sendStatusUpdate(`🚀 User @${username} started the bot`);
        }
    }

    /**
     * Handle /summarize command
     * @param {Object} msg - Telegram message object
     */
    async handleSummarizeCommand(msg) {
        try {
            if (!this.isUserAllowed(msg.from.username)) {
                await this.sendUnauthorizedMessage(msg.chat.id);
                return;
            }

            // Get available groups
            const groups = await this.getAvailableGroups();
            
            if (groups.length === 0) {
                await this.bot.sendMessage(msg.chat.id, '❌ No WhatsApp groups are currently being monitored.');
                return;
            }

            // Create inline keyboard for group selection
            const keyboard = this.createGroupSelectionKeyboard(groups, 0);
            
            const message = '📱 *Select a WhatsApp group to summarize:*';
            await this.bot.sendMessage(msg.chat.id, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });

            logger.telegram('Summarize command handled', { userId: msg.from.id, username: msg.from.username });

            // Log interaction to status group if enabled
            if (config.get('telegram.logAllInteractions')) {
                await this.sendStatusUpdate(`📊 User @${msg.from.username} (ID: ${msg.from.id}) requested summary - showing group selection`);
            }

        } catch (error) {
            logger.error('Error handling summarize command', error);
            await this.sendErrorMessage(msg.chat.id);
        }
    }

    /**
     * Handle /status command
     * @param {Object} msg - Telegram message object
     */
    async handleStatusCommand(msg) {
        const chatId = msg.chat.id;
        const username = msg.from.username;

        if (!this.isUserAllowed(username)) {
            await this.sendUnauthorizedMessage(chatId);
            return;
        }

        try {
            // Import services dynamically
            const whatsappService = require('./whatsapp');
            const geminiService = require('./gemini');
            const databaseService = require('./database');

            // Get status from all services
            const whatsappStatus = whatsappService.getStatus();
            const geminiStatus = geminiService.getStatus();
            const telegramStatus = this.getStatus();
            const databaseStatus = databaseService.isReady();

            // Get monitored groups
            const monitoredGroups = config.get('whatsapp.groups') || [];
            const allGroups = await this.getAllWhatsAppGroups();

            const statusMessage = `🤖 *Bot Status Report*\n\n` +
                `*WhatsApp Service:*\n` +
                `• Connected: ${whatsappStatus.isConnected ? '✅' : '❌'}\n` +
                `• Authenticated: ${whatsappStatus.isAuthenticated ? '✅' : '❌'}\n` +
                `• Ready: ${whatsappStatus.isReady ? '✅' : '❌'}\n\n` +
                `*Telegram Service:*\n` +
                `• Initialized: ${telegramStatus.isInitialized ? '✅' : '❌'}\n` +
                `• Active Users: ${telegramStatus.activeUsers}\n\n` +
                `*AI Service:*\n` +
                `• Gemini Ready: ${geminiStatus.isInitialized ? '✅' : '❌'}\n` +
                `• Model: ${geminiStatus.model}\n\n` +
                `*Database:*\n` +
                `• Ready: ${databaseStatus ? '✅' : '❌'}\n\n` +
                `*Group Monitoring:*\n` +
                `• Monitored: ${monitoredGroups.length}\n` +
                `• Total Available: ${allGroups.length}\n` +
                `• Coverage: ${allGroups.length > 0 ? ((monitoredGroups.length / allGroups.length) * 100).toFixed(1) : 0}%\n\n` +
                `*Monitored Groups:*\n` +
                monitoredGroups.map(group => `• ${group}`).join('\n') +
                `\n\n*Last Updated:* ${new Date().toLocaleString()}`;

            await this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
            logger.telegram('Status command handled', { userId: msg.from.id, username });

            // Log interaction to status group if enabled
            if (config.get('telegram.logAllInteractions')) {
                await this.sendStatusUpdate(`ℹ️ User @${username} checked bot status`);
            }

        } catch (error) {
            logger.error('Error handling status command', error);
            await this.bot.sendMessage(chatId, 
                '❌ *Error getting status*\n\nPlease try again later.',
                { parse_mode: 'Markdown' }
            );
        }
    }

    /**
     * Handle groups command
     */
    async handleGroupsCommand(msg) {
        try {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const username = msg.from.username;

            // Check if user is authorized
            if (!this.isUserAllowed(username)) {
                await this.sendUnauthorizedMessage(chatId);
                return;
            }

            // Get all WhatsApp groups
            const allGroups = await this.getAllWhatsAppGroups();
            if (allGroups.length === 0) {
                await this.bot.sendMessage(chatId, '❌ No WhatsApp groups found or WhatsApp service not ready.');
                return;
            }

            // Get monitored groups
            const whatsappService = require('./whatsapp');
            const monitoredGroups = whatsappService.getMonitoredGroups();

            // Calculate pagination
            const totalPages = Math.ceil(allGroups.length / 20);
            const currentPage = 0;

            // Store pagination state
            this.userPaginationState[userId] = {
                allGroups,
                monitoredGroups,
                totalPages,
                currentPage
            };

            // Send first page
            await this.sendGroupsPage(chatId, userId, currentPage);

            logger.telegram('Groups command handled', { userId, username, totalGroups: allGroups.length });
        } catch (error) {
            logger.error('Error handling groups command', error);
            await this.bot.sendMessage(chatId, '❌ Error loading groups. Please try again.');
        }
    }

    /**
     * Send groups page with inline keyboard
     */
    async sendGroupsPage(chatId, userId, page, messageId = null) {
        const state = this.userPaginationState[userId];
        if (!state) {
            await this.bot.sendMessage(chatId, '❌ Session expired. Please use /groups again.');
            return;
        }

        const { allGroups, monitoredGroups, totalPages } = state;
        const groupsPerPage = 20;
        const startIndex = page * groupsPerPage;
        const endIndex = Math.min(startIndex + groupsPerPage, allGroups.length);
        const pageGroups = allGroups.slice(startIndex, endIndex);

        // Create message text
        let messageText = `📋 *WhatsApp Groups Management*\n\n`;
        messageText += `*Page ${page + 1} of ${totalPages}*\n`;
        messageText += `*Total Groups:* ${allGroups.length}\n`;
        messageText += `*Monitored Groups:* ${monitoredGroups.length}\n\n`;

        // Add groups for this page
        pageGroups.forEach((group, index) => {
            const isMonitored = monitoredGroups.includes(group.name);
            const status = isMonitored ? '✅' : '❌';
            const displayName = group.name.length > 40 ? group.name.substring(0, 37) + '...' : group.name;
            
            // Escape special characters for Markdown
            const escapedName = displayName
                .replace(/\*/g, '\\*')
                .replace(/_/g, '\\_')
                .replace(/`/g, '\\`')
                .replace(/\[/g, '\\[')
                .replace(/\]/g, '\\]')
                .replace(/\(/g, '\\(')
                .replace(/\)/g, '\\)')
                .replace(/~/g, '\\~')
                .replace(/>/g, '\\>')
                .replace(/#/g, '\\#')
                .replace(/\+/g, '\\+')
                .replace(/-/g, '\\-')
                .replace(/=/g, '\\=')
                .replace(/\|/g, '\\|')
                .replace(/\{/g, '\\{')
                .replace(/\}/g, '\\}')
                .replace(/\./g, '\\.')
                .replace(/!/g, '\\!');
            
            // Calculate global index (across all pages)
            const globalIndex = startIndex + index + 1;
            
            messageText += `${globalIndex}\\. ${status} ${escapedName}\n`;
        });

        // Add group toggle buttons (max 4 per row to avoid button size issues)
        const groupButtons = [];
        let currentRow = [];
        
        pageGroups.forEach((group, index) => {
            const isMonitored = monitoredGroups.includes(group.name);
            const action = isMonitored ? 'remove' : 'add';
            const buttonText = isMonitored ? '❌' : '✅';
            
            // Calculate global index (same as in the list above)
            const globalIndex = startIndex + index + 1;
            
            // Store group mapping for this user's session using global index
            if (!this.userGroupMapping[userId]) {
                this.userGroupMapping[userId] = {};
            }
            this.userGroupMapping[userId][globalIndex] = group.name;
            
            currentRow.push({
                text: `${buttonText} Group ${globalIndex}`,
                callback_data: `group_${action}_${globalIndex}`
            });

            // Create new row every 4 buttons
            if (currentRow.length === 4) {
                groupButtons.push(currentRow);
                currentRow = [];
            }
        });
        
        // Add remaining buttons in the last row
        if (currentRow.length > 0) {
            groupButtons.push(currentRow);
        }

        // Add navigation buttons
        const navigationRow = [];
        
        if (page > 0) {
            navigationRow.push({
                text: '⬅️ Previous',
                callback_data: `groups_page_${page - 1}`
            });
        }
        
        if (page < totalPages - 1) {
            navigationRow.push({
                text: 'Next ➡️',
                callback_data: `groups_page_${page + 1}`
            });
        }
        
        if (navigationRow.length > 0) {
            groupButtons.push(navigationRow);
        }

        // Add status and refresh buttons
        groupButtons.push([
            {
                text: '📊 Status',
                callback_data: 'groups_status'
            },
            {
                text: '🔄 Refresh',
                callback_data: 'groups_refresh'
            }
        ]);

        const keyboard = {
            inline_keyboard: groupButtons
        };

        try {
            if (messageId) {
                // Update existing message
                await this.bot.editMessageText(messageText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard
                });
            } else {
                // Send new message
                const sentMessage = await this.bot.sendMessage(chatId, messageText, {
                    parse_mode: 'MarkdownV2',
                    reply_markup: keyboard
                });
                
                // Store the message ID for future updates
                if (!this.userMessageIds) {
                    this.userMessageIds = {};
                }
                this.userMessageIds[userId] = sentMessage.message_id;
            }
        } catch (error) {
            logger.error('Error sending/updating groups page', { error: error.message });
            await this.bot.sendMessage(chatId, '❌ Error displaying groups. Please try again.');
        }
    }

    /**
     * Handle callback queries
     * @param {Object} query - Callback query object
     */
    async handleCallbackQuery(query) {
        try {
            const chatId = query.message.chat.id;
            const userId = query.from.id;
            const username = query.from.username;
            const data = query.data;

            // Check if user is authorized
            if (!this.isUserAllowed(username)) {
                logger.telegram('Unauthorized callback attempt', { userId, username, data });
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
                return;
            }

            // Handle different callback types
            if (data.startsWith('group_add_')) {
                await this.handleGroupAdd(query, data);
            } else if (data.startsWith('group_remove_')) {
                await this.handleGroupRemove(query, data);
            } else if (data.startsWith('groups_page_')) {
                await this.handleGroupsPageNavigation(query, data);
            } else if (data === 'groups_refresh') {
                await this.handleGroupsRefresh(query);
            } else if (data === 'groups_status') {
                await this.handleGroupsStatus(query);
            } else if (data === 'groups_close') {
                await this.handleGroupsClose(query);
            } else if (data.startsWith('group_')) {
                await this.handleGroupSelection(query, data);
            } else if (data.startsWith('date_')) {
                await this.handleDateSelection(query, data);
            } else if (data.startsWith('page_groups_')) {
                // Handle group pagination for summarize workflow
                await this.handleGroupPagination(query, data);
            } else if (data === 'cancel') {
                // Handle cancel action
                await this.handleCancel(query);
            } else {
                logger.telegram('Unknown callback data', { data, userId, username });
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Unknown action' });
            }

        } catch (error) {
            logger.error('Error handling callback query', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error occurred' });
        }
    }

    /**
     * Handle adding a group to monitoring
     */
    async handleGroupAdd(query, data) {
        try {
            const userId = query.from.id;
            const chatId = query.message.chat.id;
            const globalIndex = data.replace('group_add_', '');
            const groupName = this.userGroupMapping[userId]?.[globalIndex];
            
            if (!groupName) {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Group not found' });
                return;
            }

            // Add to monitored groups
            const whatsappService = require('./whatsapp');
            const success = await whatsappService.addMonitoredGroup(groupName);
            
            if (success) {
                await this.bot.answerCallbackQuery(query.id, { text: `✅ Added "${groupName}" to monitoring` });
                logger.telegram('Group added to monitoring', { userId, groupName });
                
                // Refresh the current page to show updated status
                await this.refreshCurrentPage(chatId, userId);
            } else {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Failed to add group' });
            }
        } catch (error) {
            logger.error('Error adding group', { error: error.message });
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error adding group' });
        }
    }

    /**
     * Handle removing a group from monitoring
     */
    async handleGroupRemove(query, data) {
        try {
            const userId = query.from.id;
            const chatId = query.message.chat.id;
            const globalIndex = data.replace('group_remove_', '');
            const groupName = this.userGroupMapping[userId]?.[globalIndex];
            
            if (!groupName) {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Group not found' });
                return;
            }

            // Remove from monitored groups
            const whatsappService = require('./whatsapp');
            const success = await whatsappService.removeMonitoredGroup(groupName);
            
            if (success) {
                await this.bot.answerCallbackQuery(query.id, { text: `❌ Removed "${groupName}" from monitoring` });
                logger.telegram('Group removed from monitoring', { userId, groupName });
                
                // Refresh the current page to show updated status
                await this.refreshCurrentPage(chatId, userId);
            } else {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Failed to remove group' });
            }
        } catch (error) {
            logger.error('Error removing group', { error: error.message });
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error removing group' });
        }
    }

    /**
     * Handle groups page navigation
     */
    async handleGroupsPageNavigation(query, data) {
        try {
            const userId = query.from.id;
            const chatId = query.message.chat.id;
            const page = parseInt(data.replace('groups_page_', ''));
            
            const state = this.userPaginationState[userId];
            if (!state) {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Session expired' });
                return;
            }

            if (page >= 0 && page < state.totalPages) {
                // Update the existing message instead of sending a new one
                const messageId = this.userMessageIds?.[userId];
                await this.sendGroupsPage(chatId, userId, page, messageId);
                await this.bot.answerCallbackQuery(query.id);
            } else {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ Invalid page' });
            }
        } catch (error) {
            logger.error('Error handling groups page navigation', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error occurred' });
        }
    }

    /**
     * Handle groups refresh
     */
    async handleGroupsRefresh(query) {
        try {
            const userId = query.from.id;
            const chatId = query.message.chat.id;
            
            // Get fresh data
            const allGroups = await this.getAllWhatsAppGroups();
            const whatsappService = require('./whatsapp');
            const monitoredGroups = whatsappService.getMonitoredGroups();
            
            // Update pagination state
            const totalPages = Math.ceil(allGroups.length / 20);
            const currentPage = 0; // Always go to first page on refresh
            
            this.userPaginationState[userId] = {
                allGroups,
                monitoredGroups,
                totalPages,
                currentPage
            };

            // Update the message with fresh data
            const messageId = this.userMessageIds?.[userId];
            await this.sendGroupsPage(chatId, userId, currentPage, messageId);
            
            await this.bot.answerCallbackQuery(query.id, { text: '🔄 Groups refreshed' });
            logger.telegram('Groups refreshed', { userId });
        } catch (error) {
            logger.error('Error refreshing groups', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error refreshing groups' });
        }
    }

    /**
     * Handle groups status
     */
    async handleGroupsStatus(query) {
        const state = this.userPaginationState[query.from.id];
        if (!state) {
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Session expired' });
            return;
        }

        const { allGroups, monitoredGroups } = state;
        const coverage = ((monitoredGroups.length / allGroups.length) * 100).toFixed(1);
        
        // Escape group names for Markdown
        const escapedGroups = monitoredGroups.map(group => {
            return group
                .replace(/\*/g, '\\*')
                .replace(/_/g, '\\_')
                .replace(/`/g, '\\`')
                .replace(/\[/g, '\\[')
                .replace(/\]/g, '\\]')
                .replace(/\(/g, '\\(')
                .replace(/\)/g, '\\)')
                .replace(/~/g, '\\~')
                .replace(/>/g, '\\>')
                .replace(/#/g, '\\#')
                .replace(/\+/g, '\\+')
                .replace(/-/g, '\\-')
                .replace(/=/g, '\\=')
                .replace(/\|/g, '\\|')
                .replace(/\{/g, '\\{')
                .replace(/\}/g, '\\}')
                .replace(/\./g, '\\.')
                .replace(/!/g, '\\!');
        });
        
        const statusMessage = `📊 *Group Monitoring Status*\n\n` +
            `*Monitored Groups:* ${monitoredGroups.length}\n` +
            `*Total Groups:* ${allGroups.length}\n` +
            `*Monitoring Coverage:* ${coverage}%\n\n` +
            `*Currently Monitored:*\n` +
            escapedGroups.map(group => `• ${group}`).join('\n');

        await this.bot.editMessageText(statusMessage, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
        
        await this.bot.answerCallbackQuery(query.id);
    }

    /**
     * Handle groups close
     */
    async handleGroupsClose(query) {
        const userId = query.from.id;
        
        // Clean up pagination state
        if (this.userPaginationState[userId]) {
            delete this.userPaginationState[userId];
        }

        await this.bot.editMessageText('❌ Group management closed', {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
        });
        
        await this.bot.answerCallbackQuery(query.id);
    }

    /**
     * Handle text messages
     * @param {Object} msg - Telegram message object
     */
    async handleTextMessage(msg) {
        // Only respond to commands, ignore other text messages
        if (!msg.text.startsWith('/')) {
            return;
        }
    }

    /**
     * Check if user is allowed to use the bot
     * @param {string} username - Telegram username
     * @returns {boolean} True if allowed
     */
    isUserAllowed(username) {
        return username === this.allowedUsername;
    }

    /**
     * Send unauthorized access message
     * @param {number} chatId - Telegram chat ID
     */
    async sendUnauthorizedMessage(chatId) {
        const message = '❌ *Unauthorized Access*\n\nThis bot is only available to authorized users.';
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        logger.telegram('Unauthorized access attempt', { chatId });

        // Log unauthorized access to status group if enabled
        if (config.get('telegram.logAllInteractions')) {
            await this.sendStatusUpdate(`🚫 Unauthorized access attempt from chat ID: ${chatId}`);
        }
    }

    /**
     * Send error message
     * @param {number} chatId - Telegram chat ID
     */
    async sendErrorMessage(chatId) {
        const message = '❌ *Error*\n\nAn error occurred. Please try again later.';
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    /**
     * Get available groups from configuration
     * @returns {Array} Array of group names
     */
    async getAvailableGroups() {
        try {
            // Get monitored groups from WhatsApp service
            const whatsappService = require('./whatsapp');
            const monitoredGroups = whatsappService.getMonitoredGroups();
            
            // Return the monitored groups as an array of group names
            return monitoredGroups;
        } catch (error) {
            logger.error('Error getting available groups', error);
            return [];
        }
    }

    /**
     * Create inline keyboard for group selection
     * @param {Array} groups - Array of group names
     * @param {number} page - Current page number
     * @returns {Array} Inline keyboard array
     */
    createGroupSelectionKeyboard(groups, page = 0) {
        const startIndex = page * this.maxGroupsPerPage;
        const endIndex = startIndex + this.maxGroupsPerPage;
        const pageGroups = groups.slice(startIndex, endIndex);

        const keyboard = pageGroups.map(group => [{
            text: group,
            callback_data: `group_${group}`
        }]);

        // Add navigation buttons
        const navigationRow = [];
        
        if (page > 0) {
            navigationRow.push({
                text: '⬅️ Previous',
                callback_data: `page_groups_${page - 1}`
            });
        }
        
        if (endIndex < groups.length) {
            navigationRow.push({
                text: 'Next ➡️',
                callback_data: `page_groups_${page + 1}`
            });
        }

        if (navigationRow.length > 0) {
            keyboard.push(navigationRow);
        }

        // Add cancel button
        keyboard.push([{
            text: '❌ Cancel',
            callback_data: 'cancel'
        }]);

        return keyboard;
    }

    /**
     * Create inline keyboard for date selection
     * @returns {Array} Inline keyboard array
     */
    createDateSelectionKeyboard() {
        const keyboard = [];
        const today = moment();
        
        // Create date options for the last 7 days
        for (let i = 0; i < this.maxDatesPerPage; i++) {
            const date = today.clone().subtract(i, 'days');
            const dateStr = date.format('YYYY-MM-DD');
            const displayStr = date.format('MMM DD');
            
            keyboard.push([{
                text: displayStr,
                callback_data: `date_${dateStr}`
            }]);
        }

        // Add cancel button
        keyboard.push([{
            text: '❌ Cancel',
            callback_data: 'cancel'
        }]);

        return keyboard;
    }

    /**
     * Format summary message for Telegram
     * @param {string} groupName - Group name
     * @param {string} date - Date
     * @param {string} summary - Summary text
     * @param {number} messageCount - Number of messages
     * @returns {string} Formatted message
     */
    formatSummaryMessage(groupName, date, summary, messageCount) {
        const formattedDate = moment(date).format('MMM DD, YYYY');
        
        return `📋 *Summary for ${groupName}*\n📅 *Date:* ${formattedDate}\n📊 *Messages:* ${messageCount}\n\n${summary}`;
    }

    /**
     * Send status update to status group
     * @param {string} message - Status message
     */
    async sendStatusUpdate(message) {
        try {
            if (!this.statusGroupId) {
                logger.warn('Status group ID not configured');
                return;
            }

            const timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
            
            // Only escape essential Markdown formatting characters that could break the message
            // Don't escape parentheses as they're commonly used in status messages
            const escapedMessage = message
                .replace(/\*/g, '\\*')  // Escape asterisks for bold
                .replace(/_/g, '\\_')   // Escape underscores for italic
                .replace(/`/g, '\\`');  // Escape backticks for code
            
            const statusMessage = `🤖 *Bot Status Update*\n⏰ ${timestamp}\n\n${escapedMessage}`;
            
            await this.bot.sendMessage(this.statusGroupId, statusMessage, { parse_mode: 'Markdown' });
            logger.telegram('Status update sent', { message });
        } catch (error) {
            logger.error('Error sending status update', error);
        }
    }

    /**
     * Get bot status
     * @returns {Object} Status object
     */
    getStatus() {
        return {
            isInitialized: this.isInitialized,
            allowedUsername: this.allowedUsername,
            statusGroupId: this.statusGroupId,
            activeUsers: this.userStates.size
        };
    }

    /**
     * Stop the bot
     */
    async stop() {
        try {
            if (this.bot) {
                await this.bot.stopPolling();
            }
            this.isInitialized = false;
            logger.telegram('Telegram bot stopped');
        } catch (error) {
            logger.error('Error stopping Telegram bot', error);
        }
    }

    /**
     * Check if service is ready
     * @returns {boolean} True if ready
     */
    isReady() {
        return this.isInitialized && this.bot;
    }

    /**
     * Detect languages in messages for debugging
     * @param {Array} messages - Array of message objects
     * @returns {Object} Language detection results
     */
    detectLanguages(messages) {
        const hebrewPattern = /[\u0590-\u05FF]/; // Hebrew Unicode range
        const frenchPattern = /[àâäéèêëïîôöùûüÿç]/i; // French accented characters
        const arabicPattern = /[\u0600-\u06FF]/; // Arabic Unicode range
        
        let hebrewCount = 0;
        let frenchCount = 0;
        let arabicCount = 0;
        let englishCount = 0;
        let otherCount = 0;
        
        messages.forEach(msg => {
            const content = msg.content || '';
            if (hebrewPattern.test(content)) {
                hebrewCount++;
            } else if (frenchPattern.test(content)) {
                frenchCount++;
            } else if (arabicPattern.test(content)) {
                arabicCount++;
            } else if (/^[a-zA-Z\s.,!?]+$/.test(content)) {
                englishCount++;
            } else {
                otherCount++;
            }
        });
        
        return {
            hebrew: hebrewCount,
            french: frenchCount,
            arabic: arabicCount,
            english: englishCount,
            other: otherCount,
            total: messages.length
        };
    }

    /**
     * Get all WhatsApp groups
     * @returns {Promise<Array>} Array of group objects
     */
    async getAllWhatsAppGroups() {
        try {
            const whatsappService = require('./whatsapp');
            
            if (!whatsappService.isReady()) {
                logger.warn('WhatsApp service not ready');
                return [];
            }

            // Get basic groups without last message info
            const groups = await whatsappService.getAllGroups();
            
            logger.telegram('Retrieved all WhatsApp groups', { 
                totalGroups: groups.length
            });
            
            return groups;
        } catch (error) {
            logger.error('Error getting WhatsApp groups', { error: error.message });
            return [];
        }
    }

    /**
     * Create inline keyboard for group management
     * @param {Array} allGroups - All available groups
     * @param {Array} monitoredGroups - Currently monitored groups
     * @returns {Array} Inline keyboard array
     */
    createGroupManagementKeyboard(allGroups, monitoredGroups) {
        const keyboard = [];
        
        allGroups.forEach(group => {
            const isMonitored = monitoredGroups.includes(group.name);
            const statusIcon = isMonitored ? '✅' : '❌';
            const action = isMonitored ? 'remove' : 'add';
            
            keyboard.push([{
                text: `${statusIcon} ${group.name} (${group.participantsCount} members)`,
                callback_data: `group_manage_${action}_${group.name}`
            }]);
        });

        // Add navigation and action buttons
        keyboard.push([
            {
                text: '🔄 Refresh',
                callback_data: 'groups_refresh'
            },
            {
                text: '📊 Status',
                callback_data: 'groups_status'
            }
        ]);

        keyboard.push([
            {
                text: '❌ Close',
                callback_data: 'groups_close'
            }
        ]);

        return keyboard;
    }

    /**
     * Handle group management actions (add/remove groups)
     * @param {Object} query - Telegram callback query object
     * @param {string} data - Callback data
     */
    async handleGroupManagement(query, data) {
        const chatId = query.message.chat.id;
        const parts = data.split('_');
        const action = parts[2]; // 'add' or 'remove'
        const groupName = parts.slice(3).join('_'); // Reconstruct group name with underscores

        try {
            // Import WhatsApp service dynamically
            const whatsappService = require('./whatsapp');
            
            if (action === 'add') {
                // Add group to monitoring
                await whatsappService.addMonitoredGroup(groupName);
                await this.answerCallbackQuery(query.id, `✅ Added "${groupName}" to monitoring`);
                
                logger.telegram('Group added to monitoring', { 
                    userId: query.from.id, 
                    groupName 
                });

                if (config.get('telegram.logAllInteractions')) {
                    await this.sendStatusUpdate(`✅ User @${query.from.username} added group to monitoring: ${groupName}`);
                }

            } else if (action === 'remove') {
                // Remove group from monitoring
                await whatsappService.removeMonitoredGroup(groupName);
                await this.answerCallbackQuery(query.id, `❌ Removed "${groupName}" from monitoring`);
                
                logger.telegram('Group removed from monitoring', { 
                    userId: query.from.id, 
                    groupName 
                });

                if (config.get('telegram.logAllInteractions')) {
                    await this.sendStatusUpdate(`❌ User @${query.from.username} removed group from monitoring: ${groupName}`);
                }
            }

            // Refresh the groups management interface
            await this.refreshGroupsManagement(query.message);

        } catch (error) {
            logger.error('Error handling group management', error);
            await this.answerCallbackQuery(query.id, '❌ Error updating group monitoring');
        }
    }

    /**
     * Handle groups navigation actions (refresh, status, close)
     * @param {Object} query - Telegram callback query object
     * @param {string} data - Callback data
     */
    async handleGroupsNavigation(query, data) {
        const chatId = query.message.chat.id;
        const action = data.replace('groups_', '');

        try {
            if (action === 'refresh') {
                await this.answerCallbackQuery(query.id, '🔄 Refreshing groups...');
                await this.refreshGroupsManagement(query.message);

            } else if (action === 'status') {
                const monitoredGroups = config.get('whatsapp.groups') || [];
                const allGroups = await this.getAllWhatsAppGroups();
                
                const statusMessage = `📊 *Group Monitoring Status*\n\n` +
                    `*Monitored Groups:* ${monitoredGroups.length}\n` +
                    `*Total Groups:* ${allGroups.length}\n\n` +
                    `*Currently Monitored:*\n` +
                    monitoredGroups.map(group => `• ${group}`).join('\n') +
                    `\n\n*Monitoring Coverage:* ${((monitoredGroups.length / allGroups.length) * 100).toFixed(1)}%`;

                await this.bot.editMessageText(statusMessage, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });

            } else if (action === 'close') {
                await this.bot.editMessageText('❌ *Group management closed*', {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            logger.error('Error handling groups navigation', error);
            await this.answerCallbackQuery(query.id, '❌ Error processing request');
        }
    }

    /**
     * Refresh the groups management interface
     * @param {Object} message - Telegram message object
     */
    async refreshGroupsManagement(message) {
        try {
            const allGroups = await this.getAllWhatsAppGroups();
            const monitoredGroups = config.get('whatsapp.groups') || [];
            const keyboard = this.createGroupManagementKeyboard(allGroups, monitoredGroups);
            
            const updatedMessage = `📱 *Group Management*\n\n` +
                `Select a group to toggle monitoring:\n` +
                `✅ = Currently monitored\n` +
                `❌ = Not monitored\n\n` +
                `*Monitored Groups:* ${monitoredGroups.length}/${allGroups.length}`;

            await this.bot.editMessageText(updatedMessage, {
                chat_id: message.chat.id,
                message_id: message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });

        } catch (error) {
            logger.error('Error refreshing groups management', error);
        }
    }

    /**
     * Handle group selection for summarize workflow
     */
    async handleGroupSelection(query, data) {
        try {
            const groupName = data.replace('group_', '');
            const chatId = query.message.chat.id;
            const userId = query.from.id;

            // Store selected group in user state
            this.userStates = this.userStates || new Map();
            const userState = this.userStates.get(userId) || {};
            userState.selectedGroup = groupName;
            this.userStates.set(userId, userState);

            // Create date selection keyboard
            const keyboard = this.createDateSelectionKeyboard();
            
            const message = `📅 *Select a date for ${groupName}:*`;
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });

            await this.bot.answerCallbackQuery(query.id, { text: `Selected: ${groupName}` });

        } catch (error) {
            logger.error('Error handling group selection', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error selecting group' });
        }
    }

    /**
     * Handle date selection for summarize workflow
     */
    async handleDateSelection(query, data) {
        try {
            const dateStr = data.replace('date_', '');
            const chatId = query.message.chat.id;
            const userId = query.from.id;

            // Get user state
            this.userStates = this.userStates || new Map();
            const userState = this.userStates.get(userId) || {};
            const groupName = userState.selectedGroup;

            if (!groupName) {
                await this.bot.answerCallbackQuery(query.id, { text: '❌ No group selected' });
                return;
            }

            // Show processing message
            await this.bot.editMessageText('🔄 *Processing summary...*\n\nPlease wait while I generate the summary.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Processing...' });

            // Get messages from database
            const databaseService = require('./database');
            const messages = await databaseService.getMessagesByGroupAndDate(groupName, dateStr, dateStr);

            if (!messages || messages.length === 0) {
                await this.bot.editMessageText(`❌ *No messages found*\n\nNo messages found for ${groupName} on ${dateStr}`, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
                return;
            }

            // Generate summary using Gemini
            const geminiService = require('./gemini');
            const summary = await geminiService.generateSummary(messages, groupName, dateStr);

            if (!summary) {
                await this.bot.editMessageText(`❌ *Error generating summary*\n\nFailed to generate summary for ${groupName} on ${dateStr}`, {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                });
                return;
            }

            // Format and send summary
            const summaryMessage = this.formatSummaryMessage(groupName, dateStr, summary, messages.length);
            await this.bot.editMessageText(summaryMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });

            // Log interaction to status group if enabled
            if (config.get('telegram.logAllInteractions')) {
                await this.sendStatusUpdate(`📊 User @${query.from.username} generated summary for ${groupName} (${dateStr}) - ${messages.length} messages`);
            }

            // Clean up user state
            this.userStates.delete(userId);

        } catch (error) {
            logger.error('Error handling date selection', error);
            await this.bot.editMessageText('❌ *Error generating summary*\n\nPlease try again later.', {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
        }
    }

    /**
     * Handle group pagination for summarize workflow
     */
    async handleGroupPagination(query, data) {
        try {
            const page = parseInt(data.replace('page_groups_', ''));
            const chatId = query.message.chat.id;
            const userId = query.from.id;

            // Get available groups
            const groups = await this.getAvailableGroups();
            
            if (groups.length === 0) {
                await this.bot.editMessageText('❌ No WhatsApp groups are currently being monitored.', {
                    chat_id: chatId,
                    message_id: query.message.message_id
                });
                return;
            }

            // Create inline keyboard for group selection
            const keyboard = this.createGroupSelectionKeyboard(groups, page);
            
            const message = '📱 *Select a WhatsApp group to summarize:*';
            await this.bot.editMessageText(message, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });

            await this.bot.answerCallbackQuery(query.id);

        } catch (error) {
            logger.error('Error handling group pagination', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error navigating groups' });
        }
    }

    /**
     * Handle cancel action
     */
    async handleCancel(query) {
        try {
            const chatId = query.message.chat.id;
            const userId = query.from.id;

            // Clean up user state
            this.userStates = this.userStates || new Map();
            this.userStates.delete(userId);

            await this.bot.editMessageText('❌ *Operation cancelled*', {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });

            await this.bot.answerCallbackQuery(query.id, { text: 'Cancelled' });

        } catch (error) {
            logger.error('Error handling cancel', error);
            await this.bot.answerCallbackQuery(query.id, { text: '❌ Error cancelling' });
        }
    }

    /**
     * Refresh the current page with updated data
     */
    async refreshCurrentPage(chatId, userId) {
        try {
            const state = this.userPaginationState[userId];
            if (!state) {
                return;
            }

            // Get fresh data
            const whatsappService = require('./whatsapp');
            const allGroups = await this.getAllWhatsAppGroups();
            const monitoredGroups = whatsappService.getMonitoredGroups();
            
            // Update the state with fresh data
            const totalPages = Math.ceil(allGroups.length / 20);
            const currentPage = Math.min(state.currentPage || 0, totalPages - 1);
            
            this.userPaginationState[userId] = {
                allGroups,
                monitoredGroups,
                totalPages,
                currentPage
            };

            // Update the message with fresh data
            const messageId = this.userMessageIds?.[userId];
            await this.sendGroupsPage(chatId, userId, currentPage, messageId);
        } catch (error) {
            logger.error('Error refreshing current page', error);
        }
    }
}

// Create singleton instance
const telegramService = new TelegramService();

module.exports = telegramService;