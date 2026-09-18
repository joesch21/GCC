require("@nomicfoundation/hardhat-toolbox");

const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || "UNSET";

module.exports = {
  solidity: {
    version: "0.8.37",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 56,
    },
    bsc: {
      url:
        process.env.BSC_RPC_URL ||
        "https://bsc-dataseed.binance.org/",
      chainId: 56,
    },
  },
  etherscan: {
    apiKey: {
      bsc: ETHERSCAN_API_KEY,
    },
    customChains: [
      {
        network: "bsc",
        chainId: 56,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=56",
          browserURL: "https://bscscan.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};
