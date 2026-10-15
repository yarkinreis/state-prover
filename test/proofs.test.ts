import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  BranchNode,
  LeafNode,
  Node,
  ProofType,
  SingleProof,
  Tree,
  computeDescriptor,
  subtreeFillToDepth,
  zeroNode,
} from "@chainsafe/persistent-merkle-tree";
import { ssz } from "@lodestar/types";
import { ForkName } from "@lodestar/params";
import { getGindexFromQueryParams } from "../src/utils.js";

type Fork = ForkName.fulu | ForkName.gloas;
type Validator = ReturnType<typeof ssz.phase0.Validator.defaultValue>;
type ValidatorField = keyof Validator;

const forks: Fork[] = [ForkName.fulu, ForkName.gloas];
const validatorIndices = [0, 1, 4, 5, 20, 21, 84, 85];
const chunkIndices = [0, 1, 4, 5, 20, 21];
const validatorFields: ValidatorField[] = [
  "pubkey",
  "withdrawalCredentials",
  "effectiveBalance",
  "slashed",
  "activationEligibilityEpoch",
  "activationEpoch",
  "exitEpoch",
  "withdrawableEpoch",
];

function hash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(left).update(right).digest());
}

function uint64Chunk(value: number | bigint): Uint8Array {
  const chunk = Buffer.alloc(32);
  chunk.writeBigUInt64LE(BigInt(value));
  return Uint8Array.from(chunk);
}

function concatGindices(...indices: bigint[]): bigint {
  return BigInt(`0b1${indices.map((index) => index.toString(2).slice(1)).join("")}`);
}

// EIP-7916: successive left subtrees contain 1, 4, 16, ... chunks.
// Derive the path directly, independently of Lodestar's gindex helpers.
function progressiveChunkGindex(index: number): bigint {
  let remaining = index;
  let capacity = 1;
  let rights = "";
  let subtreeDepth = 0;
  while (remaining >= capacity) {
    remaining -= capacity;
    capacity *= 4;
    rights += "1";
    subtreeDepth += 2;
  }
  const offset = subtreeDepth === 0 ? "" : remaining.toString(2).padStart(subtreeDepth, "0");
  return BigInt(`0b1${rights}0${offset}`);
}

function expectedValidatorGindex(fork: Fork, index: number, field: number): bigint {
  if (fork === "fulu") {
    // 64 state leaves; validators are field 11, with a 2^40 list capacity.
    return concatGindices(75n, (2n << 40n) + BigInt(index), 8n + BigInt(field));
  }
  // EIP-7495 adds the active-fields mix-in; EIP-7916 adds the length mix-in.
  return concatGindices(
    2n,
    progressiveChunkGindex(11),
    2n,
    progressiveChunkGindex(index),
    8n + BigInt(field)
  );
}

function expectedBalanceGindex(fork: Fork, index: number): bigint {
  const chunk = Math.floor(index / 4);
  if (fork === "fulu") {
    return concatGindices(76n, (2n << 38n) + BigInt(chunk));
  }
  return concatGindices(2n, progressiveChunkGindex(12), 2n, progressiveChunkGindex(chunk));
}

function resolve(fork: Fork, resolution: "state" | "block", path: string): bigint {
  const gindex = getGindexFromQueryParams(resolution, { path }, fork);
  assert.equal(typeof gindex, "bigint", "path resolution must preserve bigint precision");
  assert(gindex !== null);
  return gindex;
}

function validatorAt(index: number): Validator {
  return {
    pubkey: Uint8Array.from({ length: 48 }, (_, offset) => (index + offset + 1) % 256),
    withdrawalCredentials: Uint8Array.from({ length: 32 }, (_, offset) => (index + offset + 67) % 256),
    effectiveBalance: 32_000_000_000 + index,
    slashed: index % 2 === 1,
    activationEligibilityEpoch: 100 + index,
    activationEpoch: 200 + index,
    exitEpoch: 300 + index,
    withdrawableEpoch: 400 + index,
  };
}

function validatorFieldRoot(validator: Validator, field: ValidatorField): Uint8Array {
  if (field === "pubkey") {
    return hash(validator.pubkey.subarray(0, 32), Buffer.concat([validator.pubkey.subarray(32), Buffer.alloc(16)]));
  }
  if (field === "withdrawalCredentials") return validator.withdrawalCredentials;
  if (field === "slashed") return uint64Chunk(validator.slashed ? 1 : 0);
  return uint64Chunk(validator[field]);
}

function reconstructRoot(proof: SingleProof): Uint8Array {
  let root = proof.leaf;
  let index = proof.gindex;
  for (const sibling of proof.witnesses) {
    root = (index & 1n) === 0n ? hash(root, sibling) : hash(sibling, root);
    index >>= 1n;
  }
  assert.equal(index, 1n, "the branch must reach the root exactly");
  return root;
}

