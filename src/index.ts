import {
  TransactionSkeleton,
  encodeToAddress,
  sealTransaction,
} from "@ckb-lumos/helpers";
import type { TransactionSkeletonType } from "@ckb-lumos/helpers";
import { key } from "@ckb-lumos/hd";
import { prepareSigningEntries } from "@ckb-lumos/common-scripts/lib/secp256k1_blake160.js";
import {
  CKB,
  I8Cell,
  I8Header,
  I8Script,
  addCells,
  addCkbChange,
  addWitnessPlaceholder,
  chainConfigFrom,
  ckbDelta,
  isChain,
  lockExpanderFrom,
  min,
  simpleSifter,
  type ChainConfig,
  type ConfigAdapter,
} from "@ickb/lumos-utils";
import {
  ICKB_SOFT_CAP_PER_DEPOSIT,
  addIckbUdtChange,
  addOwnedWithdrawalRequestsChange,
  addReceiptDepositsChange,
  addWithdrawalRequestGroups,
  ckb2Ickb,
  ckbSoftCapPerDeposit,
  getIckbScriptConfigs,
  ickb2Ckb,
  ickbDelta,
  ickbExchangeRatio,
  ickbUdtType,
  limitOrderScript,
  orderMelt,
  orderMint,
  orderSifter,
} from "@ickb/v1-core";
import type { MyOrder, OrderRatio } from "@ickb/v1-core";

async function main() {
  const { CHAIN, RPC_URL, TESTER_PRIVATE_KEY, TESTER_SLEEP_INTERVAL } =
    process.env;
  if (!isChain(CHAIN)) {
    throw Error("Invalid env CHAIN: " + CHAIN);
  }
  if (CHAIN === "mainnet") {
    throw Error("Not yet ready for mainnet...");
  }
  if (!TESTER_PRIVATE_KEY) {
    throw Error("Empty env TESTER_PRIVATE_KEY");
  }
  if (!TESTER_SLEEP_INTERVAL || Number(TESTER_SLEEP_INTERVAL) < 1) {
    throw Error("Invalid env TESTER_SLEEP_INTERVAL");
  }

  const chainConfig = await chainConfigFrom(
    CHAIN,
    RPC_URL,
    true,
    getIckbScriptConfigs,
  );
  const { config, rpc, chain } = chainConfig;
  const account = secp256k1Blake160(TESTER_PRIVATE_KEY, config);
  const sleepInterval = Number(TESTER_SLEEP_INTERVAL) * 1000;

  while (true) {
    await new Promise((r) => setTimeout(r, 2 * Math.random() * sleepInterval));
    console.log();

    let executionLog: any = {};
    let startTime = new Date();
    executionLog.startTime = startTime.toLocaleString();
    try {
      const { capacities, udts, myOrders } = await siftCells(
        account,
        chainConfig,
      );

      const tipHeader = I8Header.from(await rpc.getTipHeader());
      const feeRate = await rpc.getFeeRate(61n);

      const maxElapsedBlocks = chain === "devnet" ? 500n : 100800n;
      // Wait for new orders to be matched
      if (
        myOrders.some(
          (o) =>
            BigInt(o.cell.blockNumber!) + maxElapsedBlocks >=
              BigInt(tipHeader.number) && o.info.isMatchable,
        )
      ) {
        continue;
      }

      // Calculate balances and baseTx
      const baseTx = base({
        capacities,
        myOrders,
        udts,
        receipts: [],
        wrGroups: [],
      });
      const ckbBalance = ckbDelta(baseTx, 0n, config);
      const ickbUdtBalance = ickbDelta(baseTx, config);

      executionLog.balance = {
        CKB: {
          total: fmtCkb(ckbBalance),
          available: fmtCkb(ckbBalance),
          unavailable: fmtCkb(0n),
        },
        ICKB: {
          total: fmtCkb(ickbUdtBalance),
          available: fmtCkb(ickbUdtBalance),
          unavailable: fmtCkb(0n),
        },
        totalEquivalent: {
          CKB: fmtCkb(ckbBalance + ickb2Ckb(ickbUdtBalance, tipHeader)),
          ICKB: fmtCkb(ckb2Ickb(ckbBalance, tipHeader) + ickbUdtBalance),
        },
      };
      executionLog.ratio = ickbExchangeRatio(tipHeader);

      let r = Math.random();
      const ickbEquivalentBalance = Number(ckb2Ickb(ckbBalance, tipHeader));
      const ickbBalance = Number(ickbUdtBalance);
      const isCkb2Udt =
        Math.round((ickbEquivalentBalance + ickbBalance) * r) <=
        ickbEquivalentBalance;
      // const isCkb2Udt = false;
      // const isCkb2Udt = true;

      r = Math.random();
      const ckbAmount = isCkb2Udt
        ? min(
            BigInt(
              Math.round(10 * r * Number(ckbSoftCapPerDeposit(tipHeader))),
            ),
            ckbBalance - 2000n * CKB,
          )
        : 0n;
      const udtAmount = isCkb2Udt
        ? 0n
        : min(
            BigInt(Math.round(10 * r * Number(ICKB_SOFT_CAP_PER_DEPOSIT))),
            ickbUdtBalance,
          );

      if (ckbAmount <= 0n && udtAmount <= 0) {
        executionLog.error =
          "Not enough funds to continue testing, shutting down...";
        console.log(JSON.stringify(executionLog, replacer, " "));
        return;
      }

      const { ckbMultiplier, udtMultiplier } = ickbExchangeRatio(tipHeader);
      const ratio: OrderRatio = {
        ckbMultiplier,
        //   Pay 0.1% fee to bot
        udtMultiplier:
          udtMultiplier + (isCkb2Udt ? 1n : -1n) * (udtMultiplier / 1000n),
      };

      const { tx, freeCkb, freeIckbUdt } = addChange(
        orderMint(
          baseTx,
          account.lockScript,
          config,
          isCkb2Udt ? ckbAmount : undefined,
          isCkb2Udt ? undefined : udtAmount,
          isCkb2Udt ? ratio : undefined,
          isCkb2Udt ? undefined : ratio,
        ),
        feeRate,
        account,
        chainConfig,
      );

      if (freeIckbUdt < 0n) {
        throw Error("Negative iCKB after the tx");
      }
      if (isCkb2Udt) {
        if (freeCkb < 1000n * CKB) {
          throw Error("Not enough CKB, less than 1000 CKB after the tx");
        }
      } else {
        if (freeCkb < 0n) {
          throw Error("Not enough CKB to execute the transaction");
        }
      }

      executionLog.actions = {
        newOrder: isCkb2Udt
          ? {
              giveCkb: fmtCkb(ckbAmount),
              takeIckb: fmtCkb(
                (ckbAmount * ratio.ckbMultiplier) / ratio.udtMultiplier,
              ),
              fee: fmtCkb(
                ckbAmount -
                  ickb2Ckb(
                    (ckbAmount * ratio.ckbMultiplier) / ratio.udtMultiplier,
                    tipHeader,
                  ),
              ),
            }
          : {
              giveIckb: fmtCkb(udtAmount),
              takeCkb: fmtCkb(
                (udtAmount * ratio.udtMultiplier) / ratio.ckbMultiplier,
              ),
              fee: fmtCkb(
                ickb2Ckb(udtAmount, tipHeader) -
                  (udtAmount * ratio.udtMultiplier) / ratio.ckbMultiplier,
              ),
            },
        cancelledOrders: myOrders.filter((o) => o.info.isMatchable).length,
      };
      executionLog.txFee = {
        fee: fmtCkb(ckbDelta(tx, 0n, config)),
        feeRate,
      };
      executionLog.txHash = await rpc.sendTransaction(account.signer(tx));
    } catch (e: any) {
      if (e) {
        executionLog.error = { ...e, stack: e.stack ?? "" };
      } else {
        executionLog.message = "Empty";
      }
    }
    executionLog.ElapsedSeconds = Math.round(
      (new Date().getTime() - startTime.getTime()) / 1000,
    );
    console.log(JSON.stringify(executionLog, replacer, " ") + ",");
  }
}

