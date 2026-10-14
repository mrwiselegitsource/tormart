const axios = require('axios');
const { PaymentStatus } = require('../services/paymentService');

class BitcoinAdapter {
    constructor() {
        // ── Ordered by confirmed reachability from this server ──────────────
        // blockstream.info uses the same Esplora API format as mempool.space
        this.esploraEndpoints = [
            'https://blockstream.info/api',
            'https://mempool.space/api',
            'https://mempool.emzy.de/api'
        ];
        this.timeout = 15000;
    }

    btcToSatoshis(btcValue) {
        return BigInt(Math.round(btcValue * 100000000));
    }

    // Try each Esplora endpoint in order; throw the last error if all fail
    async esploraGet(path) {
        let lastError = null;
        for (const base of this.esploraEndpoints) {
            try {
                const res = await axios.get(`${base}${path}`, { timeout: this.timeout });
                return res;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError;
    }

    // blockchain.info fallback for address transaction lookups (different format)
    async blockchainInfoTxids(address) {
        try {
            const res = await axios.get(
                `https://blockchain.info/rawaddr/${encodeURIComponent(address)}?limit=50&filter=5`,
                { timeout: this.timeout }
            );
            const txs = (res.data && Array.isArray(res.data.txs)) ? res.data.txs : [];
            return txs.map(tx => tx.hash).filter(Boolean);
        } catch (err) {
            console.warn(`blockchain.info address fallback failed for ${address}:`, err.message);
            return null; // null = also failed
        }
    }

    /**
     * Returns an array of txids that have been sent to `address`.
     * Tries Esplora APIs first, then blockchain.info as a final fallback.
     */
    async findTransactionsByAddress(address) {
        // ── Try Esplora (blockstream / mempool) ──────────────────────────────
        try {
            const res = await this.esploraGet(`/address/${address}/txs`);
            if (Array.isArray(res.data)) {
                return res.data.map(tx => tx.txid).filter(Boolean);
            }
        } catch (err) {
            console.warn(`Esplora address lookup failed for ${address}:`, err.message);
        }

        // ── blockchain.info fallback ─────────────────────────────────────────
        const fallbackTxids = await this.blockchainInfoTxids(address);
        if (fallbackTxids !== null) return fallbackTxids;

        console.error(`All APIs failed for address lookup: ${address}`);
        return [];
    }

    /**
     * Verify a specific txid: checks it paid the expected address and amount.
     * Uses Esplora (blockstream → mempool fallback) which has a consistent format.
     */
    async verifyTransaction(txid, expectedAddress, expectedAmountSatsStr, expectedNetwork, requiredConfirmations) {
        try {
            // Fetch raw transaction
            const txRes  = await this.esploraGet(`/tx/${txid}`);
            const tx     = txRes.data;

            // Fetch current block height for confirmation count
            const heightRes    = await this.esploraGet(`/blocks/tip/height`);
            const currentHeight = Number(heightRes.data);

            let totalReceivedSats   = 0n;
            let sentToExpectedAddr  = false;

            if (tx.vout && Array.isArray(tx.vout)) {
                for (const output of tx.vout) {
                    // Esplora returns scriptpubkey_address; normalise case for comparison
                    const outAddr = (output.scriptpubkey_address || '').toLowerCase();
                    if (outAddr && outAddr === expectedAddress.toLowerCase()) {
                        sentToExpectedAddr  = true;
                        totalReceivedSats  += BigInt(output.value); // sats natively in Esplora
                    }
                }
            }

            if (!sentToExpectedAddr) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            const expectedAmountSats = BigInt(expectedAmountSatsStr);
            let confirmations = 0;
            if (tx.status && tx.status.confirmed && tx.status.block_height) {
                confirmations = (currentHeight - tx.status.block_height) + 1;
                if (confirmations < 0) confirmations = 0;
            }

            let status;
            if (totalReceivedSats < expectedAmountSats) {
                status = confirmations >= requiredConfirmations
                    ? PaymentStatus.UNDERPAID
                    : PaymentStatus.TRANSACTION_DETECTED;
            } else if (confirmations >= requiredConfirmations) {
                status = totalReceivedSats > expectedAmountSats
                    ? PaymentStatus.OVERPAID
                    : PaymentStatus.CONFIRMED;
            } else if (confirmations > 0) {
                status = PaymentStatus.CONFIRMING;
            } else {
                status = PaymentStatus.TRANSACTION_DETECTED;
            }

            return {
                status,
                receivedAmountCrypto: totalReceivedSats.toString(),
                confirmations
            };
        } catch (error) {
            throw new Error(`BTC verification failed: ${error.message}`);
        }
    }
}

module.exports = { BitcoinAdapter };

