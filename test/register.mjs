import { register } from "node:module";

register("ts-node/esm", new URL("../", import.meta.url));
