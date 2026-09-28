const { z } = require('zod');
const crypto = require('crypto');

// --- CONSTANTS & STATUSES ---

const PaymentStatus = {
    PAYMENT_CREATED: 'PAYMENT_CREATED',
    WAITING_FOR_PAYMENT: 'WAITING_FOR_PAYMENT',
    TRANSACTION_DETECTED: 'TRANSACTION_DETECTED',
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
    CANCELLED: 'CANCELLED'
};

const SupportedCurrencies = ['BTC', 'BCH', 'LTC', 'ETH', 'XMR'];

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
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 mins from now
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
    SupportedCurrencies
};
