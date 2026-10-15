import { BeaconState } from "@lodestar/types";
import { ApiClient, ApiError, getClient, routes, WireFormat } from "@lodestar/api";
import { ChainConfig, createChainForkConfig } from "@lodestar/config";
import { hoodiChainConfig, mainnetChainConfig, sepoliaChainConfig } from "@lodestar/config/networks";
import { ForkName } from "@lodestar/params";
import { ProofType, SingleProof, Tree, computeDescriptor } from "@chainsafe/persistent-merkle-tree";
import { fromHexString, toHexString } from "@chainsafe/ssz";
import { LodestarError, UnsupportedForkError } from "./errors.js";

export type NETWORK = "mainnet" | "holesky" | "sepolia" | "hoodi";

// Lodestar retired Holesky's bundled config after 1.35. Retain its historical
// overrides for REST codecs; the connected node's spec determines proof forks.
const holeskyChainConfig: ChainConfig = {
    ...mainnetChainConfig,
    CONFIG_NAME: "holesky",
    MIN_GENESIS_ACTIVE_VALIDATOR_COUNT: 16384,
    MIN_GENESIS_TIME: 1695902100,
    GENESIS_DELAY: 300,
    GENESIS_FORK_VERSION: fromHexString("0x01017000"),
    ALTAIR_FORK_VERSION: fromHexString("0x02017000"),
    ALTAIR_FORK_EPOCH: 0,
    BELLATRIX_FORK_VERSION: fromHexString("0x03017000"),
    BELLATRIX_FORK_EPOCH: 0,
    TERMINAL_TOTAL_DIFFICULTY: BigInt(0),
    CAPELLA_FORK_VERSION: fromHexString("0x04017000"),
    CAPELLA_FORK_EPOCH: 256,
    DENEB_FORK_VERSION: fromHexString("0x05017000"),
    DENEB_FORK_EPOCH: 29696,
    ELECTRA_FORK_VERSION: fromHexString("0x06017000"),
    ELECTRA_FORK_EPOCH: 115968,
    FULU_FORK_VERSION: fromHexString("0x07017000"),
    FULU_FORK_EPOCH: 165120,
    GLOAS_FORK_VERSION: fromHexString("0x08017000"),
    GLOAS_FORK_EPOCH: Infinity,
    EJECTION_BALANCE: 28000000000,
    DEPOSIT_CHAIN_ID: 17000,
    DEPOSIT_NETWORK_ID: 17000,
    DEPOSIT_CONTRACT_ADDRESS: fromHexString("0x4242424242424242424242424242424242424242"),
    BLOB_SCHEDULE: [
        { EPOCH: 166400, MAX_BLOBS_PER_BLOCK: 15 },
        { EPOCH: 167936, MAX_BLOBS_PER_BLOCK: 21 },
    ],
};

const networkToConfig: Record<NETWORK, ChainConfig> = {
    holesky: holeskyChainConfig,
    sepolia: sepoliaChainConfig,
    mainnet: mainnetChainConfig,
    hoodi: hoodiChainConfig,
};

const mutableIds = new Set(["head", "finalized", "justified"]);
const specCacheMs = 60_000;
const knownForks = Object.values(ForkName);

interface SpecFork {
    label: string;
    name: ForkName | undefined;
    version: string;
    epoch: bigint;
}

interface NodeSpec {
    slotsPerEpoch: bigint;
    forks: SpecFork[];
}

function unsignedInteger(value: unknown, label: string): bigint {
    if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
        throw new UnsupportedForkError(`Beacon node returned an invalid ${label}`);
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new UnsupportedForkError(`Beacon node returned an unsafe ${label}`);
    }
    return BigInt(value);
}

function forkVersion(value: unknown, label: string): string {
    if (typeof value !== "string" || !/^0x[0-9a-f]{8}$/i.test(value)) {
        throw new UnsupportedForkError(`Beacon node returned an invalid ${label}`);
    }
    return value.toLowerCase();
}

function parseNodeSpec(spec: Record<string, unknown>): NodeSpec {
    if (spec.PRESET_BASE !== undefined && spec.PRESET_BASE !== "mainnet") {
        throw new UnsupportedForkError("Path proofs require a mainnet-preset beacon node");
    }
    const slotsPerEpoch = unsignedInteger(spec.SLOTS_PER_EPOCH, "SLOTS_PER_EPOCH");
    if (slotsPerEpoch === BigInt(0)) {
        throw new UnsupportedForkError("Beacon node returned zero SLOTS_PER_EPOCH");
    }
    const forks: SpecFork[] = [{
        label: "GENESIS",
        name: ForkName.phase0,
        version: forkVersion(spec.GENESIS_FORK_VERSION, "GENESIS_FORK_VERSION"),
        epoch: BigInt(0),
    }];
    const labels = new Set<string>();
    for (const key of Object.keys(spec)) {
        const match = /^(.*)_FORK_(?:VERSION|EPOCH)$/.exec(key);
        if (match && match[1] !== "GENESIS") labels.add(match[1]);
    }
    for (const label of labels) {
        const name = knownForks.find((fork) => fork.toUpperCase() === label);
        forks.push({
            label,
            name,
            version: forkVersion(spec[`${label}_FORK_VERSION`], `${label}_FORK_VERSION`),
            epoch: unsignedInteger(spec[`${label}_FORK_EPOCH`], `${label}_FORK_EPOCH`),
        });
    }
    forks.sort((a, b) => a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 :
        knownForks.indexOf(a.name as ForkName) - knownForks.indexOf(b.name as ForkName));
    return { slotsPerEpoch, forks };
}

function requireKnownFork(fork: SpecFork): ForkName {
    if (!fork.name) {
        throw new UnsupportedForkError(`Unsupported beacon fork ${fork.label.toLowerCase()} (${fork.version}); update the prover's Lodestar schemas`);
    }
    return fork.name;
}

