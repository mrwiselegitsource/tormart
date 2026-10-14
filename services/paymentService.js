const { z } = require('zod');
const crypto = require('crypto');

// --- CONSTANTS & STATUSES ---

const PaymentStatus = {
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    WAITING_FOR_PAYMENT: 'WAITING_FOR_PAYMENT',
    TRANSACTION_DETECTED: 'TRANSACTION_DETECTED',
    CHECKING: 'CHECKING',
    CONFIRMING: 'CONFIRMING',
    CONFIRMED: 'CONFIRMED',
    PAID: 'PAID',
    
    // Exception states
    EXPIRED: 'EXPIRED',
    UNDERPAID: 'UNDERPAID',
    OVERPAID: 'OVERPAID',
    WRONG_ADDRESS: 'WRONG_ADDRESS',
    WRONG_NETWORK: 'WRONG_NETWORK',
    FAILED: 'FAILED',
    ALREADY_USED: 'ALREADY_USED',
    CANCELLED: 'CANCELLED',
    MANUAL_REVIEW: 'MANUAL_REVIEW',
    REJECTED: 'REJECTED'
};

const SupportedCurrencies = ['BTC', 'BCH', 'LTC', 'ETH', 'XMR'];

// Verification fail-safe configuration
const VerificationConfig = {
    WINDOW_MS: 60 * 60 * 1000,            // payment window
    GRACE_MS: parseInt(process.env.PAYMENT_GRACE_MS || String(30 * 60 * 1000), 10), // extra checking after expiry when claimed
    MAX_ATTEMPTS: parseInt(process.env.PAYMENT_MAX_ATTEMPTS || '6', 10)
};

const FINAL_STATUSES = ['PAID', 'CONFIRMED', 'OVERPAID', 'REJECTED', 'CANCELLED'];

/**
 * Map raw intent status (+ expiry) to the single state the buyer UI renders.
 */
function computeViewState(intent, now = Date.now()) {
    if (!intent) return 'awaiting';
    const s = intent.status;
    if (['PAID', 'CONFIRMED', 'OVERPAID'].includes(s)) return 'paid';
    if (s === 'REJECTED' || s === 'CANCELLED' || s === 'FAILED') return 'rejected';
    if (s === 'MANUAL_REVIEW' || s === 'UNDERPAID') return 'review';
    if (s === 'CONFIRMING') return 'confirming';
    if (s === 'EXPIRED') return 'expired';
    const expiresAt = new Date(intent.expires_at).getTime();
    if (s === 'CHECKING' || s === 'TRANSACTION_DETECTED') return 'verifying';
    if (!isNaN(expiresAt) && now > expiresAt) return 'expired';
    return 'awaiting';
}

// --- VALIDATION SCHEMAS ---

const createPaymentSchema = z.object({
    orderId: z.number().int().positive(),
    currency: z.enum(SupportedCurrencies),
    network: z.string().min(1),
    expectedAmountCrypto: z.string().regex(/^\d+$/, "Amount must be an integer string in smallest units"),
    paymentAddress: z.string().min(1),
    requiredConfirmations: z.number().int().min(1)
});

const updatePaymentStatusSchema = z.object({
    paymentIntentId: z.string().uuid(),
    newStatus: z.enum(Object.values(PaymentStatus)),
    metadata: z.record(z.any()).optional().nullable()
});

// --- SERVICE LAYER ---

class PaymentService {
    constructor(db) {
        this.db = db;
    }

