import "dotenv/config";
import { NETWORK } from "./eth";
import { ForkName } from "@lodestar/params";
import { sszTypesFor } from "@lodestar/types";

export const supportedNetworks: NETWORK[] = ["holesky", "sepolia", "mainnet", "hoodi"];

export function getConfig(): { port: number; beaconUrls: { [key in NETWORK]: string | null } } {
  const port = +getEnv("PORT", "3000");

  const beaconUrls: { [key in NETWORK]: string } = supportedNetworks.reduce((acc, network) => {
    acc[network] = getEnv(`${network.toUpperCase()}_BEACON_API`);
    return acc;
  }, {} as { [key in NETWORK]: string });

  const config = { port, beaconUrls };
  console.log("Loaded config", config);
  return config;
}

export const getEnv = (key: string, defaultValue?: string): string => {
  if (!process.env[key] && !defaultValue) {
    throw new Error(`Environment variable ${key} not set`);
  }
  // @ts-ignore
  return process.env[key] || defaultValue;
};

export const parseGindex = (gindex?: string): number | null => {
  console.log("parseGindex input =", gindex, Number(gindex), Number.isNaN(Number(gindex)));
  return gindex === undefined || Number.isNaN(Number(gindex)) ? null : Number(gindex);
};

export const parsePath = (path: string): (string | number)[] => {
  return path.split(",").map((p) => {
    const parsed = Number(p);
    return Number.isNaN(parsed) ? p : parsed;
  });
};

/**
 * Try multiple forks to resolve path → gindex.
 * We keep the list strictly in the ForkName union to keep TS happy.
 */
function tryResolvePathWithForks(
  pathResolution: "block" | "state",
  parsedPath: (string | number)[],
  preferred: ForkName
): number {
  // order: preferred first, then reasonable fallbacks
  const candidates: ForkName[] = [
    preferred,
    "electra",
    "deneb",
    "capella",
    "bellatrix",
    "altair",
    "phase0",
  ].filter((v, i, arr) => arr.indexOf(v) === i) as ForkName[];

  let lastError: unknown = null;

  for (const fork of candidates) {
    try {
      const types = sszTypesFor(fork);
      const info =
        pathResolution === "block"
          ? types.BeaconBlock.getPathInfo(parsedPath)
          : types.BeaconState.getPathInfo(parsedPath);
      console.log(
        `✅ resolved path ${parsedPath.join(",")} with fork=${fork} → gindex=${info.gindex}`
      );
      return Number(info.gindex);
    } catch (err) {
      lastError = err;
      // keep looping
    }
  }

  console.error(
    `❌ Could not resolve path ${parsedPath.join(",")} with any known fork. Last error:`,
    (lastError as any)?.message || lastError
  );
  throw new Error("Could not resolve path to gindex");
}

export const getGindexFromQueryParams = (
  pathResolution: "block" | "state",
  queryParams: Record<string, any>,
  forkName: ForkName
): number | null => {
  const { gindex: rawGindex, path } = queryParams;
  console.log("PATH", path);

  const validateGindex = (g: any): number => {
    const parsedGindex = Number(g);
    if (Number.isNaN(parsedGindex)) {
      throw new Error("Invalid gindex");
    }
    return parsedGindex;
  };

  // if user passed ?gindex=..., just take it
  if (rawGindex !== undefined) {
    return validateGindex(rawGindex);
  }

  if (path === undefined) {
    throw new Error("Both gindex and path are missing");
  }

  const parsedPath = parsePath(path);

  // resolve using the multi-fork helper
  return tryResolvePathWithForks(pathResolution, parsedPath, forkName);
};