const assert = require('assert');
const { BitcoinCashAdapter } = require('../blockchain/bch');
const { PaymentStatus } = require('../services/paymentService');

async function runTests() {
    console.log("Starting BitcoinCashAdapter tests...");

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

    const expectedAddress = "bitcoincash:qzxqzptx27d6jcx76d7n4f5x5kcwkqkq8yqqq4zzzz";
    const expectedAmountSats = "100000000"; // 1 BCH
    const expectedNetwork = "mainnet";
    const requiredConfirmations = 2;

    try {
        // Test 1: Wrong Network
        console.log("Test 1: Wrong Network");
        let adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: "testnet" }
        }));
        let res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_NETWORK);
        console.log("Test 1 Passed");

        // Test 2: Transaction Not Found
        console.log("Test 2: Transaction Not Found");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: null
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WAITING_FOR_PAYMENT);
        console.log("Test 2 Passed");

        // Test 3: Wrong Destination Address
        console.log("Test 3: Wrong Destination");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [{ value: 1.0, scriptPubKey: { address: "bitcoincash:qwrongaddress" } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.WRONG_ADDRESS);
        console.log("Test 3 Passed");

        // Test 4: Address Formatting Confusion (Prefix Omitted in DB but Present in RPC)
        console.log("Test 4: Address Formatting Confusion (Prefix mismatch)");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 2,
                vout: [{ value: 1.0, scriptPubKey: { address: "bitcoincash:qzxqzptx27d6jcx76d7n4f5x5kcwkqkq8yqqq4zzzz" } }]
            }
        }));
        // Note: we pass expectedAddress without the prefix
        res = await adapter.verifyTransaction('txid123', "qzxqzptx27d6jcx76d7n4f5x5kcwkqkq8yqqq4zzzz", expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.CONFIRMED);
        console.log("Test 4 Passed");

        // Test 5: Underpayment & Multiple Outputs
        console.log("Test 5: Underpayment (Multiple Outputs)");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 1,
                vout: [
                    { value: 0.2, scriptPubKey: { address: expectedAddress } },
                    { value: 0.3, scriptPubKey: { address: expectedAddress } },
                    { value: 5.0, scriptPubKey: { address: "bitcoincash:qchangeaddress" } }
                ]
            }
        }));
        // Total sent is 0.5 BCH = 50,000,000 sats
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.UNDERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "50000000");
        console.log("Test 5 Passed");

        // Test 6: Overpayment
        console.log("Test 6: Overpayment");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
            getblockchaininfo: { chain: expectedNetwork },
            getrawtransaction: {
                confirmations: 2,
                vout: [{ value: 1.5, scriptPubKey: { address: expectedAddress } }]
            }
        }));
        res = await adapter.verifyTransaction('txid123', expectedAddress, expectedAmountSats, expectedNetwork, requiredConfirmations);
        assert.strictEqual(res.status, PaymentStatus.OVERPAID);
        assert.strictEqual(res.receivedAmountCrypto, "150000000");
        console.log("Test 6 Passed");

        // Test 7: Unconfirmed Transaction
        console.log("Test 7: Unconfirmed Transaction");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
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

        // Test 8: Malformed TXID (RPC error)
        console.log("Test 8: Malformed TXID");
        adapter = new BitcoinCashAdapter(null, null, null, createMockClient({
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
            assert.ok(err.message.includes("RPC Error verifying BCH transaction"));
        }
        console.log("Test 8 Passed");

        console.log("All BitcoinCashAdapter tests passed successfully!");
    } catch (err) {
        console.error("Test failed:", err);
        process.exit(1);
    }
}

runTests();
