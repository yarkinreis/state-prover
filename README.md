# State prover

Generate single Merkle inclusion proofs from Lodestar's compact proof endpoints, without downloading a full beacon state or block. Both historical SSZ trees and Gloas progressive SSZ trees are supported.

## Setup

1. Install Node.js 20.6 or newer.
2. Run `npm ci`.
3. Copy `.env.template` to `.env` and set the beacon API URL for each network you use. For local testing, only `HOODI_BEACON_API=http://127.0.0.1:9596` is needed. Public networks use the mainnet SSZ preset; custom minimal-preset devnets are not supported.
4. Run `npm run serve`.

The server uses port 3000 by default. `PORT` overrides it. `BEACON_TIMEOUT_MS` sets the upstream request timeout in milliseconds; the default is 900000 (15 minutes), allowing historical-state regeneration.

Lodestar packages are pinned to 1.50.0, with SSZ 1.8.1 and persistent-merkle-tree 1.3.1. The beacon node must also run a compatible Gloas release and expose Lodestar's `/eth/v0/beacon/proof/*` routes. These are Lodestar-specific endpoints; an ordinary Beacon REST API from another client is insufficient.

Both npm and Yarn lockfiles are maintained. Use `npm ci` or `yarn install --frozen-lockfile` for reproducible installs.

## Endpoints

```http
GET /state_proof?network=hoodi&state_id=<state_identifier>&path=<comma_separated_path>
GET /state_proof?network=hoodi&state_id=<state_identifier>&gindex=<positive_decimal_integer>
GET /block_proof?network=hoodi&block_id=<block_identifier>&path=<comma_separated_path>
GET /block_proof?network=hoodi&block_id=<block_identifier>&gindex=<positive_decimal_integer>
GET /has_state?network=hoodi&state_id=<state_identifier>
```

Specify exactly one of `path` or `gindex`. Paths accept both Beacon API snake_case names and Lodestar camelCase names. Array indices must be nonnegative safe integers within the SSZ schema's bounds. A path must resolve completely in the requested object's fork; removed fields and invalid nested paths return HTTP 400.

State identifiers accept a decimal slot, a state root, or `head`, `finalized`, `justified`, or `genesis`. Block identifiers accept a decimal slot, a block root, or those aliases. A state root is distinct from a block root. Mutable aliases are pinned to their root before requesting a proof. Historical objects must still be available on the node.

Networks are `mainnet`, `sepolia`, `hoodi`, and `holesky` (historical data). The default is `mainnet`. Requests for a network without a configured URL return HTTP 400, so include `network=hoodi` when only a local Hoodi node is configured.

### Response

```json
{
  "type": "single",
  "gindex": "11459",
  "leaf": "0x...",
  "witnesses": ["0x...", "0x..."]
}
```

`leaf` and `witnesses` contain 32-byte hex values. Witnesses are ordered from the leaf toward the root. `/has_state` returns HTTP 200 if a root proof can be obtained and otherwise preserves the node's error status.

**API change:** `gindex` is always a decimal string. Consumers should use `BigInt(response.gindex)` rather than `Number(response.gindex)`. Gindices remain bigint throughout proof generation, including compact proof descriptor construction.

Invalid query parameters return HTTP 400. An unsupported fork or a mismatch between the resolved fork and the proof metadata returns HTTP 502 for path requests. Upstream errors, including missing historical states, preserve their HTTP status.

## Gloas behavior

EIP-7688 converts `BeaconState` to a progressive container and its validator and balance lists to progressive lists. Each `Validator` remains an eight-field container. Paths and witness lengths change; consumers with fixed pre-Gloas indices or branch lengths need their own update.

The prover reads the connected node's named fork versions and activation epochs from `/eth/v1/config/spec`, caching them for one minute. Numeric state slots use that schedule without fetching the historical state just to identify its fork. State-root queries use `/eth/v1/beacon/states/{state_id}/fork`. Unsupported forks are rejected rather than assigned an older schema.

Path requests use the exact fork's schema. Raw `gindex` requests use the supplied path directly and skip fork lookup; callers are responsible for supplying the correct index. Pre-Gloas history continues to use its original SSZ layout.

Validator-field paths such as `validators,0,withdrawal_credentials` resolve to the field itself. The existing two-step consumer flow also works: request `validators,0`, then derive a field index as `BigInt(gindex) * 8n + fieldOffset` and request that raw gindex. Offsets remain 0 through 7 in the existing Validator field order.

Balances remain packed four uint64 values into each 32-byte leaf. The byte offset is `8 * (validatorIndex % 4)`. Gloas list element paths come from the progressive schema; fixed list-depth arithmetic is unsuitable.

The beacon block's `state_root` path remains gindex 11. Gloas removes `body,execution_payload`; it cannot be resolved by falling back to Electra. Execution payloads move into the ePBS envelope and require a different proof design if your application needs their contents.

References: [EIP-7688](https://eips.ethereum.org/EIPS/eip-7688), [EIP-7916](https://eips.ethereum.org/EIPS/eip-7916), [Lodestar 1.50.0](https://github.com/ChainSafe/lodestar/releases/tag/v1.50.0).

## Local proof checks

Start your compatible local Lodestar node, set the Hoodi URL in `.env`, and start the prover. Test each request separately:

```bash
curl 'http://localhost:3000/has_state?network=hoodi&state_id=finalized'
curl 'http://localhost:3000/state_proof?network=hoodi&state_id=finalized&path=validators,0'
curl 'http://localhost:3000/state_proof?network=hoodi&state_id=finalized&path=validators,0,withdrawal_credentials'
curl 'http://localhost:3000/state_proof?network=hoodi&state_id=finalized&path=validators,0,slashed'
curl 'http://localhost:3000/state_proof?network=hoodi&state_id=finalized&path=balances,0'
curl 'http://localhost:3000/block_proof?network=hoodi&block_id=finalized&path=state_root'
```

For a complete verification, pin one block root, obtain its header and `state_root`, and use that same state root for all state proofs. Reconstruct each state proof using SHA-256 and the returned gindex and witnesses, then compare it with the header's state root. Reconstruct the block proof and compare it with the pinned block root. Separate calls to `finalized` can reference different roots as the chain advances.

Repeat with fixed slots before and after the node's configured Gloas activation, all eight validator fields, and balance indices on either side of a four-value chunk boundary. Before Hoodi activation, use an already-active Gloas network or a mainnet-preset devnet with Gloas enabled to exercise the new trees.

## Automated checks

```bash
npm run typecheck
npm test
```

The suite uses synthetic Fulu and Gloas SSZ states and local mock Beacon API servers. It checks schema-derived indices against independent expected values, reconstructs proof roots, exercises fork boundaries and malformed inputs, and verifies HTTP bigint serialization. It does not replace testing against your running archive node and on-chain verifier.

## Acknowledgments

[Lodestar](https://github.com/ChainSafe/lodestar) provides the compact proof endpoints and fork-specific SSZ schemas.
