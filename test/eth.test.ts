import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ForkName } from "@lodestar/params";
import { CompactMultiProof, ProofType, Tree, createProof, zeroNode } from "@chainsafe/persistent-merkle-tree";
import { fromHexString, toHexString } from "@chainsafe/ssz";
import { EthAPI } from "../src/eth.js";
import { LodestarError, UnsupportedForkError } from "../src/errors.js";

const stateRoot = `0x${"11".repeat(32)}`;
const blockRoot = `0x${"22".repeat(32)}`;
const emptyRoot = `0x${"00".repeat(32)}`;

async function fixture(t: { after(callback: () => void | Promise<void>): void }) {
    const state = {
        spec: {
            SLOTS_PER_EPOCH: "8",
            GENESIS_FORK_VERSION: "0x00000042",
            FULU_FORK_VERSION: "0x06000042",
            FULU_FORK_EPOCH: "2",
            GLOAS_FORK_VERSION: "0x07000042",
            GLOAS_FORK_EPOCH: "3",
        } as Record<string, string>,
        specStatus: 200,
        specRequests: 0,
        stateVersion: "0x07000042",
        headerSlot: "24",
        proofVersion: "gloas",
        binaryProof: false,
        tree: new Tree(zeroNode(3)),
        paths: [] as string[],
    };
    const server = createServer((req, res) => {
        const url = new URL(req.url!, "http://localhost");
        state.paths.push(url.pathname);
        const send = (value: object, status = 200) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify({ execution_optimistic: false, finalized: false, ...value }));
        };
        if (url.pathname === "/eth/v1/config/spec") {
            state.specRequests++;
            if (state.specStatus !== 200) return send({ code: state.specStatus, message: "Spec unavailable" }, state.specStatus);
            return send({ data: state.spec });
        }
        if (/^\/eth\/v1\/beacon\/states\/[^/]+\/fork$/.test(url.pathname)) {
            return send({ data: { previous_version: "0x06000042", current_version: state.stateVersion, epoch: "3" } });
        }
        if (/^\/eth\/v1\/beacon\/states\/[^/]+\/root$/.test(url.pathname)) {
            return send({ data: { root: stateRoot } });
        }
        if (/^\/eth\/v1\/beacon\/headers\/[^/]+$/.test(url.pathname)) {
            return send({ data: {
                root: blockRoot,
                canonical: true,
                header: {
                    message: {
                        slot: state.headerSlot,
                        proposer_index: "0",
                        parent_root: emptyRoot,
                        state_root: stateRoot,
                        body_root: emptyRoot,
                    },
                    signature: `0x${"00".repeat(96)}`,
                },
            } });
        }
        if (/^\/eth\/v0\/beacon\/proof\/(state|block)\/[^/]+$/.test(url.pathname)) {
            const descriptor = fromHexString(url.searchParams.get("format")!);
            const proof = createProof(state.tree.rootNode, { type: ProofType.compactMulti, descriptor }) as CompactMultiProof;
            if (state.binaryProof) {
                // The public route codec is also used by a real Lodestar server.
                res.writeHead(200, { "content-type": "application/octet-stream", "eth-consensus-version": state.proofVersion });
                import("@lodestar/api").then(({ routes }) => {
                    res.end(routes.proof.CompactMultiProofType.serialize(proof));
                }).catch((error) => res.destroy(error));
                return;
            }
            return send({ version: state.proofVersion, data: {
                leaves: proof.leaves.map(toHexString),
                descriptor: toHexString(proof.descriptor),
            } });
        }
        send({ code: 404, message: "Unexpected test request" }, 404);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    return { state, api: new EthAPI(`http://127.0.0.1:${address.port}`, "mainnet") };
}

test("numeric state IDs use the node's named schedule and actual slots per epoch", async (t) => {
    const { api, state } = await fixture(t);
    assert.equal(await api.getForkNameByStateId("0"), ForkName.phase0);
    assert.equal(await api.getForkNameByStateId("15"), ForkName.phase0);
    assert.equal(await api.getForkNameByStateId("16"), ForkName.fulu);
    assert.equal(await api.getForkNameByStateId("23"), ForkName.fulu);
    assert.equal(await api.getForkNameByStateId("24"), ForkName.gloas);
    assert.equal(state.specRequests, 1);
    assert.deepEqual(state.paths, ["/eth/v1/config/spec"]);
});