function prove(tree: Tree, gindex: bigint, expectedLeaf: Uint8Array, expectedRoot: Uint8Array): SingleProof {
  const compact = tree.getProof({ type: ProofType.compactMulti, descriptor: computeDescriptor([gindex]) });
  assert.equal(compact.type, ProofType.compactMulti);
  const restoredTree = Tree.createFromProof(compact);
  assert.deepEqual(restoredTree.root, expectedRoot);
  const proof = restoredTree.getProof({ type: ProofType.single, gindex }) as SingleProof;
  assert.equal(proof.gindex, gindex);
  assert.deepEqual(proof.leaf, Uint8Array.from(expectedLeaf));
  assert.equal(proof.witnesses.length, gindex.toString(2).length - 1);
  assert.deepEqual(reconstructRoot(proof), expectedRoot);
  return proof;
}

type StateFields = { slot: number; validators: Validator[]; balances: number[] };
type StateSchema<T> = {
  defaultValue(): T;
  serialize(value: T): Uint8Array;
  deserialize(bytes: Uint8Array): T;
  value_toTree(value: T): Node;
  hashTreeRoot(value: T): Uint8Array;
};

function fixture<T extends StateFields>(schema: StateSchema<T>) {
  const state = schema.defaultValue();
  state.slot = 4_235_264;
  state.validators = Array.from({ length: 88 }, (_, index) => validatorAt(index));
  state.balances = Array.from({ length: 88 }, (_, index) => 32_000_000_000 + index * 17);
  const bytes = schema.serialize(state);
  const decoded = schema.deserialize(bytes);
  const tree = new Tree(schema.value_toTree(decoded));
  const root = schema.hashTreeRoot(decoded);
  assert.deepEqual(tree.root, root);
  return { state: decoded, tree, root };
}

const fixtures = {
  fulu: fixture(ssz.fulu.BeaconState),
  gloas: fixture(ssz.gloas.BeaconState),
};

type BlockFields = { slot: number; proposerIndex: number; parentRoot: Uint8Array; stateRoot: Uint8Array };

function blockFixture<T extends BlockFields>(schema: StateSchema<T>, stateRoot: Uint8Array, slot: number) {
  const block = schema.defaultValue();
  block.slot = slot;
  block.stateRoot = stateRoot;
  const decoded = schema.deserialize(schema.serialize(block));
  const tree = new Tree(schema.value_toTree(decoded));
  assert.deepEqual(tree.root, schema.hashTreeRoot(decoded));
  return { block: decoded, tree };
}

for (const fork of forks) {
  test(`${fork}: all Validator fields survive compact-to-single proofs at subtree boundaries`, () => {
    const { state, tree, root } = fixtures[fork];
    for (const index of validatorIndices) {
      for (const [fieldIndex, field] of validatorFields.entries()) {
        const path = `validators,${index},${field}`;
        const gindex = resolve(fork, "state", path);
        assert.equal(gindex, expectedValidatorGindex(fork, index, fieldIndex), path);
        prove(tree, gindex, validatorFieldRoot(state.validators[index], field), root);
      }
    }
  });

  test(`${fork}: packed balances prove all four offsets around progressive chunk boundaries`, () => {
    const { state, tree, root } = fixtures[fork];
    for (const chunk of chunkIndices) {
      const packed = Buffer.alloc(32);
      for (let offset = 0; offset < 4; offset++) {
        packed.writeBigUInt64LE(BigInt(state.balances[chunk * 4 + offset]), offset * 8);
      }
      for (let offset = 0; offset < 4; offset++) {
        const index = chunk * 4 + offset;
        const gindex = resolve(fork, "state", `balances,${index}`);
        assert.equal(gindex, expectedBalanceGindex(fork, index));
        const proof = prove(tree, gindex, packed, root);
        assert.equal(Buffer.from(proof.leaf).readBigUInt64LE(offset * 8), BigInt(state.balances[index]));
      }
    }
  });

  test(`${fork}: block and header state roots retain generalized index 11`, () => {
    const { root, state } = fixtures[fork];
    const { block, tree } = fork === "fulu"
      ? blockFixture(ssz.fulu.BeaconBlock, root, state.slot)
      : blockFixture(ssz.gloas.BeaconBlock, root, state.slot);
    const header = {
      slot: block.slot,
      proposerIndex: block.proposerIndex,
      parentRoot: block.parentRoot,
      stateRoot: block.stateRoot,
      bodyRoot: tree.getRoot(12n),
    };
    const headerTree = new Tree(ssz.phase0.BeaconBlockHeader.value_toTree(header));
    const gindex = resolve(fork, "block", "stateRoot");
    assert.equal(gindex, 11n);
    assert.equal(ssz.phase0.BeaconBlockHeader.getPathInfo(["stateRoot"]).gindex, 11n);
    assert.deepEqual(headerTree.root, tree.root);
    prove(tree, gindex, block.stateRoot, tree.root);
    prove(headerTree, gindex, block.stateRoot, headerTree.root);
  });
}

