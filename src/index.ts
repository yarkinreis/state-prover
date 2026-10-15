import { createApp } from "./app.js";
import { EthAPI, type NETWORK } from "./eth.js";
import { getConfig, supportedNetworks } from "./utils.js";

const { port, beaconUrls } = getConfig();
const ethAPIs: Partial<Record<NETWORK, EthAPI>> = {};

for (const network of supportedNetworks) {
  const url = beaconUrls[network];
  if (url) ethAPIs[network] = new EthAPI(url, network);
}

createApp(ethAPIs).listen(port, () => {
  console.log(`State prover listening on http://localhost:${port}`);
});
