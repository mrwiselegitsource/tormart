const assert = require('assert');
const { LitecoinAdapter } = require('../blockchain/ltc');
const { PaymentStatus } = require('../services/paymentService');

async function runTests() {
    console.log("Starting LitecoinAdapter tests...");

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

    const expectedAddress = "ltc1qtest1234567890abcdef";
    const expectedAmountLitoshis = "100000000"; // 1 LTC
    const expectedNetwork = "mainnet";
    const requiredConfirmations = 4;

    try {
        // Test 1: Wrong Network
        console.log("Test 1: Wrong Network");
        let adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: "testnet" }
        }));
        let res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_NETWORK);
        console.log("Test 1 Passed");

        // Test 2: Transaction Not Found (RPC returns null)
        console.log("Test 2: Transaction Not Found");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: null
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        // Test 3: Wrong Destination Address
        console.log("Test 3: Wrong Destination");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [{ value: 1.0, scriptPubKey: { address: "ltc1qWRONG" } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_ADDRESS);
        console.log("Test 3 Passed");

        // Test 4: Underpayment & Multiple Outputs
        console.log("Test 4: Underpayment (Multiple Outputs)");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [
                    { value: 0.2, scriptPubKey: { address: expectedAddress } },
                    { value: 0.3, scriptPubKey: { address: expectedAddress } },
                    { value: 5.0, scriptPubKey: { address: "ltc1qCHANGE" } }
                ]
            }
        }));
        // Total sent is 0.5 LTC = 50,000,000 litoshis
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "50000000");
        console.log("Test 4 Passed");

        // Test 5: Overpayment
        console.log("Test 5: Overpayment");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 4,
                vout: [{ value: 1.5, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.OVERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "150000000");
        console.log("Test 5 Passed");

        // Test 6: Zero/Invalid Amount
        console.log("Test 6: Zero Amount");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [{ value: 0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "0");
        console.log("Test 6 Passed");

        // Test 7: Unconfirmed Transaction
        console.log("Test 7: Unconfirmed Transaction");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 0,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.TRANSACTION_DETECTED); // 0 confs
        assert.strictEqual(res.confirmations, 0);
        console.log("Test 7 Passed");

        // Test 8: Confirming Transaction (2 < required 4)
        console.log("Test 8: Confirming Transaction");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 2,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMING);
        assert.strictEqual(res.confirmations, 2);
        console.log("Test 8 Passed");

        // Test 9: Confirmed Transaction
        console.log("Test 9: Confirmed Transaction");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 4,
                vout: [{ value: 1.0, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMED);
        assert.strictEqual(res.confirmations, 4);
        console.log("Test 9 Passed");

        // Test 10: Malformed TXID (RPC error)
        console.log("Test 10: Malformed TXID");
        adapter = new LitecoinAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: (params) => {
                if (params[0] === 'malformed') throw new Error("Invalid txid");
                return null;
            }
        }));
        try {
            await adapter.verifyTransaction('malformed', expectedAddress, expectedAmountLitoshis, expectedNetwork, requiredConfirmations);
            assert.fail("Should have thrown error");
        } catch (err) {
            assert.ok(err.message.includes("RPC Error verifying LTC transaction"));
        }
        console.log("Test 10 Passed");

        console.log("All LitecoinAdapter tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
