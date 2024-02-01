import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { TransactionSkeleton } from "@ckb-lumos/helpers";
import {
    I8Cell, addCells, capacitiesSifter, ckbFundAdapter, fund, getCells, getTipHeader,
    initializeChainAdapter, secp256k1Blake160, sendTransaction, sudtSifter
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, ckbSoftCapPerDeposit, ickbExchangeRatio, ickbSudtFundAdapter, limitOrder
} from "@ickb/v1-core";

async function main() {
    const args = process.argv.slice(2)
    if (args.length != 1 || (args[0] !== "SUDT2CKB" && args[0] !== "CKB2SUDT")) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }

    await initializeChainAdapter("devnet", config as Config);

    const { sudtHash, sudtType, create } = limitOrder();

    //Genesis devnet account
    const {
        lockScript,
        expander,
        preSigner,
        signer
    } = secp256k1Blake160(
        "0xd00c06bfd800d27397002dca6fb0993d5ba6399b4238b2f29ee9deb97593d2bc"
    );

    const accountCells = await getCells({
        script: lockScript,
        scriptType: "lock",
        scriptSearchMode: "exact"
    });
    const { owned: capacities, unknowns } = capacitiesSifter(accountCells, expander);
    const { owned: sudts } = sudtSifter(unknowns, sudtType, expander);

    // const feeRate = await getFeeRate();
    const feeRate = 1000;
    let assets = ckbFundAdapter(lockScript, feeRate, preSigner, capacities);
    assets = ickbSudtFundAdapter(assets, lockScript, sudts);

    const tipHeader = await getTipHeader();
    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(tipHeader);

    let tx = TransactionSkeleton();
    tx = create(tx, {
        ckbAmount: args[0] == "CKB2SUDT" ? ckbSoftCapPerDeposit(tipHeader).div(2) : undefined,
        sudtAmount: args[0] == "SUDT2CKB" ? ICKB_SOFT_CAP_PER_DEPOSIT.div(2) : undefined,
        terminalLock: lockScript,
        sudtHash,
        isSudtToCkb: args[0] == "SUDT2CKB",
        ckbMultiplier,
        sudtMultiplier,
    });

    //Consolidate CKB miner reward cells into bigger cells
    // console.log(assets["CKB"].addFunds.length);
    if (assets["CKB"].addFunds.length > 10) {
        tx = addCells(tx, "append", [], [
            I8Cell.from({
                lock: lockScript,
                capacity: ckbSoftCapPerDeposit(tipHeader).mul(10000).toHexString()
            })
        ]);
        tx = fund(tx, assets, false);
    } else {
        tx = fund(tx, assets, true);
    }


    const txHash = await sendTransaction(signer(tx));
    console.log(txHash);
}

main();