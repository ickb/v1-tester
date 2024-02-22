# iCKB v1 interface

## Run the simulation of limit order creation on testnet

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-interface.git
```

2. Enter into the repo folder:

```bash
cd v1-interface
```

3. Install dependencies:

```bash
npm i
```

4. Define a `env/testnet/.env` file, for example:

```
CHAIN=testnet
INTERFACE_PRIVATE_KEY=0x-YOUR-SECP256K1-BLAKE160-PRIVATE-KEY
```

Optionally the property `RPC_URL` can also be specified:

```
RPC_URL=http://127.0.0.1:8114/
```

5. Start simulation of user interactions:

```bash
npm run start --chain=testnet
```

## Licensing

The license for this repository is the MIT License, see the [`LICENSE`](./LICENSE).
