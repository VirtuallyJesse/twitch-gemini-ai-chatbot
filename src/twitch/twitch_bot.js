import tmi from 'tmi.js';
import { sendChatMessage } from './apiClient.js';
import { getUserToken } from './tokenManager.js';

export class TwitchBot {
    constructor(botUsername, channels, botId, channelIdMap) {
        this.channels = channels;
        this.botId = botId;
        this.channelIdMap = channelIdMap || {};
        this.botUsername = String(botUsername || '').toLowerCase();

        this.client = new tmi.client({
            connection: {
                reconnect: true,
                secure: true
            },
            identity: {
                username: botUsername,
                password: async () => {
                    const token = await getUserToken();
                    return `oauth:${token}`;
                }
            },
            channels: this.channels
        });

        this.messageBuffers = new Map();
        this.maxBufferSize = 1000;

        for (const channel of channels) {
            this.messageBuffers.set(channel, []);
        }

        this.onLogEntry = null;
    }

    async connect(onConnected, onDisconnected) {
        try {
            await getUserToken();
            await this.client.connect();
            if (onConnected) onConnected();
        } catch (error) {
            console.error('[TwitchBot] Connection failed:', error);
            if (onDisconnected) onDisconnected(error);
        }
    }

    onMessage(callback) {
        this.client.on('message', callback);
    }

    onConnected(callback) {
        this.client.on('connected', callback);
    }

    onDisconnected(callback) {
        this.client.on('disconnected', callback);
    }

    async say(channel, message) {
        try {
            const cleanChannel = channel.replace('#', '').toLowerCase();
            const broadcasterId = this.channelIdMap[cleanChannel];

            if (!broadcasterId) {
                throw new Error(`Broadcaster ID not found for channel ${channel}`);
            }

            if (!this.botId) {
                throw new Error('Bot ID is missing');
            }

            await sendChatMessage(broadcasterId, this.botId, message);
            this.addMessageToBuffer(channel, this.botUsername, message);
        } catch (error) {
            console.error('[TwitchBot] Failed to send message:', error.message || error);
        }
    }

    addMessageToBuffer(channel, username, message, meta = null) {
        if (!this.messageBuffers.has(channel)) {
            this.messageBuffers.set(channel, []);
        }

        const buffer = this.messageBuffers.get(channel);
        const entry = {
            username,
            message,
            timestamp: Date.now(),
            meta: meta && typeof meta === 'object' ? meta : null
        };

        buffer.push(entry);

        if (buffer.length > this.maxBufferSize) {
            buffer.shift();
        }

        if (this.onLogEntry) {
            this.onLogEntry(channel, entry);
        }

        return entry;
    }

    getRecentMessages(channel, count = 10, commandNames = []) {
        const buffer = this.messageBuffers.get(channel);
        if (!buffer) return [];

        return buffer
            .slice(-count)
            .filter(entry => {
                const message = String(entry.message || '').toLowerCase().trim();
                const isCommand = commandNames.some(cmd => message.startsWith(cmd));
                const isMe = String(entry.username || '').toLowerCase() === this.botUsername;
                return !isCommand && !isMe;
            })
            .map(entry => `${entry.username}: ${entry.message}`);
    }
}