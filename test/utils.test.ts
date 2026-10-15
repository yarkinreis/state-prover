import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ForkName } from "@lodestar/params";
import { RequestError } from "../src/errors.js";
import { getConfig, getGindexFromQueryParams, parseGindex, parsePath, supportedNetworks } from "../src/utils.js";

const statePath = (path: string, fork = ForkName.gloas) =>
  getGindexFromQueryParams("state", { path }, fork);

test("Gloas and Fulu state paths use their distinct SSZ layouts", () => {
  // Independent fixture indices include both sides of progressive list subtrees.
  const fixtures: [string, string][] = [
    ["validators", "358"],
    ["balances", "359"],
    ["validators,0", "1432"],
    ["validators,1", "11464"],
    ["validators,4", "11467"],
    ["validators,5", "91744"],
    ["balances,0", "1436"],
    ["balances,3", "1436"],
    ["balances,4", "11496"],
    ["balances,19", "11499"],
    ["balances,20", "92000"],
  ];
  for (const [path, expected] of fixtures) assert.equal(statePath(path), BigInt(expected), path);
  assert.equal(statePath("validators", ForkName.fulu), BigInt(75));
  assert.equal(statePath("validators,0", ForkName.fulu), BigInt("164926744166400"));
  assert.equal(statePath("balances,0", ForkName.fulu), BigInt("41781441855488"));
});

test("all Validator fields resolve fully in camelCase and snake_case", () => {
  const fields = [
    ["pubkey", "pubkey"],
    ["withdrawalCredentials", "withdrawal_credentials"],
    ["effectiveBalance", "effective_balance"],
    ["slashed", "slashed"],
    ["activationEligibilityEpoch", "activation_eligibility_epoch"],
    ["activationEpoch", "activation_epoch"],
    ["exitEpoch", "exit_epoch"],
    ["withdrawableEpoch", "withdrawable_epoch"],
  ];
  for (const fork of [ForkName.fulu, ForkName.gloas]) {
    for (const validator of [0, 1, 4, 5]) {
      const root = statePath(`validators,${validator}`, fork);
      fields.forEach((aliases, field) => {
        for (const alias of aliases) {
          assert.equal(statePath(`validators,${validator},${alias}`, fork), root * BigInt(8) + BigInt(field));
        }
      });
    }
  }
  assert.equal(statePath("validators,0,withdrawable_epoch"), BigInt(11463));
  assert.equal(statePath("validators,0,withdrawable_epoch", ForkName.fulu), BigInt("1319413953331207"));
});

test("block paths use exact schemas and reject fields removed in Gloas", () => {
  for (const fork of [ForkName.fulu, ForkName.gloas]) {
    assert.equal(getGindexFromQueryParams("block", { path: "state_root" }, fork), BigInt(11));
    assert.equal(getGindexFromQueryParams("block", { path: "stateRoot" }, fork), BigInt(11));
  }
  assert.doesNotThrow(() => getGindexFromQueryParams("block", { path: "body,execution_payload" }, ForkName.fulu));
  assert.throws(() => getGindexFromQueryParams("block", { path: "body,execution_payload" }, ForkName.gloas), RequestError);
  assert.throws(() => getGindexFromQueryParams("state", { path: "slot" }), RequestError);
  assert.throws(() => getGindexFromQueryParams("state", { path: "slot" }, "pectra" as ForkName), RequestError);
});

test("gindices preserve integers beyond JavaScript number precision", () => {
  const value = "9007199254740993";
  assert.equal(parseGindex(value), BigInt(value));
  assert.equal(getGindexFromQueryParams("state", { gindex: value }), BigInt(value));
  assert.equal(parseGindex(undefined), null);
  assert.equal(parseGindex("1"), BigInt(1));
  assert.equal(statePath("validators,1000000000"), BigInt("50454388069987499"));
  assert.equal(statePath("validators,1000000000,activation_epoch"), BigInt("403635104559899997"));
});

test("invalid and ambiguous gindex queries fail as request errors", () => {
  for (const gindex of [null, 1, BigInt(1), "", "0", "-1", "1.5", "1e3", "0x10", "Infinity", "NaN", " 1", "1 ", ["1"], { value: "1" }]) {
    assert.throws(() => parseGindex(gindex), RequestError, String(gindex));
    assert.throws(() => getGindexFromQueryParams("state", { gindex }), RequestError);
  }
  assert.throws(() => getGindexFromQueryParams("state", {}), RequestError);
  assert.throws(() => getGindexFromQueryParams("state", { path: "slot", gindex: "1" }, ForkName.gloas), RequestError);
});

test("paths reject malformed, out-of-range, unknown and truncated segments", () => {
  for (const path of [undefined, null, [], ["slot"], {}, "", ",", "validators,", ",slot", "validators,,0", "validators,-1", "validators,1.5", "validators,1e3", "validators,9007199254740992", " validators,0"]) {
    assert.throws(() => parsePath(path), RequestError, String(path));
  }
  assert.deepEqual(parsePath("validators,42,withdrawal_credentials"), ["validators", 42, "withdrawal_credentials"]);
  for (const fork of [ForkName.fulu, ForkName.gloas]) {
    for (const path of ["validators,1099511627776", "balances,1099511627776", "block_roots,8192", "validators,no_index", "validators,0,unknown", "validators,0,slashed,extra", "validators,0,pubkey,0", "unknown", "constructor"]) {
      assert.throws(() => statePath(path, fork), RequestError, `${fork}: ${path}`);
    }
  }
});

test("configuration supports a Hoodi-only service and validates the port", () => {
  const keys = ["PORT", ...supportedNetworks.map((network) => `${network.toUpperCase()}_BEACON_API`)];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.throws(() => getConfig(), /at least one network/);
    process.env.HOODI_BEACON_API = "http://127.0.0.1:9596";
    assert.deepEqual(getConfig(), { port: 3000, beaconUrls: { hoodi: "http://127.0.0.1:9596" } });
    process.env.PORT = "8080";
    assert.equal(getConfig().port, 8080);
    for (const port of ["", "0", "65536", "1.5", "1e3", "Infinity", "-1", " 3000"]) {
      process.env.PORT = port;
      assert.throws(() => getConfig(), /PORT/);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a process using the minimal SSZ preset rejects paths while preserving raw gindices", () => {
  const result = spawnSync(process.execPath, [
    "--import", "./test/register.mjs", "--input-type=module", "-e",
    `import assert from "node:assert/strict";
     import { getGindexFromQueryParams } from "./src/utils.js";
     import { UnsupportedForkError } from "./src/errors.js";
     import { ForkName } from "@lodestar/params";
     assert.equal(getGindexFromQueryParams("state", { gindex: "9007199254740993" }), 9007199254740993n);
     assert.throws(() => getGindexFromQueryParams("state", { path: "validators,0" }, ForkName.gloas), UnsupportedForkError);`,
  ], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, LODESTAR_PRESET: "minimal" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
