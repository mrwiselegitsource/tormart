const axios = require('axios');
const { PaymentStatus } = require('../services/paymentService');

class MoneroAdapter {
    constructor(rpcUrl, rpcUser, rpcPass, mockClient = null) {
        if (mockClient) {
            this.client = mockClient;
        } else if (rpcUrl) {
            // Note: Monero wallet RPC typically uses Digest Auth. For a simple axios client,
            // standard Basic auth can be passed if the RPC is behind a proxy, or digest auth
            // via a plugin. For architecture purposes, we pass auth directly.
            this.client = axios.create({
                baseURL: rpcUrl,
                auth: (rpcUser && rpcPass) ? { username: rpcUser, password: rpcPass } : undefined,
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            throw new Error("MoneroAdapter requires rpc configuration or a mockClient");
        }
    }

    async rpcCall(method, params = {}) {
        if (typeof this.client === 'function' || this.client.rpcCall) {
            return this.client.rpcCall ? this.client.rpcCall(method, params) : this.client(method, params);
        }

        const payload = {
            jsonrpc: '2.0',
            id: 'xmr-adapter',
            method: method,
            params: params
        };

        try {
            const response = await this.client.post('/json_rpc', payload);
            if (response.data && response.data.error) {
                throw new Error(response.data.error.message || 'RPC Error');
            }
            return response.data.result;
        } catch (error) {
            if (error.response && error.response.data && error.response.data.error) {
                throw new Error(error.response.data.error.message);
            }
            throw new Error(`RPC Request failed: ${error.message}`);
        }
    }

    /**
     * Converts XMR float to atomic units (piconero)
     * @param {number} xmrValue 
     * @returns {BigInt}
     */
    xmrToAtomicUnits(xmrValue) {
        return BigInt(Math.round(xmrValue * 1e12));
    }

    /**
     * Generates a unique Monero subaddress for a specific account (default account 0)
     * @param {number} accountIndex - Typically 0
     * @returns {Promise<string>} The new subaddress
     */
    async createPaymentAddress(accountIndex = 0) {
        try {
            const result = await this.rpcCall('create_address', { account_index: accountIndex });
            if (result && result.address) {
                return result.address;
            }
            throw new Error("Invalid response from create_address");
        } catch (error) {
            throw new Error(`Failed to create XMR payment address: ${error.message}`);
        }
    }

    /**
     * Verifies a Monero transaction by looking it up in the wallet.
     * Unlike BTC/ETH, XMR requires the wallet RPC to decode the txid.
     * @param {string} txid - The transaction hash
     * @param {string} expectedAddress - The generated subaddress for the order
     * @param {string} expectedAmountAtomicStr - The expected amount in atomic units
     * @param {number} requiredConfirmations - Required confirmations (typically 10 for XMR)
     * @returns {Promise<Object>} Verification result with status and amounts
     */
    async verifyTransaction(txid, expectedAddress, expectedAmountAtomicStr, requiredConfirmations) {
        try {
            let result;
            try {
                result = await this.rpcCall('get_transfer_by_txid', { txid: txid });
            } catch (err) {
                // Monero RPC throws "transaction not found" if the TXID doesn't belong to the wallet
                if (err.message.includes("not found") || err.message.includes("Transaction not found")) {
                    return { status: PaymentStatus.WAITING_FOR_PAYMENT, receivedAmountCrypto: '0', confirmations: 0 };
                }
                throw err;
            }

            const transfer = result.transfer;
            if (!transfer) {
                return { status: PaymentStatus.WAITING_FOR_PAYMENT, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // Verify it was received (type "in" or "pool")
            if (transfer.type !== 'in' && transfer.type !== 'pool') {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // Check if it was sent to the expected address
            // transfer.address contains the receiving subaddress
            if (transfer.address !== expectedAddress) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            // In monero RPC, transfer.amount is usually provided in atomic units natively as an integer, 
            // but JS might parse it as a Number. We ensure safe BigInt casting.
            const receivedAmountAtomic = BigInt(transfer.amount);
            const expectedAmountAtomic = BigInt(expectedAmountAtomicStr);

            let status = null;
            if (receivedAmountAtomic < expectedAmountAtomic) {
                status = PaymentStatus.UNDERPAID;
            } else {
                status = PaymentStatus.CONFIRMING;
            }

            const confirmations = transfer.confirmations || 0;

            if (confirmations >= requiredConfirmations && status !== PaymentStatus.UNDERPAID) {
                if (receivedAmountAtomic > expectedAmountAtomic) {
                    status = PaymentStatus.OVERPAID;
                } else {
                    status = PaymentStatus.CONFIRMED;
                }
            } else if (confirmations === 0 && status !== PaymentStatus.UNDERPAID) {
                status = PaymentStatus.TRANSACTION_DETECTED;
            }

            return {
                status,
                receivedAmountCrypto: receivedAmountAtomic.toString(),
                confirmations
            };

        } catch (error) {
            throw new Error(`RPC Error verifying XMR transaction: ${error.message}`);
        }
    }
}

module.exports = {
    MoneroAdapter
};