test("state-root fork resolution matches the node's custom version without treating it as a block root", async (t) => {
    const { api, state } = await fixture(t);
    assert.equal(await api.getForkNameByStateId(stateRoot), ForkName.gloas);
    state.stateVersion = "0x06000042";
    assert.equal(await api.getForkNameByStateId(stateRoot), ForkName.fulu);
    assert(state.paths.includes(`/eth/v1/beacon/states/${stateRoot}/fork`));
    assert(!state.paths.some((path) => path.includes("/headers/")));
    assert(!state.paths.some((path) => path.includes("fork_schedule")));
});

test("unknown state versions fail closed instead of falling back to schedule positions", async (t) => {
    const { api, state } = await fixture(t);
    state.stateVersion = "0xff000042";
    await assert.rejects(api.getForkNameByStateId(stateRoot), (error: unknown) =>
        error instanceof UnsupportedForkError && error.code === 502 && /0xff000042/.test(error.message));
    assert(!state.paths.some((path) => path.includes("/headers/") || path.includes("fork_schedule")));
});

test("unknown named forks are rejected only once active, including tied epochs", async (t) => {
    const { api, state } = await fixture(t);
    state.spec.FUTURE_FORK_VERSION = "0xff000042";
    state.spec.FUTURE_FORK_EPOCH = "3";
    assert.equal(await api.getForkNameByStateId("23"), ForkName.fulu);
    await assert.rejects(api.getForkNameByStateId("24"), UnsupportedForkError);
    state.stateVersion = "0xff000042";
    await assert.rejects(api.getForkNameByStateId(stateRoot), UnsupportedForkError);
});

test("block IDs resolve forks from the header slot and node spec", async (t) => {
    const { api, state } = await fixture(t);
    state.headerSlot = "23";
    assert.equal(await api.getForkNameByBlockId(blockRoot), ForkName.fulu);
    state.headerSlot = "24";
    assert.equal(await api.getForkNameByBlockId(blockRoot), ForkName.gloas);
    assert.equal(state.specRequests, 1);
    assert(!state.paths.some((path) => /\/states\/.+\/fork/.test(path)));
});

test("mutable aliases are pinned through state roots and block header roots", async (t) => {
    const { api, state } = await fixture(t);
    for (const alias of ["head", "finalized", "justified"]) {
        assert.equal(await api.resolveStateId(alias), stateRoot);
        assert.equal(await api.resolveBlockId(alias), blockRoot);
    }
    const requests = state.paths.length;
    for (const id of ["24", stateRoot, "genesis"]) {
        assert.equal(await api.resolveStateId(id), id);
        assert.equal(await api.resolveBlockId(id), id);
    }
    assert.equal(state.paths.length, requests);
});

test("node spec loads are shared, cached, and refreshed after the bounded lifetime", async (t) => {
    const { api, state } = await fixture(t);
    await Promise.all([api.getForkNameByStateId("24"), api.getForkNameByStateId("24")]);
    assert.equal(state.specRequests, 1);
    state.spec.GLOAS_FORK_EPOCH = "4";
    assert.equal(await api.getForkNameByStateId("24"), ForkName.gloas);
    const now = Date.now;
    Date.now = () => now() + 61_000;
    t.after(() => { Date.now = now; });
    assert.equal(await api.getForkNameByStateId("24"), ForkName.fulu);
    assert.equal(state.specRequests, 2);
});

test("failed spec requests retry on the next call and never use a bundled fallback", async (t) => {
    const { api, state } = await fixture(t);
    state.specStatus = 503;
    await assert.rejects(api.getForkNameByStateId("24"), (error: unknown) => error instanceof LodestarError && error.code === 503);
    const failedRequests = state.specRequests;
    state.specStatus = 200;
    assert.equal(await api.getForkNameByStateId("24"), ForkName.gloas);
    assert.equal(state.specRequests, failedRequests + 1);
});