function fmtCkb(b: bigint) {
  return Number(b) / Number(CKB);
}

function replacer(_: unknown, value: unknown) {
  return typeof value === "bigint" ? Number(value) : value;
}

function base({
  capacities = [],
  udts = [],
  receipts = [],
  wrGroups = [],
  myOrders = [],
}: {
  capacities?: I8Cell[];
  udts?: I8Cell[];
  receipts?: I8Cell[];
  wrGroups?: Readonly<{
    ownedWithdrawalRequest: I8Cell;
    owner: I8Cell;
  }>[];
  myOrders?: MyOrder[];
}) {
  let tx = TransactionSkeleton();
  tx = addCells(tx, "append", [capacities, udts, receipts].flat(), []);
  tx = addWithdrawalRequestGroups(tx, wrGroups);
  tx = orderMelt(tx, myOrders);
  return tx;
}

function addChange(
  tx: TransactionSkeletonType,
  feeRate: bigint,
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { lockScript: accountLock, preSigner: addPlaceholders } = account;
  const { config } = chainConfig;
  let freeCkb, freeIckbUdt;
  tx = addReceiptDepositsChange(tx, accountLock, config);
  tx = addOwnedWithdrawalRequestsChange(tx, accountLock, config);
  ({ tx, freeIckbUdt } = addIckbUdtChange(tx, accountLock, config));
  ({ tx, freeCkb } = addCkbChange(
    tx,
    accountLock,
    feeRate,
    addPlaceholders,
    config,
  ));

  return { tx, freeCkb, freeIckbUdt };
}

async function siftCells(
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { rpc, config } = chainConfig;
  const cells = (
    await Promise.all(
      [account.lockScript, limitOrderScript(config)].map((lock) =>
        rpc.getCellsByLock(lock, "desc", "max"),
      ),
    )
  ).flat();

  const {
    notSimples,
    capacities,
    types: udts,
  } = simpleSifter(cells, ickbUdtType(config), account.expander);
  const { myOrders } = orderSifter(notSimples, account.expander, config);

  return { capacities, udts, myOrders };
}

function secp256k1Blake160(privateKey: string, config: ConfigAdapter) {
  const publicKey = key.privateToPublic(privateKey);

  const lockScript = I8Script.from({
    ...config.defaultScript("SECP256K1_BLAKE160"),
    args: key.publicKeyToBlake160(publicKey),
  });

  const address = encodeToAddress(lockScript);

  const expander = lockExpanderFrom(lockScript);

  function preSigner(tx: TransactionSkeletonType) {
    return addWitnessPlaceholder(tx, lockScript);
  }

  function signer(tx: TransactionSkeletonType) {
    tx = prepareSigningEntries(tx, { config });
    const message = tx.get("signingEntries").get(0)!.message; //How to improve in case of multiple locks?
    const sig = key.signRecoverable(message!, privateKey);

    return sealTransaction(tx, [sig]);
  }

  return {
    publicKey,
    lockScript,
    address,
    expander,
    preSigner,
    signer,
  };
}

main();
