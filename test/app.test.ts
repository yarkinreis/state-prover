import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ForkName } from "@lodestar/params";
import { ProofType } from "@chainsafe/persistent-merkle-tree";
import { createApp, type ProofClient } from "../src/app.js";
import { LodestarError, UnsupportedForkError } from "../src/errors.js";

const root = `0x${"ab".repeat(32)}`;
type Call = { method: string; id: string; gindex?: bigint; fork?: ForkName };

function mockClient() {
  const calls: Call[] = [];
  const client: ProofClient = {
    async resolveStateId(id) {
      calls.push({ method: "resolveStateId", id });
      return id === "head" ? root : id;
    },
    async resolveBlockId(id) {
      calls.push({ method: "resolveBlockId", id });
      return id === "head" ? root : id;
    },
    async getForkNameByStateId(id) {
      calls.push({ method: "getForkNameByStateId", id });
      return ForkName.gloas;
    },
    async getForkNameByBlockId(id) {
      calls.push({ method: "getForkNameByBlockId", id });
      return ForkName.gloas;
    },
    async getStateProof(id, gindex, fork) {
      calls.push({ method: "getStateProof", id, gindex, fork });
      return { type: ProofType.single, gindex, leaf: new Uint8Array(32).fill(1), witnesses: [] };
    },
    async getBlockProof(id, gindex, fork) {
      calls.push({ method: "getBlockProof", id, gindex, fork });
      return { type: ProofType.single, gindex, leaf: new Uint8Array(32).fill(2), witnesses: [] };
    },
  };
  return { client, calls };
}

async function serve(t: { after(callback: () => void | Promise<void>): void }, client: ProofClient) {
  const server = createServer(createApp({ hoodi: client }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return (path: string) => fetch(`http://127.0.0.1:${address.port}${path}`);
}

for (const kind of ["state", "block"] as const) {
  test(`${kind} raw proof preserves an unsafe-for-Number gindex without fork lookup`, async (t) => {
    const { client, calls } = mockClient();
    const request = await serve(t, client);
    const response = await request(`/${kind}_proof?network=hoodi&${kind}_id=42&gindex=9007199254740993`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: "single",
      gindex: "9007199254740993",
      leaf: `0x${(kind === "state" ? "01" : "02").repeat(32)}`,
      witnesses: [],
    });
    assert.deepEqual(calls, [
      { method: kind === "state" ? "resolveStateId" : "resolveBlockId", id: "42" },
      { method: kind === "state" ? "getStateProof" : "getBlockProof", id: "42", gindex: 9007199254740993n, fork: undefined },
    ]);
  });

  test(`${kind} path proof pins head before resolving the fork and requesting a proof`, async (t) => {
    const { client, calls } = mockClient();
    const request = await serve(t, client);
    const path = kind === "state" ? "validators" : "state_root";
    const response = await request(`/${kind}_proof?network=hoodi&${kind}_id=head&path=${path}`);
    assert.equal(response.status, 200);
    const data = await response.json() as { gindex: string };
    const expected = kind === "state" ? 358n : 11n;
    assert.equal(data.gindex, expected.toString());
    assert.deepEqual(calls, [
      { method: kind === "state" ? "resolveStateId" : "resolveBlockId", id: "head" },
      { method: kind === "state" ? "getForkNameByStateId" : "getForkNameByBlockId", id: root },
      { method: kind === "state" ? "getStateProof" : "getBlockProof", id: root, gindex: expected, fork: ForkName.gloas },
    ]);
  });
}

test("malformed and ambiguous queries return 400 before any upstream work", async (t) => {
  const { client, calls } = mockClient();
  const request = await serve(t, client);
  for (const query of [
    "state_id=42", "gindex=1", "state_id=42&gindex=0", "state_id=42&gindex=-1",
    "state_id=42&gindex=1.5", "state_id=42&gindex=Infinity", "state_id=42&gindex=1e3",
    "state_id=42&gindex=1&path=validators", "state_id=42&gindex=1&gindex=2",
    "state_id=42&gindex[foo]=1", "state_id=42&path=validators,,0", "state_id=42&path=",
    "state_id=head&state_id=finalized&gindex=1", "state_id=0x1234&gindex=1",
    "state_id=9007199254740993&gindex=1", "state_id=42&path=validators&path=balances",
  ]) {
    const response = await request(`/state_proof?network=hoodi&${query}`);
    assert.equal(response.status, 400, query);
    await response.text();
  }
  assert.deepEqual(calls, []);
});

test("unsupported, repeated, and unconfigured networks return 400", async (t) => {
  const { client, calls } = mockClient();
  const request = await serve(t, client);
  for (const network of ["network=unknown", "network=hoodi&network=mainnet", "network=mainnet", ""]) {
    const response = await request(`/state_proof?state_id=42&gindex=1&${network}`);
    assert.equal(response.status, 400, network);
    await response.text();
  }
  assert.deepEqual(calls, []);
});

test("has_state uses the root proof without resolving a fork", async (t) => {
  const { client, calls } = mockClient();
  const request = await serve(t, client);
  const response = await request("/has_state?network=hoodi&state_id=head");
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(calls, [
    { method: "resolveStateId", id: "head" },
    { method: "getStateProof", id: root, gindex: 1n, fork: undefined },
  ]);
});

test("HTTP responses preserve upstream failures and reject unsupported fork resolution", async (t) => {
  const { client } = mockClient();
  const request = await serve(t, client);
  client.getForkNameByStateId = async () => { throw new UnsupportedForkError("Unsupported beacon fork future"); };
  const unsupported = await request("/state_proof?network=hoodi&state_id=42&path=validators");
  assert.equal(unsupported.status, 502);
  assert.match(await unsupported.text(), /Unsupported beacon fork/);
  client.getStateProof = async () => {
    throw new LodestarError({ name: "ApiError", status: 404, operationId: "getStateProof", message: "State not available" });
  };
  const missing = await request("/state_proof?network=hoodi&state_id=42&gindex=1");
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "State not available");
});
