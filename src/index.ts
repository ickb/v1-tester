import { TransactionSkeleton } from "@ckb-lumos/helpers";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import {
    CKB, I8Cell, I8Script, addCells, addCkbAsset, addSimpleCells, ckbDelta, ckbMark, errorNotEnoughFunds, fund,
    getCells, getChainInfo, getFeeRate, getTipHeader, hex, initializeChainAdapter, isChain, secp256k1Blake160,
    sendTransaction, simpleSifter
} from "@ickb/lumos-utils";
import {
    ICKB_SOFT_CAP_PER_DEPOSIT, addIckbAsset, addOrders, ckb2Ickb, ckbSoftCapPerDeposit, getIckbScriptConfigs,
    ickb2Ckb, ickbExchangeRatio, ickbMark, ickbUdtType, limitOrderScript, orderMelt, orderMint, orderSifter
} from "@ickb/v1-core";
import type { MyOrder, OrderRatio } from "@ickb/v1-core";

async function main() {
    const { CHAIN, RPC_URL, CLIENT_TYPE, TESTER_PRIVATE_KEY, TESTER_SLEEP_INTERVAL } = process.env;
    if (!isChain(CHAIN)) {
        throw Error("Invalid env CHAIN: " + CHAIN);
    }
    if (CHAIN === "mainnet") {
        throw Error("Not yet ready for mainnet...")
    }
    if (!TESTER_PRIVATE_KEY) {
        throw Error("Empty env TESTER_PRIVATE_KEY")
    }
    if (!TESTER_SLEEP_INTERVAL || Number(TESTER_SLEEP_INTERVAL) < 1) {
        throw Error("Invalid env TESTER_SLEEP_INTERVAL")
    }

    await initializeChainAdapter(CHAIN, RPC_URL, CLIENT_TYPE === "light" ? true : undefined, getIckbScriptConfigs);
    const account = secp256k1Blake160(TESTER_PRIVATE_KEY);
    const sleepInterval = Number(TESTER_SLEEP_INTERVAL) * 1000;

    while (true) {
        let executionLog: any = {};
        let startTime = new Date();
        executionLog.startTime = startTime.toLocaleString();
        try {
            const { capacities, udts, myOrders } = await siftCells(account);

            const tipHeader = await getTipHeader();
            const feeRate = await getFeeRate();
            const minChange = 0n;//Use minChange as relevant instead of setApartEmergencyCKB /////////////////////////

            let assets = addCkbAsset({}, account.lockScript, feeRate, account.preSigner, minChange);
            assets = addIckbAsset(assets, account.lockScript);
            assets = addSimpleCells(assets, capacities, udts);
            assets = addOrders(assets, myOrders);

            executionLog.balance = {
                "CKB": {
                    total: fmtCkb(assets[ckbMark].estimated),
                    available: fmtCkb(assets[ckbMark].estimatedAvailable),
                    unavailable: fmtCkb(assets[ckbMark].estimated - assets[ckbMark].estimatedAvailable),
                }, "ICKB": {
                    total: fmtCkb(assets[ickbMark].estimated),
                    available: fmtCkb(assets[ickbMark].estimatedAvailable),
                    unavailable: fmtCkb(assets[ickbMark].estimated - assets[ickbMark].estimatedAvailable),
                }, "totalEquivalent": {
                    "CKB": fmtCkb(assets[ckbMark].estimated + ickb2Ckb(assets[ickbMark].estimated, tipHeader)),
                    "ICKB": fmtCkb(ckb2Ickb(assets[ckbMark].estimated, tipHeader) + assets[ickbMark].estimated),
                }
            };
            executionLog.ratio = ickbExchangeRatio(tipHeader);

            const ickbEquivalentBalance = Number(ckb2Ickb(assets[ckbMark].estimated, tipHeader));
            const ickbBalance = Number(assets[ickbMark].estimated);

            let r = Math.random();
            const isCkb2Udt = Math.round((ickbEquivalentBalance + ickbBalance) * r) <= ickbEquivalentBalance;
            // const isCkb2Udt = false;
            // const isCkb2Udt = true;

            r = Math.random();
            const ckbAmount = isCkb2Udt ? BigInt(Math.round(r * Number(ckbSoftCapPerDeposit(tipHeader)))) : 0n;
            const udtAmount = isCkb2Udt ? 0n : BigInt(Math.round(r * Number(ICKB_SOFT_CAP_PER_DEPOSIT)));

            let { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(tipHeader);
            //Pay 0.1% fee to bot
            if (isCkb2Udt) {
                udtMultiplier = udtMultiplier + udtMultiplier / 1000n;
            } else {
                udtMultiplier = udtMultiplier - udtMultiplier / 1000n;
            }

            const ratio: OrderRatio = {
                ckbMultiplier,
                udtMultiplier,
            }

            //Cancel old CKB -> UDT orders
            const maxElapsedBlocks = getChainInfo().chain === "devnet" ? 1000n : 100800n;
            const oldOrders: MyOrder[] = [];
            for (const o of myOrders) {
                if (!o.info.isCkb2UdtMatchable) {
                    continue;
                }
                if (BigInt(o.cell.blockNumber!) + maxElapsedBlocks >= BigInt(tipHeader.number)) {
                    continue;
                }
                oldOrders.push(o);
            }

            let tx = TransactionSkeleton()
            tx = orderMint(tx, {
                accountLock: account.lockScript,
                ckbAmount,
                udtAmount,
                ckbToUdt: isCkb2Udt ? ratio : undefined,
                udtToCkb: isCkb2Udt ? undefined : ratio
            });
            if (isCkb2Udt) {
                tx = setApartEmergencyCKB(tx, account.lockScript);
            }
            tx = orderMelt(tx, ...oldOrders);

            // console.log(JSON.stringify(tx, undefined, 2));

            try {
                tx = fund(tx, assets, true);
                executionLog.actions = {
                    newOrder: (isCkb2Udt ? {
                        giveCkb: fmtCkb(ckbAmount),
                        takeIckb: fmtCkb(ckbAmount * ratio.ckbMultiplier / ratio.udtMultiplier),
                        fee: fmtCkb(
                            ckbAmount - ickb2Ckb(ckbAmount * ratio.ckbMultiplier / ratio.udtMultiplier, tipHeader)
                        )
                    } : {
                        giveIckb: fmtCkb(udtAmount),
                        takeCkb: fmtCkb(udtAmount * ratio.udtMultiplier / ratio.ckbMultiplier),
                        fee: fmtCkb(
                            ickb2Ckb(udtAmount, tipHeader) - (udtAmount * ratio.udtMultiplier / ratio.ckbMultiplier)
                        )
                    }),
                    cancelledOrders: oldOrders.length,
                };
                executionLog.txFee = {
                    fee: fmtCkb(ckbDelta(tx, 0n)),
                    feeRate,
                };
                executionLog.txHash = await sendTransaction(account.signer(tx));
            } catch (e: any) {
                if (!e || e.message !== errorNotEnoughFunds) {
                    throw e;
                }
                //Handle not enough funds, try just to cancel old orders
                if (oldOrders.length > 0) {
                    tx = TransactionSkeleton();
                    tx = orderMelt(tx, ...oldOrders);
                    tx = fund(tx, assets, true);
                    executionLog.actions = {
                        cancelledOrders: oldOrders.length,
                    };
                    executionLog.txFee = {
                        fee: Number(ckbDelta(tx, 0n)) / Number(CKB),
                        feeRate: Number(ckbDelta(tx, 0n)) / Number(CKB),
                    };
                    executionLog.txHash = await sendTransaction(account.signer(tx));
                }
            }
        } catch (e: any) {
            if (e) {
                executionLog.error = { ...e, stack: e.stack ?? "" };
            } else {
                executionLog.message = "Empty";
            }
        }
        executionLog.ElapsedSeconds = Math.round((new Date().getTime() - startTime.getTime()) / 1000);
        console.log(JSON.stringify(executionLog, replacer, " ") + ",");

        await new Promise(r => setTimeout(r, sleepInterval));
    }
}

function fmtCkb(b: bigint) {
    return Number(b) / Number(CKB);
}

function replacer(_: unknown, value: unknown) {
    return typeof value === "bigint" ? Number(value) : value
};

function setApartEmergencyCKB(tx: TransactionSkeletonType, accountLock: I8Script) {
    let c = I8Cell.from({ lock: accountLock, capacity: hex(1000n * CKB) });
    return addCells(tx, "append", [], [c]);
}

async function siftCells(account: ReturnType<typeof secp256k1Blake160>) {
    const cells = (await Promise.all([
        getCells({
            script: account.lockScript,
            scriptType: "lock",
            scriptSearchMode: "exact"
        }),
        getCells({
            script: limitOrderScript(),
            scriptType: "lock",
            scriptSearchMode: "prefix"
        })
    ])).flat();

    const { notSimples, capacities, types: udts } = simpleSifter(cells, ickbUdtType(), account.expander);
    const { myOrders } = orderSifter(notSimples, account.expander);

    return { capacities, udts, myOrders };
}

main();