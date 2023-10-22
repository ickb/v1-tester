import { key } from "@ckb-lumos/hd";
import {
    TransactionBuilder, defaultScript, fund, initializeChainAdapter, secp256k1SignerFrom
} from "lumos-utils";

import { newLimitOrderUtils, ickbSudtScript } from "v1-core";

import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { BI, parseUnit } from "@ckb-lumos/bi";
import { Script } from "@ckb-lumos/base";

async function main() {

    await initializeChainAdapter("devnet", config as Config);
    const { create, sudtHash } = newLimitOrderUtils();

    const privKey = "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc";
    const pubKey = key.privateToPublic(privKey);
    const accountLock: Script = {
        ...defaultScript("SECP256K1_BLAKE160"),
        args: key.publicKeyToBlake160(pubKey)
    };

    const { txHash } = await (await fund(new TransactionBuilder(accountLock, secp256k1SignerFrom(privKey))
        .add("output", "end", create({
            ckbAmount: parseUnit("1000", "ckb"),
            terminalLock: accountLock,
            sudtHash,
            isSudtToCkb: false,
            ckbMultiplier: BI.from(1),
            sudtMultiplier: BI.from(1),
        })))).buildAndSend();

    console.log(txHash);
}

main();