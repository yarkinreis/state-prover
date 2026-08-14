import { BeaconState } from "@lodestar/types"
import { ApiClient, ApiError, getClient } from "@lodestar/api";
import { ChainConfig, ChainForkConfig, createChainForkConfig } from "@lodestar/config"
import { holeskyChainConfig, mainnetChainConfig, sepoliaChainConfig } from "@lodestar/config/networks";
import { ForkName } from "@lodestar/params";
import { CompactMultiProof, ProofType, SingleProof, Tree, computeDescriptor } from "@chainsafe/persistent-merkle-tree";
import { LodestarError } from "./errors.js";
import { toHexString } from '@chainsafe/ssz'

export type NETWORK = "mainnet" | "holesky" | "sepolia" | "hoodi";

const networkToConfig: { [key in NETWORK]: ChainConfig; } = {
    "holesky": holeskyChainConfig,
    "sepolia": sepoliaChainConfig,
    "mainnet": mainnetChainConfig,
    "hoodi": mainnetChainConfig
};

export class EthAPI {
    private consensus: ApiClient;
    private config: ChainForkConfig;

    constructor(beaconURL: string, network: NETWORK) {
        if (!networkToConfig[network]) {
            throw new Error(`Undefined chain config for network ${network}`);
        }
        this.config = createChainForkConfig(networkToConfig[network]);
        // Historical-state requests force the beacon node to regenerate the state,
        // which takes ~93s on a large archive. @lodestar/api defaults to 60s
        // (DEFAULT_TIMEOUT_MS) and aborts first, surfacing as
        // "Timeout getStateFork request".
        const timeoutMs = Number(process.env.BEACON_TIMEOUT_MS ?? 900_000);
        this.consensus = getClient({ baseUrl: beaconURL, globalInit: { timeoutMs } }, { config: this.config })
    }

    async getForkNameByStateId(stateId: string): Promise<ForkName> {
        // 1) Try the fast path: match the node's currentVersion against this.config
        const forkRes = await this.consensus.beacon.getStateFork({ stateId });
        if (!forkRes.ok) throw new LodestarError(forkRes.error() as ApiError);
        const curVer = forkRes.value().currentVersion;

        for (const name in this.config.forks) {
            const fn = name as ForkName;
            if (toHexString(this.config.forks[fn].version) === toHexString(curVer)) return fn;
        }

        // 2) Fallback: compute the fork by slot using the node’s own fork schedule + spec
        const [schedRes, headerRes, specRes] = await Promise.all([
            // /eth/v1/config/fork_schedule
            this.consensus.config.getForkSchedule(),
            // /eth/v1/beacon/headers/{block_id}  (block_id may be "head" for state "head")
            this.consensus.beacon.getBlockHeader({ blockId: stateId }),
            // /eth/v1/config/spec
            this.consensus.config.getSpec(),
        ]);
        if (!schedRes.ok) throw new LodestarError(schedRes.error() as ApiError);
        if (!headerRes.ok) throw new LodestarError(headerRes.error() as ApiError);
        if (!specRes.ok) throw new LodestarError(specRes.error() as ApiError);

        const slotsPerEpoch = Number(specRes.value().SLOTS_PER_EPOCH);
        const slot = Number(headerRes.value().header.message.slot);
        const epoch = Math.floor(slot / slotsPerEpoch);

        // Canonical order of forks (no network-specific versions needed)
        const forkNames = ["phase0", "altair", "bellatrix", "capella", "deneb", "electra", "pectra"] as ForkName[];
        const schedule = schedRes.value(); // array with {previous_version, current_version, epoch}

        // choose the last fork whose activation epoch <= current epoch
        let idx = 0;
        for (let i = 0; i < schedule.length; i++) {
            if (epoch >= Number(schedule[i].epoch)) idx = i;
        }
        return forkNames[Math.min(idx, forkNames.length - 1)];
    }

    async getForkNameByBlockId(blockId: string): Promise<ForkName> {
        const res = await this.consensus.beacon.getBlockHeader({blockId});
        if (!res.ok){
            throw new LodestarError(res.error() as ApiError);
        }

        return this.config.getForkName(res.value().header.message.slot)
    }

    async getStateProof(stateId: string, gIndex: any): Promise<SingleProof> {
        const descriptor = computeDescriptor([gIndex])
        const res = await this.consensus.proof.getStateProof({stateId, descriptor})
        if (!res.ok){
            throw new LodestarError(res.error() as ApiError);
        }

        const tree = Tree.createFromProof(res.value());
        const proof: SingleProof = tree.getProof({
            type: ProofType.single,
            gindex: gIndex,
        }) as SingleProof;

        return proof
    }

    async getBlockProof(blockRoot: string, gIndex: any): Promise<SingleProof> {
        const descriptor = computeDescriptor([gIndex])
        const res = await this.consensus.proof.getBlockProof({blockId: blockRoot, descriptor})
        if (!res.ok){
            throw new LodestarError(res.error() as ApiError);
        }

        const tree = Tree.createFromProof(res.value());
        const proof: SingleProof = tree.getProof({
            type: ProofType.single,
            gindex: gIndex,
        }) as SingleProof;

        return proof
    }

    async getState(stateId: string): Promise<BeaconState> {
        const res = await this.consensus.debug.getStateV2({stateId});
        if (!res.ok) {
            console.error(res.error())
            throw new Error("Error fetching state")
        }
        return res.value()
    }
}