    // Helper for async queries
    runQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this); // 'this' contains lastID and changes
            });
        });
    }

    getQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    /**
     * Create a new payment intent and log the event.
     */
    async createPaymentIntent(data) {
        const validated = createPaymentSchema.parse(data);
        const paymentIntentId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 mins from now
        const now = new Date();

        await this.runQuery(
            `INSERT INTO payment_intents (
                id, order_id, currency, network, expected_amount_crypto, 
                payment_address, status, required_confirmations, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                paymentIntentId, validated.orderId, validated.currency, validated.network,
                validated.expectedAmountCrypto, validated.paymentAddress, PaymentStatus.PAYMENT_CREATED,
                validated.requiredConfirmations, expiresAt.toISOString(), now.toISOString(), now.toISOString()
            ]
        );

        await this._logEvent(paymentIntentId, 'CREATED', null, PaymentStatus.PAYMENT_CREATED);

        return paymentIntentId;
    }

    /**
     * Update payment intent status and log the event.
     */
    async updatePaymentStatus(paymentIntentId, newStatus, metadata = null) {
        const validated = updatePaymentStatusSchema.parse({ paymentIntentId, newStatus, metadata });

        const intent = await this.getQuery(`SELECT status FROM payment_intents WHERE id = ?`, [paymentIntentId]);
        if (!intent) {
            throw new Error(`Payment intent ${paymentIntentId} not found`);
        }

        const oldStatus = intent.status;
        const now = new Date().toISOString();

        await this.runQuery(
            `UPDATE payment_intents SET status = ?, updated_at = ? WHERE id = ?`,
            [newStatus, now, paymentIntentId]
        );

        await this._logEvent(paymentIntentId, 'STATUS_UPDATE', oldStatus, newStatus, metadata);
    }

    /**
     * Record a detected transaction. Uses the UNIQUE(currency, txid) constraint
     * at the database level to prevent double crediting.
     */
    async recordTransaction(paymentIntentId, currency, txid, receivedAmountCrypto) {
        if (!/^\d+$/.test(receivedAmountCrypto)) {
            throw new Error("Amount must be integer string");
        }

        const transactionId = crypto.randomUUID();
        const now = new Date().toISOString();

        try {
            await this.runQuery(
                `INSERT INTO payment_transactions (
                    id, payment_intent_id, currency, txid, received_amount_crypto, status, detected_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    transactionId, paymentIntentId, currency, txid, receivedAmountCrypto, 'DETECTED', now
                ]
            );
            await this._logEvent(paymentIntentId, 'TRANSACTION_DETECTED', null, null, { txid, receivedAmountCrypto });
            return transactionId;
        } catch (err) {
            // Check for sqlite constraint error
            if (err.message && err.message.includes('UNIQUE constraint failed')) {
                throw new Error(PaymentStatus.ALREADY_USED);
            }
            throw err;
        }
    }

    allQuery(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
    }

    /**
     * Load intent together with invoice/buyer info.
     */
    async getIntentContext(intentId) {
        return this.getQuery(`
            SELECT i.*, o.invoice_id, o.user_id AS buyer_id
            FROM payment_intents i JOIN orders o ON i.order_id = o.id
            WHERE i.id = ?`, [intentId]);
    }

    async _systemSenderId() {
        const row = await this.getQuery(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`);
        return row ? row.id : 1;
    }

    /**
     * Send a system message into a user's inbox (shows in header badge + toast).
     */
    async notifyUser(userId, body, senderId = null) {
        try {
            const from = senderId || await this._systemSenderId();
            if (!userId || from === userId) {
                // still store it so user sees it
            }
            const convId = from < userId ? `${from}_${userId}` : `${userId}_${from}`;
            await this.runQuery(
                `INSERT INTO messages (conversation_id, sender_id, receiver_id, body, is_system) VALUES (?, ?, ?, ?, 1)`,
                [convId, from, userId, body]
            );
        } catch (e) {
            console.warn('[PaymentService] notifyUser failed:', e.message);
        }
    }

    async notifyAdmins(body) {
        try {
            const admins = await this.allQuery(`SELECT id FROM users WHERE role = 'admin'`);
            const from = await this._systemSenderId();
            for (const a of admins) {
                if (a.id === from && admins.length > 1) continue;
                await this.notifyUser(a.id, body, from);
            }
        } catch (e) {
            console.warn('[PaymentService] notifyAdmins failed:', e.message);
        }
    }

    /**
     * Mark an intent PAID: update intent, move all invoice orders to 'processing',
     * notify buyer + vendors. Single code path for worker and admin approval.
     */
    async markPaid(intentId, source = 'auto', note = null, adminId = null) {
        const ctx = await this.getIntentContext(intentId);
        if (!ctx) throw new Error('Intent not found');
        if (ctx.status === 'PAID') return ctx;
        if (ctx.status === 'REJECTED') throw new Error('Intent was rejected; cannot mark paid');

        const now = new Date().toISOString();
        await this.runQuery(
            `UPDATE payment_intents SET status = 'PAID', updated_at = ?, reviewed_by = COALESCE(?, reviewed_by),
             reviewed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE reviewed_at END, admin_note = COALESCE(?, admin_note)
             WHERE id = ?`,
            [now, adminId, adminId, now, note, intentId]
        );
        await this._logEvent(intentId, 'STATUS_UPDATE', ctx.status, 'PAID', { source, note });

        await this.runQuery(
            `UPDATE orders SET status = 'processing' WHERE invoice_id = ? AND user_id = ? AND status = 'pending'`,
            [ctx.invoice_id, ctx.buyer_id]
        );

        await this.notifyUser(ctx.buyer_id,
            `Payment confirmed for Invoice #${ctx.invoice_id}${source === 'admin' ? ' (verified manually by our team)' : ''}. Your order is now processing. You can follow progress in Order History.`);

        const vendors = await this.allQuery(`
            SELECT DISTINCT p.vendor_id, p.name FROM orders o JOIN products p ON o.product_id = p.id
            WHERE o.invoice_id = ? AND o.user_id = ?`, [ctx.invoice_id, ctx.buyer_id]);
        for (const v of vendors) {
            if (v.vendor_id) {
                await this.notifyUser(v.vendor_id,
                    `Payment received for Invoice #${ctx.invoice_id} ("${v.name}"). The order is now PROCESSING — please fulfil it.`, ctx.buyer_id);
            }
        }
        return this.getQuery(`SELECT * FROM payment_intents WHERE id = ?`, [intentId]);
    }

    /**
     * Escalate to admin manual review (fail-safe).
     */
    async sendToReview(intentId, reason) {
        const ctx = await this.getIntentContext(intentId);
        if (!ctx) throw new Error('Intent not found');
        if (FINAL_STATUSES.includes(ctx.status) || ctx.status === 'MANUAL_REVIEW') return;
        await this.runQuery(
            `UPDATE payment_intents SET status = 'MANUAL_REVIEW', review_reason = ?, updated_at = ? WHERE id = ?`,
            [reason, new Date().toISOString(), intentId]
        );
        await this._logEvent(intentId, 'STATUS_UPDATE', ctx.status, 'MANUAL_REVIEW', { reason });
        await this.notifyUser(ctx.buyer_id,
            `Your payment for Invoice #${ctx.invoice_id} could not be confirmed automatically, so it has been passed to our team for manual verification. No action is needed — you will receive a message as soon as it is reviewed (usually within a few hours).`);
        await this.notifyAdmins(`[Payment Review] Invoice #${ctx.invoice_id} needs manual verification. Reason: ${reason}. Open Admin → Payments.`);
    }

    /**
     * Release an address back to the pool when an intent is closed without payment.
     * Safe to call on intents that never had a pool address — the UPDATE is a no-op.
     */
    async _releasePoolAddress(paymentAddress, currency) {
        try {
            if (!paymentAddress || !currency) return;
            await this.runQuery(
                `UPDATE address_pool SET is_used = 0, assigned_order_id = NULL WHERE address = ? AND currency = ?`,
                [paymentAddress, currency]
            );
        } catch (e) {
            console.warn('[PaymentService] _releasePoolAddress failed:', e.message);
        }
    }

    async rejectIntent(intentId, reason, adminId = null) {
        const ctx = await this.getIntentContext(intentId);
        if (!ctx) throw new Error('Intent not found');
        if (['PAID', 'CONFIRMED', 'OVERPAID'].includes(ctx.status)) throw new Error('Intent already paid');
        const now = new Date().toISOString();
        await this.runQuery(
            `UPDATE payment_intents SET status = 'REJECTED', admin_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`,
            [reason, adminId, now, now, intentId]
        );
        await this._logEvent(intentId, 'STATUS_UPDATE', ctx.status, 'REJECTED', { reason });
        await this.runQuery(`UPDATE orders SET status = 'cancelled' WHERE invoice_id = ? AND user_id = ? AND status = 'pending'`, [ctx.invoice_id, ctx.buyer_id]);
        // Free the address so it can be reused for future orders
        await this._releasePoolAddress(ctx.payment_address, ctx.currency);
        await this.notifyUser(ctx.buyer_id,
            `Your payment for Invoice #${ctx.invoice_id} could not be verified and has been closed. Reason: ${reason || 'No matching transaction found'}. If you believe this is a mistake, reply to this message or contact Support with your transaction hash.`);
    }

    async expireIntent(intentId, reason = 'Time expired without payment') {
        const ctx = await this.getIntentContext(intentId);
        if (!ctx || FINAL_STATUSES.includes(ctx.status) || ctx.status === 'EXPIRED' || ctx.status === 'MANUAL_REVIEW') return;
        await this.updatePaymentStatus(intentId, PaymentStatus.EXPIRED, { reason });
        // Free the address so it can be reused for a new order attempt
        await this._releasePoolAddress(ctx.payment_address, ctx.currency);
        await this.notifyUser(ctx.buyer_id,
            `The payment window for Invoice #${ctx.invoice_id} has expired. Do NOT send funds to that address anymore. If you already paid, open the invoice and click "I already paid" to submit your transaction hash for review, or place the order again.`);
    }

    async _logEvent(paymentIntentId, eventType, oldStatus, newStatus, metadata = null) {
        await this.runQuery(
            `INSERT INTO payment_events (payment_intent_id, event_type, old_status, new_status, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                paymentIntentId, eventType, oldStatus, newStatus, 
                metadata ? JSON.stringify(metadata) : null, 
                new Date().toISOString()
            ]
        );
    }
}

module.exports = {
    PaymentService,
    PaymentStatus,
    SupportedCurrencies,
    VerificationConfig,
    FINAL_STATUSES,
    computeViewState
};
