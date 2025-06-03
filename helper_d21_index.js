// helper_d21_index.js - Dedicated Animated Emoji Helper Bot for Dice 21 Rolls
// Polls the database for Dice 21 roll requests, sends animated dice,
// and updates the database with the result.

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg'; // For PostgreSQL

// --- Environment Variable Validation & Configuration ---
console.log("HelperD21: Loading environment variables...");

const HELPER_D21_BOT_TOKEN = process.env.HELPER_D21_BOT_TOKEN; // Specific token for this helper
const DATABASE_URL = process.env.DATABASE_URL;
const POLLING_INTERVAL_MS = process.env.HELPER_D21_DB_POLL_INTERVAL_MS ? parseInt(process.env.HELPER_D21_DB_POLL_INTERVAL_MS, 10) : 2500; // Can have its own interval
const MAX_REQUESTS_PER_CYCLE = process.env.HELPER_D21_MAX_REQUESTS_PER_CYCLE ? parseInt(process.env.HELPER_D21_MAX_REQUESTS_PER_CYCLE, 10) : 3; // Can have its own batch size

const HANDLER_TYPE_THIS_HELPER = 'DICE_21_ROLL'; // Specific handler type this bot processes

if (!HELPER_D21_BOT_TOKEN) {
    console.error("FATAL ERROR: HELPER_D21_BOT_TOKEN is not defined for the HelperD21 Bot.");
    process.exit(1);
}
if (!DATABASE_URL) {
    console.error("FATAL ERROR: DATABASE_URL is not defined. HelperD21 bot cannot connect to PostgreSQL.");
    process.exit(1);
}
console.log(`HelperD21: HELPER_D21_BOT_TOKEN loaded.`);
console.log(`HelperD21: DATABASE_URL loaded.`);
console.log(`HelperD21: Database polling interval set to ${POLLING_INTERVAL_MS}ms for handler type '${HANDLER_TYPE_THIS_HELPER}'.`);
console.log(`HelperD21: Max requests per cycle set to ${MAX_REQUESTS_PER_CYCLE}.`);

// --- PostgreSQL Pool Initialization ---
console.log("HelperD21: ⚙️ Setting up PostgreSQL Pool...");
const useSslHelper = process.env.DB_SSL === undefined ? true : (process.env.DB_SSL === 'true');
const rejectUnauthorizedSslHelper = process.env.DB_REJECT_UNAUTHORIZED === undefined ? false : (process.env.DB_REJECT_UNAUTHORIZED === 'true');
console.log(`HelperD21: DB_SSL effective setting: ${useSslHelper}`);
console.log(`HelperD21: DB_REJECT_UNAUTHORIZED effective setting: ${rejectUnauthorizedSslHelper}`);

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: useSslHelper ? { rejectUnauthorized: rejectUnauthorizedSslHelper } : false,
});

pool.on('connect', client => {
    console.log('HelperD21: ℹ️ [DB Pool] Client connected to PostgreSQL.');
});
pool.on('error', (err, client) => {
    console.error('HelperD21: ❌ Unexpected error on idle PostgreSQL client', err);
});
console.log("HelperD21: ✅ PostgreSQL Pool created.");

// --- Telegram Bot Initialization ---
const bot = new TelegramBot(HELPER_D21_BOT_TOKEN, { polling: true }); // polling: true if you want /start, false if purely DB driven
let botUsername = "HelperD21Bot"; // Fallback username
bot.getMe().then(me => {
    botUsername = me.username || botUsername;
    console.log(`HelperD21: Telegram Bot instance created for @${botUsername}.`);
}).catch(err => {
    console.error(`HelperD21: Failed to get bot info: ${err.message}. Using fallback username.`);
    console.log("HelperD21: Telegram Bot instance created (getMe failed).");
});