test("Gloas rejects the removed execution-payload path without falling back to Fulu", () => {
  const path = "body,executionPayload,blockHash";
  assert.equal(resolve(ForkName.fulu, "block", path), 6444n);
  assert.throws(() => getGindexFromQueryParams("block", { path }, ForkName.gloas));
});

test("proof corruption changes the reconstructed state root", () => {
  const { tree, state, root } = fixtures.gloas;
  const gindex = resolve(ForkName.gloas, "state", "validators,21,withdrawalCredentials");
  const proof = prove(tree, gindex, state.validators[21].withdrawalCredentials, root);
  const leaf = Uint8Array.from(proof.leaf);
  leaf[0] ^= 1;
  assert.notDeepEqual(Buffer.from(reconstructRoot({ ...proof, leaf })), Buffer.from(root));
  const witnesses = proof.witnesses.map((witness) => Uint8Array.from(witness));
  witnesses[0][0] ^= 1;
  assert.notDeepEqual(Buffer.from(reconstructRoot({ ...proof, witnesses })), Buffer.from(root));
});

// Repeat valid default element roots in a sparse prefix, padding only after its
// length. Node sharing keeps this logarithmic even for indices above 2^39.
function repeatedPrefix(bottom: Node, depth: number, length: number): Node {
  if (length === 0) return zeroNode(depth);
  if (length === 2 ** depth) return subtreeFillToDepth(bottom, depth);
  const half = 2 ** (depth - 1);
  return new BranchNode(
    repeatedPrefix(bottom, depth - 1, Math.min(length, half)),
    repeatedPrefix(bottom, depth - 1, Math.max(0, length - half))
  );
}

function progressivePrefix(bottom: Node, length: number, level = 0): Node {
  if (length === 0) return zeroNode(0);
  const capacity = 4 ** level;
  return new BranchNode(
    repeatedPrefix(bottom, 2 * level, Math.min(length, capacity)),
    progressivePrefix(bottom, Math.max(0, length - capacity), level + 1)
  );
}

test("Gloas high-index sparse proofs retain every bigint bit", () => {
  const index = 2 ** 39;
  const length = index + 1;
  const tree = new Tree(fixtures.gloas.tree.rootNode);
  const validatorListGindex = concatGindices(2n, progressiveChunkGindex(11));
  const balancesGindex = concatGindices(2n, progressiveChunkGindex(12));
  const defaultValidatorNode = ssz.phase0.Validator.value_toTree(ssz.phase0.Validator.defaultValue());
  const validatorList = new BranchNode(progressivePrefix(defaultValidatorNode, length), LeafNode.fromRoot(uint64Chunk(length)));
  tree.setNode(validatorListGindex, validatorList);
  const validator = validatorAt(123);
  tree.setNode(
    concatGindices(validatorListGindex, 2n, progressiveChunkGindex(index)),
    ssz.phase0.Validator.value_toTree(validator)
  );
  // Complete preceding balance chunks are zero. The last chunk holds one value.
  const balanceChunks = index / 4 + 1;
  tree.setNode(
    balancesGindex,
    new BranchNode(progressivePrefix(zeroNode(0), balanceChunks), LeafNode.fromRoot(uint64Chunk(length)))
  );
  const balanceGindex = resolve(ForkName.gloas, "state", `balances,${index}`);
  const balance = 32_000_000_123;
  tree.setNode(balanceGindex, LeafNode.fromRoot(uint64Chunk(balance)));
  // These conceptual list lengths exceed SSZ's serialized-message limit and
  // this library's uint32 view-length reader. Exercise the actual schema's path
  // query and sparse Merkle representation without allocating/serializing them.
  assert.deepEqual(tree.getRoot(concatGindices(validatorListGindex, 3n)), uint64Chunk(length));
  assert.deepEqual(tree.getRoot(concatGindices(balancesGindex, 3n)), uint64Chunk(length));
  const root = tree.root;
  for (const [fieldIndex, field] of validatorFields.entries()) {
    const gindex = resolve(ForkName.gloas, "state", `validators,${index},${field}`);
    assert(gindex > BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(gindex, expectedValidatorGindex(ForkName.gloas, index, fieldIndex));
    assert.equal(getGindexFromQueryParams("state", { gindex: gindex.toString() }, ForkName.gloas), gindex);
    prove(tree, gindex, validatorFieldRoot(validator, field), root);
  }
  assert(balanceGindex > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(balanceGindex, expectedBalanceGindex(ForkName.gloas, index));
  prove(tree, balanceGindex, uint64Chunk(balance), root);
});
