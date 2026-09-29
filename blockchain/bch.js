const axios = require('axios');
const { PaymentStatus } = require('../services/paymentService');

class BitcoinCashAdapter {
    constructor(rpcUrl, rpcUser, rpcPass, mockClient = null) {
        this.apiBase = 'https://api.blockchair.com/bitcoin-cash';
        this.timeout = 10000; // 10 second timeout
    }

    bchToSatoshis(bchValue) {
        return BigInt(Math.round(bchValue * 100000000));
    }

    normalizeAddress(address) {
        if (!address) return null;
        let norm = address.toLowerCase().trim();
        if (norm.startsWith('bitcoincash:')) {
            norm = norm.replace('bitcoincash:', '');
        }
        return norm;
    }

    async findTransactionsByAddress(address) {
        try {
            const norm = this.normalizeAddress(address);
            const response = await axios.get(`${this.apiBase}/dashboards/address/${norm}`, { timeout: this.timeout });
            if (response.data && response.data.data && response.data.data[norm]) {
                return response.data.data[norm].transactions || [];
            }
            return [];
        } catch (error) {
            console.error(`Blockchair API error (find txs for ${address}):`, error.message);
            return [];
        }
    }

    async verifyTransaction(txid, expectedAddress, expectedAmountSatsStr, expectedNetwork, requiredConfirmations) {
        try {
            const response = await axios.get(`${this.apiBase}/dashboards/transaction/${txid}`, { timeout: this.timeout });
            const data = response.data.data[txid];
            if (!data) {
                return { status: PaymentStatus.WAITING_FOR_PAYMENT, receivedAmountCrypto: '0', confirmations: 0 };
            }

            const tx = data.transaction;
            const outputs = data.outputs;

            let totalReceivedSats = 0n;
            let sentToExpectedAddress = false;
            const normExpected = this.normalizeAddress(expectedAddress);

            for (const output of outputs) {
                const normOutput = this.normalizeAddress(output.recipient);
                if (normOutput && normExpected && normOutput === normExpected) {
                    sentToExpectedAddress = true;
                    totalReceivedSats += BigInt(output.value); // API returns satoshis natively
                }
            }

            if (!sentToExpectedAddress) {
                return { status: PaymentStatus.WRONG_ADDRESS, receivedAmountCrypto: '0', confirmations: 0 };
            }

            const receivedAmountCryptoStr = totalReceivedSats.toString();
            const expectedAmountSats = BigInt(expectedAmountSatsStr);

            let status = null;
            if (totalReceivedSats < expectedAmountSats) {
                status = PaymentStatus.UNDERPAID;
            } else {
                status = PaymentStatus.CONFIRMING;
            }

            // Calculate confirmations
            let confirmations = 0;
            if (tx.block_id && tx.block_id !== -1) {
                const statsResponse = await axios.get(`${this.apiBase}/stats`, { timeout: this.timeout });
                const currentHeight = statsResponse.data.data.blocks;
                confirmations = (currentHeight - tx.block_id) + 1;
            }

            if (confirmations >= requiredConfirmations && status !== PaymentStatus.UNDERPAID) {
                if (totalReceivedSats > expectedAmountSats) {
                    status = PaymentStatus.OVERPAID;
                } else {
                    status = PaymentStatus.CONFIRMED;
                }
            } else if (confirmations === 0 && status !== PaymentStatus.UNDERPAID) {
                status = PaymentStatus.TRANSACTION_DETECTED;
            }

            return {
                status,
                receivedAmountCrypto: receivedAmountCryptoStr,
                confirmations
            };

        } catch (error) {
            throw new Error(`Blockchair API Error verifying BCH transaction: ${error.message}`);
        }
    }
}

module.exports = {
    BitcoinCashAdapter
};
