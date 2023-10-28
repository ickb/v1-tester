import {
    TransactionBuilder, fund, initializeChainAdapter, secp256k1SignerFrom
} from "lumos-utils";

import { newLimitOrderUtils } from "v1-core";

import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { BI, parseUnit } from "@ckb-lumos/bi";
import { Account, randomSecp256k1Account } from "./account";

async function main() {
    await initializeChainAdapter("devnet", config as Config);
    const { create, sudtHash } = newLimitOrderUtils();

    //Genesis account
    const genesisAccount = randomSecp256k1Account("0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc");

    const newTransactionBuilder = (account: Account) => new TransactionBuilder(
        account.lockScript,
        secp256k1SignerFrom(account.privKey)
    );

    const { txHash } = await (await fund(newTransactionBuilder(genesisAccount)
        .add("output", "end", create({
            ckbAmount: parseUnit("1000", "ckb"),
            terminalLock: genesisAccount.lockScript,
            sudtHash,
            isSudtToCkb: false,
            ckbMultiplier: BI.from(1),
            sudtMultiplier: BI.from(1),
        })))).buildAndSend();

    console.log(txHash);
}

main();