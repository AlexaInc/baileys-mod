/**
 * FIXED whatsappService.ts
 * Main fixes:
 * 1. fetchLatestBaileysVersion properly (it never throws; .catch was useless)
 * 2. Handle connection events correctly — QR only emitted during pairing
 * 3. If auth is corrupt/old, WhatsApp sends CB:failure → delete ./auth to start fresh
 * 4. Added reconnect logic and pairing support
 * 5. printQRInTerminal false is fine, but we must listen for qr event/update
 */

import {
    makeWASocket,
    AnyMessageContent,
    BinaryInfo,
    delay,
    DisconnectReason,
    downloadAndProcessHistorySyncNotification,
    encodeWAM,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    getHistoryMsg,
    isJidNewsletter,
    isJidBroadcast,
    jidNormalizedUser,
    Browsers,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
    proto,
    useMultiFileAuthState,
    WAMessageContent,
    WAMessageKey
} from '@alexainc/baileys-mod';

import { default as P } from "pino";
import path from 'path';
import NodeCache from 'node-cache';
import qrcode from 'qrcode-terminal';
import fs from 'fs';

const logger = P({ level: 'info' });
const groupMetadataCache = new NodeCache({ stdTTL: 300, maxKeys: 150 });

// FIX: Don't use redundant .catch() — fetchLatestBaileysVersion never throws.
const { version, isLatest } = await fetchLatestBaileysVersion();
logger.info({ version, isLatest }, 'version info');

const CustomBrowsersMap = {
    appropriate: () => ['Alexainc', 'medilab', '1.0']
};

const authPath = './auth';

// FIX: If connection keeps failing with "Connection Failure" and qr never appears,
// the auth session is likely corrupt/rejected by WA server. Delete auth and restart.
// Uncomment the next line to force a fresh pairing session (will delete old auth):
// if (fs.existsSync(authPath)) { fs.rmSync(authPath, { recursive: true, force: true }); logger.warn('DELETED OLD AUTH for fresh pairing'); }

const { state, saveCreds } = await useMultiFileAuthState(authPath);

const msgRetryCounterCache = new NodeCache({ stdTTL: 3600, maxKeys: 1000 });

const MediGrdWa = makeWASocket({
    version,
    logger: P({ level: 'fatal' }),
    browser: CustomBrowsersMap.appropriate(),
    printQRInTerminal: false,
    auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'fatal' }))
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: isJidBroadcast,
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 90000,
    keepAliveIntervalMs: 5000
});

interface ConnectionUpdateEvent {
    connection?: 'connecting' | 'open' | 'close' | string;
    receivedPendingNotifications?: boolean;
    qr?: string;
    isNewLogin?: boolean;
    lastDisconnect?: {
        error?: {
            data?: any;
            isBoom?: boolean;
            isServer?: boolean;
            output?: any;
            message?: string;
            stack?: string;
            [key: string]: any;
        };
        date?: Date;
    };
    [key: string]: any;
}

MediGrdWa.ev.on("creds.update", saveCreds);

MediGrdWa.ev.on("connection.update", async (update: ConnectionUpdateEvent) => {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;
    console.log('Connection Update:', update);

    // FIX: Capture QR when pairing is required (new session or no valid login)
    if (qr) {
        console.log('QR CODE RECEIVED! Scan with WhatsApp:');
        qrcode.generate(qr, { small: true });
        // Also save to file for remote access
        fs.writeFileSync('qr-code.txt', qr);
        console.log('QR also saved to qr-code.txt');
    }

    if (isNewLogin) {
        console.log('New login / pairing completed');
        if (qr) {
            console.log('QR cleared after pairing');
        }
    }

    if (connection === 'connecting') {
        console.log('Status: connecting...');
    }

    if (connection === 'open') {
        console.log('✅ WhatsApp connected and open!');
        // Clear any saved QR file now that we're logged in
        if (fs.existsSync('qr-code.txt')) fs.unlinkSync('qr-code.txt');
    }

    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || 500;
        const reasonText = lastDisconnect?.error?.message || JSON.stringify(lastDisconnect?.error);
        console.error('❌ Connection closed. Reason:', reasonText, '| Status code:', statusCode);

        // FIX: If it's a session/auth failure (Connection Failure / badSession),
        // delete auth and restart fresh so pairing/QR can occur.
        if (reasonText.includes('Connection Failure') || statusCode === DisconnectReason.badSession || statusCode === DisconnectReason.multideviceMismatch) {
            console.warn('Detected session/auth failure. Removing auth folder to force fresh pairing...');
            try {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log('Auth removed. Restart the script to get a new QR.');
            } catch (e) {
                console.error('Failed to remove auth folder:', e);
            }
        }

        // Auto-reconnect logic (optional)
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.restartRequired;
        if (shouldReconnect) {
            console.log('Attempting reconnect in 5s...');
            setTimeout(() => {
                console.log('Restarting socket...');
                process.exit(1); // Or implement full reconnect instead of exit
            }, 5000);
        }
    }

    if (receivedPendingNotifications !== undefined) {
        console.log('Pending notifications handled:', receivedPendingNotifications);
    }
});

export { MediGrdWa, logger, groupMetadataCache };
