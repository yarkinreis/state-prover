import "dotenv/config";
import { ContainerNodeStructType, ContainerType, isCompositeType, Type } from "@chainsafe/ssz";
import { concatGindices } from "@chainsafe/persistent-merkle-tree";
import { ACTIVE_PRESET, ForkName } from "@lodestar/params";
import { sszTypesFor } from "@lodestar/types";
import type { NETWORK } from "./eth.js";
import { RequestError, UnsupportedForkError } from "./errors.js";

export const supportedNetworks: NETWORK[] = ["holesky", "sepolia", "mainnet", "hoodi"];

export function getConfig(): { port: number; beaconUrls: Partial<Record<NETWORK, string>> } {
  const rawPort = process.env.PORT ?? "3000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const beaconUrls: Partial<Record<NETWORK, string>> = {};
  for (const network of supportedNetworks) {
    const url = process.env[`${network.toUpperCase()}_BEACON_API`]?.trim();
    if (url) beaconUrls[network] = url;
  }
  if (Object.keys(beaconUrls).length === 0) {
    throw new Error("Configure at least one network's *_BEACON_API URL");
  }

  return { port, beaconUrls };
}

export const getEnv = (key: string, defaultValue?: string): string => {
  const value = process.env[key] || defaultValue;
  if (value === undefined) throw new Error(`Environment variable ${key} not set`);
  return value;
};

export const parseGindex = (gindex: unknown): bigint | null => {
  if (gindex === undefined) return null;
  if (typeof gindex !== "string" || !/^\d+$/.test(gindex)) {
    throw new RequestError("gindex must be a positive decimal integer string");
  }
  const parsed = BigInt(gindex);
  if (parsed < BigInt(1)) throw new RequestError("gindex must be greater than zero");
  return parsed;
};

export const parsePath = (path: unknown): (string | number)[] => {
  if (typeof path !== "string" || path.length === 0) {
    throw new RequestError("path must be a nonempty comma-separated string");
  }
  return path.split(",").map((segment) => {
    if (/^\d+$/.test(segment)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index)) {
        throw new RequestError("Path indices must be nonnegative safe integers");
      }
      return index;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      throw new RequestError("Path segments must be field names or nonnegative integer indices");
    }
    return segment;
  });
};

const proofContainers = new WeakMap<Type<unknown>, ContainerType<Record<string, Type<unknown>>>>();

function resolvePath(kind: "block" | "state", path: (string | number)[], fork: ForkName): bigint {
  const types = sszTypesFor(fork);
  let type: Type<unknown> = kind === "block" ? types.BeaconBlock : types.BeaconState;
  const indices: bigint[] = [];

  for (const property of path) {
    // Lodestar's memory-optimized Validator type stops getPathInfo at its root.
    // Its ordinary Container equivalent has the same SSZ tree and exposes fields.
    if (type instanceof ContainerNodeStructType) {
      let container = proofContainers.get(type);
      if (!container) {
        container = new ContainerType(type.fields, { jsonCase: "eth2" });
        proofContainers.set(type, container);
      }
      type = container;
    }

    if (!isCompositeType(type)) {
      throw new RequestError(`Cannot navigate below basic type ${type.typeName}`);
    }
    if ("elementType" in type) {
      if (typeof property !== "number") throw new RequestError("Array paths require an integer index");
      const bound = "limit" in type ? type.limit : "length" in type ? type.length : undefined;
      if (typeof bound === "number" && property >= bound) {
        throw new RequestError(`Path index ${property} exceeds the ${type.typeName} bound`);
      }
    }

    const index = type.getPropertyGindex(property);
    if (typeof index !== "bigint" || index < BigInt(1)) {
      throw new RequestError(`Cannot navigate below ${type.typeName}`);
    }
    indices.push(index);
    type = type.getPropertyType(property);
  }
  return concatGindices(indices);
}

export const getGindexFromQueryParams = (
  pathResolution: "block" | "state",
  queryParams: Record<string, unknown>,
  forkName?: ForkName
): bigint => {
  const { gindex: rawGindex, path } = queryParams;
  if ((rawGindex === undefined) === (path === undefined)) {
    throw new RequestError("Specify exactly one of gindex or path");
  }
  if (rawGindex !== undefined) return parseGindex(rawGindex) as bigint;
  if (ACTIVE_PRESET !== "mainnet") {
    throw new UnsupportedForkError("Path proofs require the prover's mainnet SSZ preset");
  }
  if (forkName === undefined || !Object.values(ForkName).includes(forkName)) {
    throw new RequestError("A supported fork is required to resolve a path");
  }

  const parsedPath = parsePath(path);
  try {
    return resolvePath(pathResolution, parsedPath, forkName);
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(`Could not resolve ${pathResolution} path for fork ${forkName}`);
  }
};
