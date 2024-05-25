# iCKB v1 tester

## Run the simulation of limit order creation on testnet

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-tester.git
```

2. Enter into the repo folder:

```bash
cd v1-tester
```

3. Install dependencies:

```bash
pnpm install
```

4. Build project:

```bash
pnpm build
```

5. Define a `env/testnet/.env` file, for example:

```
CHAIN=testnet
TESTER_PRIVATE_KEY=0x-YOUR-SECP256K1-BLAKE160-PRIVATE-KEY
TESTER_SLEEP_INTERVAL=10
```

Optionally the property `RPC_URL` can also be specified:

```
RPC_URL=http://127.0.0.1:8114/
```

6. Start simulation of user interactions:

```bash
export CHAIN=testnet;
pnpm run start;
```

## Licensing

The license for this repository is the MIT License, see the [`LICENSE`](./LICENSE).
