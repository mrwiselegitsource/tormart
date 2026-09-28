const assert = require('assert');
const { BitcoinAdapter } = require('../blockchain/btc');
const { PaymentStatus } = require('../services/paymentService');

async function runTests() {
    console.log("Starting BitcoinAdapter tests...");

    // Helper to create a mock RPC client
    const createMockClient = (rpcResponses) => {
        return {
            rpcCall: async (method, params) => {
                if (method in rpcResponses) {
                    if (typeof rpcResponses[method] === 'function') {
                        return rpcResponses[method](params);
                    }
                    return rpcResponses[method];
                }
                throw new Error(`Mock missing method ${method}`);
            }
        };
    };

    const expectedAddress = "bc1qtest1234567890abcdef";
    const expectedAmountSats = "100000000"; // 1 BTC
    const expectedNetwork = "mainnet";
    const requiredConfirmations = 3;

    try {
        // Test 1: Wrong Network
        console.log("Test 1: Wrong Network");
        let adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: "testnet" }
        }));
        let res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_NETWORK);
        console.log("Test 1 Passed");

        // Test 2: Transaction Not Found (RPC returns null)
        console.log("Test 2: Transaction Not Found");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: null
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        // Test 3: Wrong Destination Address
        console.log("Test 3: Wrong Destination");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [{ value: 1.0, scriptPubKey: { address: "bc1qWRONG" } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_ADDRESS);
        console.log("Test 3 Passed");

        // Test 4: Underpayment & Multiple Outputs
        console.log("Test 4: Underpayment (Multiple Outputs)");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [
                    { value: 0.2, scriptPubKey: { address: expectedAddress } },
                    { value: 0.3, scriptPubKey: { address: expectedAddress } },
                    { value: 5.0, scriptPubKey: { address: "bc1qCHANGE" } }
                ]
            }
        }));
        // Total sent is 0.5 BTC = 50,000,000 sats
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "50000000");
        console.log("Test 4 Passed");

        // Test 5: Overpayment
        console.log("Test 5: Overpayment");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 3,
                vout: [{ value: 1.5, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.OVERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "150000000");
        console.log("Test 5 Passed");

        // Test 6: Zero/Invalid Amount
        console.log("Test 6: Zero Amount");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [{ value: 0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "0");
        console.log("Test 6 Passed");

        // Test 7: Unconfirmed Transaction
        console.log("Test 7: Unconfirmed Transaction");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 0,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.TRANSACTION_DETECTED); // 0 confs
        assert.strictEqual(res.confirmations, 0);
        console.log("Test 7 Passed");

        // Test 8: Confirming Transaction (1 < required)
        console.log("Test 8: Confirming Transaction");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 2,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMING);
        assert.strictEqual(res.confirmations, 2);
        console.log("Test 8 Passed");

        // Test 9: Confirmed Transaction
        console.log("Test 9: Confirmed Transaction");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 3,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMED);
        assert.strictEqual(res.confirmations, 3);
        console.log("Test 9 Passed");

        // Test 10: Malformed TXID (RPC error)
        console.log("Test 10: Malformed TXID");
        adapter = new BitcoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: (params) => {
                if (params[0] === 'malformed') throw new Error("Invalid txid");
                return null;
            }
        }));
        try {
            await adapter.verifyTransaction('malformed', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
            assert.fail("Should have thrown error");
        } catch (err) {
            assert.ok(err.message.includes("RPC Error verifying BTC transaction"));
        }
        console.log("Test 10 Passed");

        console.log("All BitcoinAdapter tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