// --- Database Polling Function ---
async function checkAndProcessRollRequests() {
    if (isShuttingDownHelper) return; // Check shutdown flag

    let client = null;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // Modified selectQuery to filter by HANDLER_TYPE_THIS_HELPER
        const selectQuery = `
            SELECT request_id, game_id, chat_id, user_id, emoji_type, notes 
            FROM dice_roll_requests 
            WHERE status = 'pending' AND handler_type = $1 
            ORDER BY requested_at ASC 
            LIMIT $2 
            FOR UPDATE SKIP LOCKED`;
        const result = await client.query(selectQuery, [HANDLER_TYPE_THIS_HELPER, MAX_REQUESTS_PER_CYCLE]);

        if (result.rows.length === 0) {
            await client.query('COMMIT');
            client.release();
            return;
        }

        console.log(`[DB_POLL][${HANDLER_TYPE_THIS_HELPER}] HelperD21: Found ${result.rows.length} pending request(s).`);

        for (const request of result.rows) {
            if (isShuttingDownHelper) {
                console.log(`[DB_PROCESS][${HANDLER_TYPE_THIS_HELPER}] Shutdown initiated, skipping request ${request.request_id}`);
                break; // Exit loop if shutting down
            }
            const helperLogPrefix = `[HelperD21_Req${request.request_id}]`;
            console.log(`${helperLogPrefix} Processing for game_id: ${request.game_id}, emoji: ${request.emoji_type || '🎲 (default)'}`);
            
            let rollValue = null;
            let updateStatus = 'error';
            let currentNotes = request.notes || ''; // Preserve existing notes
            let processingNote = ` Attempted by ${botUsername}.`;

            const emojiToSend = request.emoji_type || '🎲';

            try {
                // Optional: Mark as 'processing' specifically by this helper type if needed for monitoring
                // await client.query("UPDATE dice_roll_requests SET status = $1, helper_id = $2 WHERE request_id = $3", [`processing_${HANDLER_TYPE_THIS_HELPER.toLowerCase()}`, botUsername, request.request_id]);

                console.log(`${helperLogPrefix} Sending animated emoji '${emojiToSend}' to chat_id: ${request.chat_id}`);
                const sentMessage = await bot.sendDice(request.chat_id, { emoji: emojiToSend });

                if (sentMessage && sentMessage.dice && typeof sentMessage.dice.value === 'number') {
                    rollValue = sentMessage.dice.value;
                    updateStatus = 'completed';
                    processingNote = ` Processed by ${botUsername}, Value: ${rollValue}. ${currentNotes}`;
                    console.log(`${helperLogPrefix} Emoji '${emojiToSend}' sent. Result Value: ${rollValue}`);
                } else {
                    console.error(`${helperLogPrefix} Failed to get valid dice result. SentMessage: ${JSON.stringify(sentMessage)}`);
                    processingNote = ` Error: Send succeeded but no valid dice object. ${currentNotes}`;
                }
            } catch (sendError) {
                console.error(`${helperLogPrefix} Failed to send emoji '${emojiToSend}' to chat_id ${request.chat_id}:`, sendError.message);
                let detailedError = sendError.message;
                if (sendError.response && sendError.response.body) {
                    console.error(`${helperLogPrefix} API Error Details: ${JSON.stringify(sendError.response.body)}`);
                    detailedError = `API Err ${sendError.response.body.error_code || ''}: ${sendError.response.body.description || sendError.message}`;
                }
                processingNote = ` Error: ${detailedError.substring(0, 150)}. ${currentNotes}`;
            }
            
            const finalNotes = processingNote.substring(0, 250); // Ensure notes fit if column has limit

            const updateQuery = `UPDATE dice_roll_requests SET status = $1, roll_value = $2, processed_at = NOW(), notes = $4 WHERE request_id = $3`;
            const updateResult = await client.query(updateQuery, [updateStatus, rollValue, request.request_id, finalNotes]);

            if (updateResult.rowCount > 0) {
                console.log(`${helperLogPrefix} Updated request to status '${updateStatus}'${rollValue !== null ? ` with value ${rollValue}` : ''}. Notes: ${finalNotes}`);
            } else {
                console.warn(`${helperLogPrefix} Failed to update request. Status might have changed concurrently or request ID invalid (rowCount 0). Current status was intended to be '${updateStatus}'.`);
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        console.error(`[DB_POLL_ERROR][${HANDLER_TYPE_THIS_HELPER}] HelperD21: Error during DB check/processing cycle:`, error);
        if (client) {
            try { await client.query('ROLLBACK'); console.log(`[DB_POLL_ERROR][${HANDLER_TYPE_THIS_HELPER}] HelperD21: Transaction rolled back.`); }
            catch (rollbackError) { console.error(`[DB_POLL_ERROR][${HANDLER_TYPE_THIS_HELPER}] HelperD21: Failed to rollback:`, rollbackError); }
        }
    } finally {
        if (client) {
            client.release();
        }
    }
}

// --- Telegram Bot Event Handlers (for Helper Bot's own interactions) ---
bot.onText(/\/start|\/help/i, async (msg) => {
    const chatId = msg.chat.id;
    let currentBotUsername = "HelperD21Bot";
    try {
        const me = await bot.getMe();
        currentBotUsername = me.username || currentBotUsername;
    } catch(e) {/* ignore */}

    const helpText = `I am the ${currentBotUsername}, a dedicated helper bot for Dice 21 game rolls.\n` +
                     `I process requests from the main casino bot to send animated dice emojis and report their results.\n` +
                     `You do not need to interact with me directly.`;
    bot.sendMessage(chatId, helpText);
});

bot.on('polling_error', (error) => {
    console.error(`\n🚫 HelperD21 TELEGRAM POLLING ERROR 🚫 Code: ${error.code}, Msg: ${error.message}`);
});
bot.on('error', (error) => {
    console.error('\n🔥 HelperD21 GENERAL TELEGRAM LIBRARY ERROR EVENT 🔥:', error);
});

// --- Startup Function ---
let dbPollingIntervalId = null;
let isShuttingDownHelper = false; // Shutdown flag for this helper

async function startHelperBot() {
    console.log(`\n🚀🚀🚀 Initializing HelperD21 Bot (${HANDLER_TYPE_THIS_HELPER}) 🚀🚀🚀`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    try {
        console.log("HelperD21: Testing DB connection...");
        const dbClient = await pool.connect();
        console.log("HelperD21: ✅ DB connected.");
        await dbClient.query('SELECT NOW()');
        console.log("HelperD21: ✅ DB query test OK.");
        dbClient.release();

        // bot.getMe() already called above and username stored in botUsername

        dbPollingIntervalId = setInterval(() => {
            if (!isShuttingDownHelper) {
                checkAndProcessRollRequests().catch(err => {
                    console.error(`[${HANDLER_TYPE_THIS_HELPER}] Uncaught error in checkAndProcessRollRequests interval:`, err);
                });
            }
        }, POLLING_INTERVAL_MS);
        console.log(`HelperD21: ✅ DB polling started (Handler: ${HANDLER_TYPE_THIS_HELPER}, Interval: ${POLLING_INTERVAL_MS}ms).`);
        console.log(`\n🎉 HelperD21 Bot operational!`);
    } catch (error) {
        console.error("❌ CRITICAL STARTUP ERROR (HelperD21 Bot):", error);
        if (pool) { try { await pool.end(); } catch (e) { /* ignore */ } }
        process.exit(1);
    }
}

// --- Shutdown Handling ---
async function shutdownHelper(signal) {
    if (isShuttingDownHelper) {
        console.log("HelperD21: Shutdown already in progress."); return;
    }
    isShuttingDownHelper = true;
    console.log(`\n🚦 Received ${signal}. Shutting down HelperD21 Bot...`);
    if (dbPollingIntervalId) clearInterval(dbPollingIntervalId);
    console.log("HelperD21: DB polling stopped.");
    if (bot && typeof bot.stopPolling === 'function' && bot.isPolling()) { // Check if stopPolling exists and if it's polling
        try { await bot.stopPolling({ cancel: true }); console.log("HelperD21: Telegram polling stopped."); }
        catch(e) { console.error("HelperD21: Error stopping Telegram polling:", e.message); }
    } else if (bot && typeof bot.close === 'function') { // For non-polling bots, close might be available
        try { await bot.close(); console.log("HelperD21: Telegram bot connection closed."); }
        catch(e) { console.error("HelperD21: Error closing Telegram bot connection:", e.message); }
    }
    if (pool) {
        try { await pool.end(); console.log("HelperD21: PostgreSQL pool closed."); }
        catch(e) { console.error("HelperD21: Error closing PostgreSQL pool:", e.message); }
    }
    console.log("HelperD21: ✅ Shutdown complete. Exiting.");
    process.exit(0);
}

process.on('SIGINT', async () => await shutdownHelper('SIGINT'));
process.on('SIGTERM', async () => await shutdownHelper('SIGTERM'));
process.on('uncaughtException', (error, origin) => {
    console.error(`\n🚨🚨 HelperD21 UNCAUGHT EXCEPTION AT: ${origin} 🚨🚨`, error);
    if (!isShuttingDownHelper) {
      shutdownHelper('uncaughtException_exit').catch(() => process.exit(1));
    } else {
      process.exit(1); // Already shutting down, force exit
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n🔥🔥 HelperD21 UNHANDLED REJECTION 🔥🔥 At Promise:`, promise, `Reason:`, reason);
});

// --- Start the Bot ---
startHelperBot();

console.log("HelperD21 Bot: End of script. Startup process initiated.");
// --- END OF helper_d21_index.js ---