export class EthAPI {
    private consensus: ApiClient;
    private specCache: { value: NodeSpec; expiresAt: number } | undefined;
    private pendingSpec: Promise<NodeSpec> | undefined;

    constructor(beaconURL: string, network: NETWORK) {
        if (!networkToConfig[network]) {
            throw new Error(`Undefined chain config for network ${network}`);
        }
        const config = createChainForkConfig(networkToConfig[network]);
        // Historical proofs can require several minutes of state regeneration.
        const timeoutMs = Number(process.env.BEACON_TIMEOUT_MS ?? 900_000);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
            throw new Error("BEACON_TIMEOUT_MS must be a positive safe integer");
        }
        this.consensus = getClient({ baseUrl: beaconURL, globalInit: { timeoutMs } }, { config });
    }

    private async getNodeSpec(): Promise<NodeSpec> {
        if (this.specCache && Date.now() < this.specCache.expiresAt) return this.specCache.value;
        if (this.pendingSpec) return this.pendingSpec;
        this.pendingSpec = (async () => {
            const res = await this.consensus.config.getSpec();
            if (!res.ok) throw new LodestarError(res.error() as ApiError);
            const value = parseNodeSpec(res.value());
            this.specCache = { value, expiresAt: Date.now() + specCacheMs };
            return value;
        })();
        try {
            return await this.pendingSpec;
        } finally {
            this.pendingSpec = undefined;
        }
    }

    private async getForkNameBySlot(slot: string | number): Promise<ForkName> {
        const spec = await this.getNodeSpec();
        const epoch = unsignedInteger(slot, "slot") / spec.slotsPerEpoch;
        let active = spec.forks[0];
        for (const fork of spec.forks) {
            if (fork.epoch > epoch) continue;
            // Fail closed even if an unknown fork shares an activation epoch.
            requireKnownFork(fork);
            active = fork;
        }
        return requireKnownFork(active);
    }

    async resolveStateId(stateId: string): Promise<string> {
        if (!mutableIds.has(stateId)) return stateId;
        const res = await this.consensus.beacon.getStateRoot({ stateId });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        return toHexString(res.value().root);
    }

    async resolveBlockId(blockId: string): Promise<string> {
        if (!mutableIds.has(blockId)) return blockId;
        const res = await this.consensus.beacon.getBlockHeader({ blockId });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        return toHexString(res.value().root);
    }

    async getForkNameByStateId(stateId: string): Promise<ForkName> {
        // Numeric state IDs avoid regenerating the historical state just to read its fork.
        if (/^\d+$/.test(stateId)) return this.getForkNameBySlot(stateId);
        const [forkRes, spec] = await Promise.all([
            this.consensus.beacon.getStateFork({ stateId }),
            this.getNodeSpec(),
        ]);
        if (!forkRes.ok) throw new LodestarError(forkRes.error() as ApiError);
        const version = toHexString(forkRes.value().currentVersion).toLowerCase();
        const fork = spec.forks.find((candidate) => candidate.version === version);
        if (!fork) {
            throw new UnsupportedForkError(`Unknown beacon fork version ${version}; update the prover's Lodestar schemas`);
        }
        return requireKnownFork(fork);
    }

    async getForkNameByBlockId(blockId: string): Promise<ForkName> {
        const res = await this.consensus.beacon.getBlockHeader({ blockId });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        return this.getForkNameBySlot(res.value().header.message.slot);
    }

    async getStateProof(stateId: string, gindex: bigint, expectedFork?: ForkName): Promise<SingleProof> {
        const descriptor = computeDescriptor([gindex]);
        const res = await this.consensus.proof.getStateProof({ stateId, descriptor });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        if (expectedFork !== undefined) this.checkProofFork(() => res.meta().version, expectedFork);
        return this.singleProofFromBody(await res.rawBody(), gindex);
    }

    async getBlockProof(blockId: string, gindex: bigint, expectedFork?: ForkName): Promise<SingleProof> {
        const descriptor = computeDescriptor([gindex]);
        const res = await this.consensus.proof.getBlockProof({ blockId, descriptor });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        if (expectedFork !== undefined) this.checkProofFork(() => res.meta().version, expectedFork);
        return this.singleProofFromBody(await res.rawBody(), gindex);
    }

    private singleProofFromBody(body: { type?: WireFormat; value?: unknown }, gindex: bigint): SingleProof {
        // Compact proof data has the same format across forks. Decode it without
        // requiring a schema or a recognized fork name for raw-gindex requests.
        const type = routes.proof.CompactMultiProofType;
        let compact;
        if (body.type === WireFormat.json) {
            compact = type.fromJson((body.value as { data: unknown }).data);
        } else if (body.type === WireFormat.ssz && body.value instanceof Uint8Array) {
            compact = type.deserialize(body.value);
        } else {
            throw new Error("Beacon node returned an unsupported compact proof response");
        }
        return Tree.createFromProof({ ...compact, type: ProofType.compactMulti })
            .getProof({ type: ProofType.single, gindex }) as SingleProof;
    }

    private checkProofFork(readVersion: () => ForkName, expectedFork: ForkName): void {
        let version: ForkName;
        try {
            version = readVersion();
        } catch {
            throw new UnsupportedForkError("Beacon node returned missing or unsupported proof fork metadata");
        }
        if (version !== expectedFork) {
            throw new UnsupportedForkError(`Proof fork ${version} does not match resolved fork ${expectedFork}`);
        }
    }

    async getState(stateId: string): Promise<BeaconState> {
        const res = await this.consensus.debug.getStateV2({ stateId });
        if (!res.ok) throw new LodestarError(res.error() as ApiError);
        return res.value();
    }
}