test("invalid spec values fail closed and failed parsing is not cached", async (t) => {
    const { api, state } = await fixture(t);
    state.spec.SLOTS_PER_EPOCH = "0";
    await assert.rejects(api.getForkNameByStateId("24"), UnsupportedForkError);
    state.spec.SLOTS_PER_EPOCH = "8";
    state.spec.GLOAS_FORK_VERSION = "not-a-version";
    await assert.rejects(api.getForkNameByStateId("24"), UnsupportedForkError);
    state.spec.GLOAS_FORK_VERSION = "0x07000042";
    assert.equal(await api.getForkNameByStateId("24"), ForkName.gloas);
    assert.equal(state.specRequests, 3);
});

test("path fork resolution rejects a minimal-preset node without affecting raw proofs", async (t) => {
    const { api, state } = await fixture(t);
    state.spec.PRESET_BASE = "minimal";
    await assert.rejects(api.getForkNameByStateId("24"), UnsupportedForkError);
    const proof = await api.getStateProof(stateRoot, 5n);
    assert.deepEqual(Tree.createFromProof(proof).root, state.tree.root);
    state.spec.PRESET_BASE = "mainnet";
    assert.equal(await api.getForkNameByStateId("24"), ForkName.gloas);
});

test("compact proofs preserve bigint gindices above Number.MAX_SAFE_INTEGER", async (t) => {
    const { api, state } = await fixture(t);
    const gindex = (BigInt(1) << BigInt(56)) + BigInt(12345);
    state.tree = new Tree(zeroNode(56));
    state.tree.setRoot(gindex, new Uint8Array(32).fill(7));
    const proof = await api.getStateProof(stateRoot, gindex, ForkName.gloas);
    assert.equal(proof.gindex, gindex);
    assert.deepEqual(proof.leaf, new Uint8Array(32).fill(7));
    assert.equal(proof.witnesses.length, 56);
    assert.deepEqual(Tree.createFromProof(proof).root, state.tree.root);
    assert.equal(state.specRequests, 0);
});

test("block compact proof requests reconstruct a single proof and enforce expected fork metadata", async (t) => {
    const { api, state } = await fixture(t);
    const gindex = BigInt(5);
    const proof = await api.getBlockProof(blockRoot, gindex, ForkName.gloas);
    assert.deepEqual(Tree.createFromProof(proof).root, state.tree.root);
    state.proofVersion = "fulu";
    await assert.rejects(api.getBlockProof(blockRoot, gindex, ForkName.gloas), UnsupportedForkError);
    await assert.rejects(api.getStateProof(stateRoot, gindex, ForkName.gloas), UnsupportedForkError);
});

test("raw-gindex compact proofs do not require recognized fork names or a spec lookup", async (t) => {
    const { api, state } = await fixture(t);
    state.proofVersion = "future-fork";
    state.specStatus = 503;
    for (const binary of [false, true]) {
        state.binaryProof = binary;
        const proof = await api.getStateProof(stateRoot, BigInt(5));
        assert.deepEqual(Tree.createFromProof(proof).root, state.tree.root);
        const blockProof = await api.getBlockProof(blockRoot, BigInt(5));
        assert.deepEqual(Tree.createFromProof(blockProof).root, state.tree.root);
        await assert.rejects(api.getStateProof(stateRoot, BigInt(5), ForkName.gloas), UnsupportedForkError);
    }
    assert.equal(state.specRequests, 0);
});

test("BEACON_TIMEOUT_MS accepts only positive safe integers", () => {
    const original = process.env.BEACON_TIMEOUT_MS;
    try {
        for (const invalid of ["0", "-1", "1.5", "NaN", "Infinity", "", "9007199254740992"]) {
            process.env.BEACON_TIMEOUT_MS = invalid;
            assert.throws(() => new EthAPI("http://localhost:5052", "mainnet"), /BEACON_TIMEOUT_MS/);
        }
        process.env.BEACON_TIMEOUT_MS = "120000";
        assert.doesNotThrow(() => new EthAPI("http://localhost:5052", "mainnet"));
    } finally {
        if (original === undefined) delete process.env.BEACON_TIMEOUT_MS;
        else process.env.BEACON_TIMEOUT_MS = original;
    }
});
