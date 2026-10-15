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
    /**
     * Fetch rich summary for a Bitcoin address (for admin display).
     * Returns: { address, confirmedBalanceSats, totalReceivedSats, totalSentSats,
     *            confirmedTxCount, mempoolTxCount, confirmedBalanceBtc,
     *            totalReceivedBtc, source }
     */
    async getAddressInfo(address) {
        // ── Try Esplora first (blockstream → mempool) ─────────────────────────
        try {
            const res = await this.esploraGet(`/address/${address}`);
            const d   = res.data;
            const chain   = d.chain_stats   || {};
            const mempool = d.mempool_stats  || {};

            const totalReceivedSats  = BigInt(chain.funded_txo_sum  || 0);
            const totalSentSats      = BigInt(chain.spent_txo_sum    || 0);
            const balanceSats        = totalReceivedSats - totalSentSats;
            // Add unconfirmed incoming
            const mempoolInSats      = BigInt(mempool.funded_txo_sum || 0);
            const mempoolOutSats     = BigInt(mempool.spent_txo_sum  || 0);
            const unconfirmedSats    = mempoolInSats - mempoolOutSats;

            return {
                address,
                confirmedBalanceSats : balanceSats.toString(),
                totalReceivedSats    : totalReceivedSats.toString(),
                totalSentSats        : totalSentSats.toString(),
                unconfirmedSats      : unconfirmedSats.toString(),
                confirmedBalanceBtc  : (Number(balanceSats)  / 1e8).toFixed(8),
                totalReceivedBtc     : (Number(totalReceivedSats) / 1e8).toFixed(8),
                unconfirmedBtc       : (Number(unconfirmedSats < 0n ? 0n : unconfirmedSats) / 1e8).toFixed(8),
                confirmedTxCount     : chain.tx_count   || 0,
                mempoolTxCount       : mempool.tx_count  || 0,
                source               : 'esplora'
            };
        } catch (err) {
            console.warn(`Esplora getAddressInfo failed for ${address}:`, err.message);
        }

        // ── blockchain.info fallback ─────────────────────────────────────────
        try {
            const res = await axios.get(
                `https://blockchain.info/rawaddr/${encodeURIComponent(address)}?limit=0`,
                { timeout: this.timeout }
            );
            const d = res.data || {};
            const totalReceivedSats = BigInt(d.total_received || 0);
            const totalSentSats     = BigInt(d.total_sent     || 0);
            const balanceSats       = BigInt(d.final_balance  || 0);

            return {
                address,
                confirmedBalanceSats : balanceSats.toString(),
                totalReceivedSats    : totalReceivedSats.toString(),
                totalSentSats        : totalSentSats.toString(),
                unconfirmedSats      : '0',
                confirmedBalanceBtc  : (Number(balanceSats)       / 1e8).toFixed(8),
                totalReceivedBtc     : (Number(totalReceivedSats) / 1e8).toFixed(8),
                unconfirmedBtc       : '0.00000000',
                confirmedTxCount     : d.n_tx || 0,
                mempoolTxCount       : 0,
                source               : 'blockchain.info'
            };
        } catch (err) {
            console.warn(`blockchain.info getAddressInfo failed for ${address}:`, err.message);
        }

        // All failed
        return { address, error: 'Could not reach any blockchain API', source: 'none' };
    }
}

module.exports = { BitcoinAdapter };
