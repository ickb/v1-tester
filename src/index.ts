import { BI, parseUnit } from "@ckb-lumos/bi";
import { Config } from "@ckb-lumos/config-manager";
import { TransactionSkeleton } from "@ckb-lumos/helpers";
import {
    ckbFundAdapter, fund, getCells, getFeeRate, getTipHeader,
    initializeChainAdapter, isChain, secp256k1Blake160, sendTransaction, simpleSifter
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, ckb2Ickb, ckbSoftCapPerDeposit, ickbExchangeRatio,
    ickbSudtFundAdapter, limitOrder, limitOrderFundAdapter
} from "@ickb/v1-core";

async function main() {
    const { CHAIN, RPC_URL, CLIENT_TYPE, INTERFACE_PRIVATE_KEY, FUNDING_PRIVATE_KEY } = process.env;
    if (!isChain(CHAIN)) {
        throw Error("Invalid env CHAIN: " + CHAIN);
    }
    if (CHAIN === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }
    if (!INTERFACE_PRIVATE_KEY) {
        throw Error("Empty env INTERFACE_PRIVATE_KEY")
    }
    const config: Config = await import(`../env/${CHAIN}/config.json`);
    await initializeChainAdapter(CHAIN, config, RPC_URL, CLIENT_TYPE === "light" ? true : undefined);

    const account = secp256k1Blake160(INTERFACE_PRIVATE_KEY);
    const limitOrderInfo = limitOrder();

    const { capacities, sudts, ckb2SudtOrders, sudt2ckbOrders } = await siftCells(account, limitOrderInfo);

    if (capacities.length === 0 && sudts.length === 0) {
        if (!FUNDING_PRIVATE_KEY) {
            throw Error("Empty env FUNDING_PRIVATE_KEY")
        }
        console.log("Funding limit order creator");
        const fundingAccount = secp256k1Blake160(FUNDING_PRIVATE_KEY);
        const txHash = await fundingAccount.transfer(account.lockScript, parseUnit("1000000", "ckb"));
        console.log(txHash);
        return;
    }

    const tipHeader = await getTipHeader();
    const feeRate = await getFeeRate();

    let assets = ckbFundAdapter(account.lockScript, feeRate, account.preSigner, capacities);
    assets = ickbSudtFundAdapter(assets, account.lockScript, sudts);
    assets = limitOrderFundAdapter(assets, ckb2SudtOrders, sudt2ckbOrders);

    console.log(
        "CKB :",
        assets["CKB"].availableBalance.div(100000000).toString(),
        "+",
        assets["CKB"].balance.sub(assets["CKB"].availableBalance).div(100000000).toString()
    );

    console.log(
        "ICKB:",
        assets["ICKB_SUDT"].availableBalance.div(100000000).toString(),
        "+",
        assets["ICKB_SUDT"].balance.sub(assets["ICKB_SUDT"].availableBalance).div(100000000).toString()
    );

    const ickbEquivalentBalance = ckb2Ickb(assets["CKB"].balance, tipHeader).toNumber();
    const ickbBalance = assets["ICKB_SUDT"].balance.toNumber();

    const r0 = Math.random();
    const isSudtToCkb = Math.round((ickbEquivalentBalance + ickbBalance) * r0) > ickbEquivalentBalance;
    // const isSudtToCkb = false;
    // const isSudtToCkb = true;

    const r1 = Math.random();
    const ckbAmount = !isSudtToCkb ? BI.from(Math.round(r1 * ckbSoftCapPerDeposit(tipHeader).toNumber())) : undefined;
    const sudtAmount = isSudtToCkb ? BI.from(Math.round(r1 * ICKB_SOFT_CAP_PER_DEPOSIT.toNumber())) : undefined;

    let tx = TransactionSkeleton();

    //Cancel CKB -> SUDT orders older than 1000 blocks
    for (const o of ckb2SudtOrders) {
        if (BI.from(o.cell.blockNumber).add(1000).lt(tipHeader.number)) {
            console.log("Cancelling old CKB -> SUDT order");
            tx = limitOrderInfo.cancel(tx, o, false);
        } else {
            break;
        }
    }

    try {
        let { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(tipHeader);
        if (isSudtToCkb) {//Pay 0.1% fee to bot
            sudtMultiplier = sudtMultiplier.sub(sudtMultiplier.div(1000));
        } else {
            sudtMultiplier = sudtMultiplier.add(sudtMultiplier.div(1000));
        }

        const txWithNewOrder = limitOrderInfo.create(tx, {
            ckbAmount,
            sudtAmount,
            terminalLock: account.lockScript,
            sudtHash: limitOrderInfo.sudtHash,
            isSudtToCkb,
            ckbMultiplier,
            sudtMultiplier,
        });
        tx = fund(txWithNewOrder, assets, true);
        console.log(isSudtToCkb ? "SUDT -> CKB" : "CKB -> SUDT");
        const txHash = await sendTransaction(account.signer(tx));
        console.log(txHash);
    } catch (e: any) {
        if (tx.outputs.size > 0) {
            tx = fund(tx, assets, true);
            const txHash = await sendTransaction(account.signer(tx));
            console.log(txHash);
        }
    }
}

async function siftCells(
    account: ReturnType<typeof secp256k1Blake160>,
    limitOrderInfo: ReturnType<typeof limitOrder>
) {
    const cells = (await Promise.all([
        getCells({
            script: account.lockScript,
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: limitOrderInfo.limitOrderLock,
            scriptType: "lock",
            scriptSearchMode: "prefix"
        })
    ])).flat();

    const { capacities, sudts, notSimples } = simpleSifter(cells, limitOrderInfo.sudtType, account.expander);
    const { ckb2SudtOrders, sudt2ckbOrders } = limitOrderInfo.sifter(notSimples, account.lockScript, "desc");

    return {
        capacities, sudts,
        ckb2SudtOrders, sudt2ckbOrders
    }
}

main();