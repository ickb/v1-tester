import { BI, parseUnit } from "@ckb-lumos/bi";
import config from "./config.json";
import { Config } from "@ckb-lumos/config-manager";
import { TransactionSkeleton } from "@ckb-lumos/helpers";
import {
    ckbFundAdapter, fund, genesisDevnetKey, getCells, getFeeRate, getTipHeader,
    initializeChainAdapter, isChain, secp256k1Blake160, sendTransaction, simpleSifter
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, ckb2Ickb, ckbSoftCapPerDeposit, ickbExchangeRatio,
    ickbSudtFundAdapter, limitOrder, limitOrderFundAdapter
} from "@ickb/v1-core";

async function main() {
    const args = process.argv.slice(2);
    const [chain, rpcUrl, clientType] = args;

    if (args.length < 1 || args.length > 3
        || !isChain(chain)
        || !(clientType in clientType2IsLightClient)) {
        throw Error("Invalid command line arguments " + args.join(" "));
    }

    await initializeChainAdapter(chain, config as Config, rpcUrl, clientType2IsLightClient[clientType]);

    if (chain === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }

    const testingKey = "0x62b230406e3577dd9f7b0e9b4633b56c7a670a9fce38e5c3ec4a19e868c575d7";
    let account = secp256k1Blake160(testingKey);
    const limitOrderInfo = limitOrder();

    const { capacities, sudts, ckb2SudtOrders, sudt2ckbOrders } = await siftCells(account, limitOrderInfo);

    if (capacities.length === 0 && sudts.length === 0) {
        console.log("Funding limit order creator");
        const genesisAccount = secp256k1Blake160(genesisDevnetKey);
        const txHash = await genesisAccount.transfer(account.lockScript, parseUnit("1000000", "ckb"));
        console.log(txHash);
        return;
    }

    const tipHeader = await getTipHeader();
    const feeRate = await getFeeRate();

    let assets = ckbFundAdapter(account.lockScript, feeRate, account.preSigner, capacities);
    assets = ickbSudtFundAdapter(assets, account.lockScript, sudts);
    assets = limitOrderFundAdapter(assets, ckb2SudtOrders, sudt2ckbOrders);

    console.log("CKB :", assets["CKB"].balance.div(100000000).toString());
    console.log("ICKB:", assets["ICKB_SUDT"].balance.div(100000000).toString());

    const { ckbMultiplier, sudtMultiplier } = ickbExchangeRatio(tipHeader);

    const ickbEquivalentBalance = ckb2Ickb(assets["CKB"].balance, tipHeader).toNumber();
    const ickbBalance = assets["ICKB_SUDT"].balance.toNumber();

    const r0 = Math.random();
    const isSudtToCkb = Math.round((ickbEquivalentBalance + ickbBalance) * r0) > ickbEquivalentBalance;
    console.log(isSudtToCkb ? "SUDT -> CKB" : "CKB -> SUDT");

    const r1 = Math.random();
    const ckbAmount = !isSudtToCkb ? BI.from(Math.round(r1 * ckbSoftCapPerDeposit(tipHeader).toNumber())) : undefined;
    const sudtAmount = isSudtToCkb ? BI.from(Math.round(r1 * ICKB_SOFT_CAP_PER_DEPOSIT.toNumber())) : undefined;

    let tx = TransactionSkeleton();
    tx = limitOrderInfo.create(tx, {
        ckbAmount,
        sudtAmount,
        terminalLock: account.lockScript,
        sudtHash: limitOrderInfo.sudtHash,
        isSudtToCkb,
        ckbMultiplier,
        sudtMultiplier,
    });

    tx = fund(tx, assets);

    const txHash = await sendTransaction(account.signer(tx));
    console.log(txHash);
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
    const { ckb2SudtOrders, sudt2ckbOrders } = limitOrderInfo.sifter(notSimples, account.lockScript);

    return {
        capacities, sudts,
        ckb2SudtOrders, sudt2ckbOrders
    }
}

const clientType2IsLightClient: { [id: string]: boolean } = {
    "light": true,
    "full": false,
    undefined: false
};

main();