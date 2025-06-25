/**
 * Main Entry Point for WhatsApp to Telegram Bot
 *
 * This file initializes all core services (Database, WhatsApp, Gemini AI, Telegram),
 * wires up status reporting, and starts the bot. It also handles graceful shutdown
 * and logs startup status for monitoring and debugging.
 *
 * Features:
 * - Service initialization and dependency wiring
 * - Status reporting to Telegram status group
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Centralized error handling
 */

const config = require('./config');
const logger = require('./utils/logger');
const databaseService = require('./services/database');
const whatsappService = require('./services/whatsapp');
const geminiService = require('./services/gemini');
const telegramService = require('./services/telegram');

async function main() {
    try {
        logger.info('Starting WhatsApp to Telegram Bot...');

        // Initialize database
        await databaseService.initialize();
        logger.info('Database initialized');

        // Initialize Gemini AI
        await geminiService.initialize();
        logger.info('Gemini AI initialized');

        // Initialize Telegram bot
        await telegramService.initialize();
        logger.info('Telegram bot initialized');

        // Wire up WhatsApp status reporting to Telegram status group
        whatsappService.setStatusCallback(async (statusMsg) => {
            await telegramService.sendStatusUpdate(statusMsg);
        });

        // Initialize WhatsApp client
        await whatsappService.initialize();
        await whatsappService.start();
        logger.info('WhatsApp client initialized and started');

        // Send startup status
        await telegramService.sendStatusUpdate('✅ Bot started and all services initialized.');

        // Handle graceful shutdown
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        logger.info('Bot is running. Press Ctrl+C to stop.');
    } catch (error) {
        logger.error('Fatal error during startup', error);
        process.exit(1);
    }
}

async function shutdown() {
    logger.info('Shutting down WhatsApp to Telegram Bot...');
    try {
        await whatsappService.stop();
        await telegramService.stop();
        await databaseService.close();
        logger.info('All services stopped. Exiting.');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
    }
}

main(); 