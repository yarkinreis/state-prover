import express, { type Request, type Response } from "express";
import cors from "cors";
import { toHexString } from "@chainsafe/ssz";
import type { SingleProof } from "@chainsafe/persistent-merkle-tree";
import type { EthAPI, NETWORK } from "./eth.js";
import { LodestarError, RequestError, UnsupportedForkError } from "./errors.js";
import { getGindexFromQueryParams, parsePath, supportedNetworks } from "./utils.js";

export type ProofClient = Pick<EthAPI,
  "resolveStateId" | "resolveBlockId" | "getForkNameByStateId" |
  "getForkNameByBlockId" | "getStateProof" | "getBlockProof"
>;

function identifier(value: unknown, name: string): string {
  if (value === undefined) throw new RequestError(`Missing ${name}`);
  if (typeof value !== "string" || !/^(head|genesis|finalized|justified|[0-9]+|0x[0-9a-fA-F]{64})$/.test(value)) {
    throw new RequestError(`Invalid ${name}`);
  }
  if (/^[0-9]+$/.test(value) && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RequestError(`${name} slot exceeds the supported integer range`);
  }
  return value;
}

function serializeProof(proof: SingleProof) {
  return {
    type: proof.type,
    gindex: proof.gindex.toString(),
    leaf: toHexString(proof.leaf),
    witnesses: proof.witnesses.map(toHexString),
  };
}

function sendError(res: Response, error: unknown) {
  const status = error instanceof RequestError || error instanceof UnsupportedForkError || error instanceof LodestarError
    ? error.code : 500;
  return res.status(status).send(error instanceof Error ? error.message : "Internal server error");
}

export function createApp(clients: Partial<Record<NETWORK, ProofClient>>) {
  const app = express();
  app.use(cors());

  function clientFor(req: Request): ProofClient {
    const network = req.query.network ?? "mainnet";
    if (typeof network !== "string" || !supportedNetworks.includes(network as NETWORK)) {
      throw new RequestError("Invalid network");
    }
    const client = clients[network as NETWORK];
    if (!client) throw new RequestError(`Beacon API is not configured for network ${network}`);
    return client;
  }

  for (const kind of ["state", "block"] as const) {
    app.get(`/${kind}_proof`, async (req, res) => {
      try {
        const client = clientFor(req);
        const id = identifier(req.query[`${kind}_id`], `${kind}_id`);
        const { path, gindex: rawGindex } = req.query;
        // Validate before contacting the beacon node, including ambiguous queries.
        if (path !== undefined && rawGindex !== undefined) {
          throw new RequestError("Provide exactly one of path or gindex");
        }
        if (path !== undefined) {
          if (typeof path !== "string") throw new RequestError("Invalid path");
          parsePath(path);
        }
        const explicitGindex = path === undefined
          ? getGindexFromQueryParams(kind, req.query) : undefined;
        const pinnedId = kind === "state"
          ? await client.resolveStateId(id) : await client.resolveBlockId(id);
        // Raw gindices already describe the Merkle path and do not need an SSZ schema.
        const fork = explicitGindex === undefined
          ? await (kind === "state" ? client.getForkNameByStateId(pinnedId) : client.getForkNameByBlockId(pinnedId))
          : undefined;
        const gindex = explicitGindex ?? getGindexFromQueryParams(kind, req.query, fork);
        const proof = kind === "state"
          ? await client.getStateProof(pinnedId, gindex, fork)
          : await client.getBlockProof(pinnedId, gindex, fork);
        return res.json(serializeProof(proof));
      } catch (error) {
        return sendError(res, error);
      }
    });
  }

  app.get("/has_state", async (req, res) => {
    try {
      const client = clientFor(req);
      const stateId = identifier(req.query.state_id, "state_id");
      const pinnedId = await client.resolveStateId(stateId);
      await client.getStateProof(pinnedId, 1n);
      return res.sendStatus(200);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return app;
}
