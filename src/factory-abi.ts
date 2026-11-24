// Base Standard factory ABI entries from the exact Sourcify runtime match.
export const factoryAbi = [
  {
    "name": "Launched",
    "type": "event",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "PoolId"
      },
      {
        "name": "originalCreator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "quoteToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "launchSupply",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "tickSpacing",
        "type": "int24",
        "indexed": false,
        "internalType": "int24"
      }
    ],
    "anonymous": false
  },
  {
    "name": "configVersion",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "createLaunch",
    "type": "function",
    "inputs": [
      {
        "name": "launchParams",
        "type": "tuple",
        "components": [
          {
            "name": "tokenName",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tokenSymbol",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "tokenContractURI",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "creatorSalt",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "quoteToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "expectedConfigVersion",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "metadataKeys",
            "type": "string[]",
            "internalType": "string[]"
          },
          {
            "name": "metadataValues",
            "type": "string[]",
            "internalType": "string[]"
          }
        ],
        "internalType": "struct LaunchpadFactoryCore.LaunchParams"
      }
    ],
    "outputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "poolId",
        "type": "bytes32",
        "internalType": "PoolId"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "name": "creatorRights",
    "type": "function",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "rights",
        "type": "tuple",
        "components": [
          {
            "name": "originalCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "currentCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "pendingCreator",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "creatorFeeRecipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "poolId",
            "type": "bytes32",
            "internalType": "PoolId"
          },
          {
            "name": "metadataEditable",
            "type": "bool",
            "internalType": "bool"
          }
        ],
        "internalType": "struct LaunchpadFactoryCore.CreatorRights"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchCreationEnabled",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "launchSupply",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "nativeLaunchFee",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "quoteConfig",
    "type": "function",
    "inputs": [
      {
        "name": "quoteToken",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "registered",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "quoteDecimals",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "startTickToken0Frame",
        "type": "int24",
        "internalType": "int24"
      }
    ],
    "stateMutability": "view"
  }
] as const;
