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
        try {
            if (!this.isUserAllowed(msg.from.username)) {
                await this.sendUnauthorizedMessage(msg.chat.id);
                return;
            }

            const welcomeMessage = `
🤖 *WhatsApp Summary Bot*

Welcome! I can help you get summaries of WhatsApp group messages.

*Available Commands:*
• /summarize - Get a summary of messages from a specific group and date

*How to use:*
1. Send /summarize
2. Select a group from the list
3. Select a date
4. Get your summary!

*Note:* I only process messages from configured WhatsApp groups.
            `;

            await this.bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
            logger.telegram('Start command handled', { userId: msg.from.id, username: msg.from.username });

        } catch (error) {
            logger.error('Error handling start command', error);
            await this.sendErrorMessage(msg.chat.id);
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

        } catch (error) {
            logger.error('Error handling summarize command', error);
            await this.sendErrorMessage(msg.chat.id);
        }
    }

    /**
     * Handle callback queries from inline buttons
     * @param {Object} query - Telegram callback query object
     */
    async handleCallbackQuery(query) {
        try {
            if (!this.isUserAllowed(query.from.username)) {
                await this.answerCallbackQuery(query.id, '❌ Unauthorized access');
                return;
            }

            const data = query.data;
            const chatId = query.message.chat.id;

            if (data.startsWith('group_')) {
                await this.handleGroupSelection(query, data);
            } else if (data.startsWith('date_')) {
                await this.handleDateSelection(query, data);
            } else if (data.startsWith('page_')) {
                await this.handlePageNavigation(query, data);
            } else if (data === 'cancel') {
                await this.handleCancel(query);
            }

            // Answer callback query to remove loading state
            await this.answerCallbackQuery(query.id);

        } catch (error) {
            logger.error('Error handling callback query', error);
            await this.answerCallbackQuery(query.id, '❌ An error occurred');
        }
    }

    /**
     * Handle group selection from inline keyboard
     * @param {Object} query - Telegram callback query object
     * @param {string} data - Callback data
     */
    async handleGroupSelection(query, data) {
        const groupName = data.replace('group_', '');
        const chatId = query.message.chat.id;

        // Store selected group in user state
        this.userStates.set(chatId, { groupName });

        // Create date selection keyboard
        const keyboard = this.createDateSelectionKeyboard();
        
        const message = `📅 *Selected Group:* ${groupName}\n\n*Select a date:*`;
        await this.bot.editMessageText(message, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: keyboard
            }
        });

        logger.telegram('Group selected', { userId: query.from.id, groupName });
    }

    /**
     * Handle date selection from inline keyboard
     * @param {Object} query - Telegram callback query object
     * @param {string} data - Callback data
     */
    async handleDateSelection(query, data) {
        const date = data.replace('date_', '');
        const chatId = query.message.chat.id;
        const userState = this.userStates.get(chatId);

        if (!userState || !userState.groupName) {
            await this.answerCallbackQuery(query.id, '❌ No group selected');
            return;
        }

        // Show processing message
        await this.bot.editMessageText('🔄 *Processing summary...*', {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });

        try {
            // Get messages for the selected group and date
            const messages = await databaseService.getMessagesByGroupAndDate(
                userState.groupName, 
                date, 
                date
            );

            if (messages.length === 0) {
                await this.bot.editMessageText(
                    `❌ *No messages found*\n\nGroup: ${userState.groupName}\nDate: ${date}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown'
                    }
                );
                return;
            }

            // Check if summary already exists
            let summary = await databaseService.getSummary(userState.groupName, date);
            
            if (!summary) {
                // Generate new summary using Gemini AI
                summary = await geminiService.generateSummary(messages, userState.groupName, date);
                
                // Store summary in database
                await databaseService.storeSummary(userState.groupName, date, summary, messages.length);
            }

            // Format and send summary
            const summaryMessage = this.formatSummaryMessage(userState.groupName, date, summary, messages.length);
            
            await this.bot.editMessageText(summaryMessage, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });

            // Clear user state
            this.userStates.delete(chatId);

            logger.telegram('Summary generated and sent', { 
                userId: query.from.id, 
                groupName: userState.groupName, 
                date,
                messageCount: messages.length 
            });

        } catch (error) {
            logger.error('Error generating summary', error);
            await this.bot.editMessageText(
                '❌ *Error generating summary*\n\nPlease try again later.',
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown'
                }
            );
        }
    }

    /**
     * Handle page navigation for paginated keyboards
     * @param {Object} query - Telegram callback query object
     * @param {string} data - Callback data
     */
    async handlePageNavigation(query, data) {
        const parts = data.split('_');
        const type = parts[1]; // 'groups' or 'dates'
        const page = parseInt(parts[2]);
        const chatId = query.message.chat.id;

        if (type === 'groups') {
            const groups = await this.getAvailableGroups();
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
        }
    }

    /**
     * Handle cancel action
     * @param {Object} query - Telegram callback query object
     */
    async handleCancel(query) {
        const chatId = query.message.chat.id;
        
        // Clear user state
        this.userStates.delete(chatId);
        
        await this.bot.editMessageText('❌ *Operation cancelled*', {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
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
     * Answer callback query
     * @param {string} queryId - Callback query ID
     * @param {string} text - Optional text to show
     */
    async answerCallbackQuery(queryId, text = '') {
        try {
            await this.bot.answerCallbackQuery(queryId, { text });
        } catch (error) {
            logger.error('Error answering callback query', error);
        }
    }

    /**
     * Get available groups from configuration
     * @returns {Array} Array of group names
     */
    async getAvailableGroups() {
        try {
            // For now, return groups from config
            // In the future, this could be dynamic based on database
            return config.get('whatsapp.groups') || [];
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
            const statusMessage = `🤖 *Bot Status Update*\n⏰ ${timestamp}\n\n${message}`;
            
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
}

// Create singleton instance
const telegramService = new TelegramService();

module.exports = telegramService; 