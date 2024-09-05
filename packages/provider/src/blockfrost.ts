import { CML } from "./core.js";
import { fromHex, sleep } from "@lucid-evolution/core-utils";
import {
  applyDoubleCborEncoding,
  scriptFromNative,
} from "@lucid-evolution/utils";
import {
  Address,
  Credential,
  Datum,
  DatumHash,
  Delegation,
  EvalRedeemer,
  OutRef,
  ProtocolParameters,
  Provider,
  RewardAddress,
  Script,
  Transaction,
  TxHash,
  Unit,
  UTxO,
} from "@lucid-evolution/core-types";
import packageJson from "../package.json";
import * as _Blockfrost from "./internal/blockfrost.js";

export class Blockfrost implements Provider {
  url: string;
  projectId: string;

  constructor(url: string, projectId?: string) {
    this.url = url;
    this.projectId = projectId || "";
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const result = await fetch(`${this.url}/epochs/latest/parameters`, {
      headers: { project_id: this.projectId, lucid },
    }).then((res) => res.json());
    return {
      minFeeA: parseInt(result.min_fee_a),
      minFeeB: parseInt(result.min_fee_b),
      maxTxSize: parseInt(result.max_tx_size),
      maxValSize: parseInt(result.max_val_size),
      keyDeposit: BigInt(result.key_deposit),
      poolDeposit: BigInt(result.pool_deposit),
      priceMem: parseFloat(result.price_mem),
      priceStep: parseFloat(result.price_step),
      maxTxExMem: BigInt(result.max_tx_ex_mem),
      maxTxExSteps: BigInt(result.max_tx_ex_steps),
      coinsPerUtxoByte: BigInt(result.coins_per_utxo_size),
      collateralPercentage: parseInt(result.collateral_percent),
      maxCollateralInputs: parseInt(result.max_collateral_inputs),
      minFeeRefScriptCostPerByte: parseInt(
        result.min_fee_ref_script_cost_per_byte,
      ),
      costModels: result.cost_models,
    };
  }

  async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    const queryPredicate = (() => {
      if (typeof addressOrCredential === "string") return addressOrCredential;
      const credentialBech32 =
        addressOrCredential.type === "Key"
          ? CML.Ed25519KeyHash.from_hex(addressOrCredential.hash).to_bech32(
              "addr_vkh",
            )
          : CML.ScriptHash.from_hex(addressOrCredential.hash).to_bech32(
              "addr_vkh",
            ); // should be 'script' (CIP-0005)
      return credentialBech32;
    })();
    let result: BlockfrostUtxoResult = [];
    let page = 1;
    while (true) {
      const pageResult: BlockfrostUtxoResult | BlockfrostUtxoError =
        await fetch(
          `${this.url}/addresses/${queryPredicate}/utxos?page=${page}`,
          { headers: { project_id: this.projectId, lucid } },
        ).then((res) => res.json());
      if ((pageResult as BlockfrostUtxoError).error) {
        if ((pageResult as BlockfrostUtxoError).status_code === 404) {
          return [];
        } else {
          throw new Error("Could not fetch UTxOs from Blockfrost. Try again.");
        }
      }
      result = result.concat(pageResult as BlockfrostUtxoResult);
      if ((pageResult as BlockfrostUtxoResult).length <= 0) break;
      page++;
    }

    return this.blockfrostUtxosToUtxos(result);
  }

  async getUtxosWithUnit(
    addressOrCredential: Address | Credential,
    unit: Unit,
  ): Promise<UTxO[]> {
    const queryPredicate = (() => {
      if (typeof addressOrCredential === "string") return addressOrCredential;
      const credentialBech32 =
        addressOrCredential.type === "Key"
          ? CML.Ed25519KeyHash.from_hex(addressOrCredential.hash).to_bech32(
              "addr_vkh",
            )
          : CML.ScriptHash.from_hex(addressOrCredential.hash).to_bech32(
              "addr_vkh",
            ); // should be 'script' (CIP-0005)
      return credentialBech32;
    })();
    let result: BlockfrostUtxoResult = [];
    let page = 1;
    while (true) {
      const pageResult: BlockfrostUtxoResult | BlockfrostUtxoError =
        await fetch(
          `${this.url}/addresses/${queryPredicate}/utxos/${unit}?page=${page}`,
          { headers: { project_id: this.projectId, lucid } },
        ).then((res) => res.json());
      if ((pageResult as BlockfrostUtxoError).error) {
        if ((pageResult as BlockfrostUtxoError).status_code === 404) {
          return [];
        } else {
          throw new Error("Could not fetch UTxOs from Blockfrost. Try again.");
        }
      }
      result = result.concat(pageResult as BlockfrostUtxoResult);
      if ((pageResult as BlockfrostUtxoResult).length <= 0) break;
      page++;
    }

    return this.blockfrostUtxosToUtxos(result);
  }

  async getUtxoByUnit(unit: Unit): Promise<UTxO> {
    const addresses = await fetch(
      `${this.url}/assets/${unit}/addresses?count=2`,
      { headers: { project_id: this.projectId, lucid } },
    ).then((res) => res.json());

    if (!addresses || addresses.error) {
      throw new Error("Unit not found.");
    }
    if (addresses.length > 1) {
      throw new Error("Unit needs to be an NFT or only held by one address.");
    }

    const address = addresses[0].address;

    const utxos = await this.getUtxosWithUnit(address, unit);

    if (utxos.length > 1) {
      throw new Error("Unit needs to be an NFT or only held by one address.");
    }

    return utxos[0];
  }

  async getUtxosByOutRef(outRefs: OutRef[]): Promise<UTxO[]> {
    // TODO: Make sure old already spent UTxOs are not retrievable.
    const queryHashes = [...new Set(outRefs.map((outRef) => outRef.txHash))];
    const utxos = await Promise.all(
      queryHashes.map(async (txHash) => {
        const result = await fetch(`${this.url}/txs/${txHash}/utxos`, {
          headers: { project_id: this.projectId, lucid },
        }).then((res) => res.json());
        if (!result || result.error) {
          return [];
        }
        const utxosResult: BlockfrostUtxoResult = result.outputs.map(
          (
            // deno-lint-ignore no-explicit-any
            r: any,
          ) => ({
            ...r,
            tx_hash: txHash,
          }),
        );
        return this.blockfrostUtxosToUtxos(utxosResult);
      }),
    );

    return utxos
      .reduce((acc, utxos) => acc.concat(utxos), [])
      .filter((utxo) =>
        outRefs.some(
          (outRef) =>
            utxo.txHash === outRef.txHash &&
            utxo.outputIndex === outRef.outputIndex,
        ),
      );
  }

  async getDelegation(rewardAddress: RewardAddress): Promise<Delegation> {
    const result = await fetch(`${this.url}/accounts/${rewardAddress}`, {
      headers: { project_id: this.projectId, lucid },
    }).then((res) => res.json());
    if (!result || result.error) {
      return { poolId: null, rewards: 0n };
    }
    return {
      poolId: result.pool_id || null,
      rewards: BigInt(result.withdrawable_amount),
    };
  }

  async getDatum(datumHash: DatumHash): Promise<Datum> {
    const datum = await fetch(`${this.url}/scripts/datum/${datumHash}/cbor`, {
      headers: { project_id: this.projectId, lucid },
    })
      .then((res) => res.json())
      .then((res) => res.cbor);
    if (!datum || datum.error) {
      throw new Error(`No datum found for datum hash: ${datumHash}`);
    }
    return datum;
  }

  awaitTx(txHash: TxHash, checkInterval = 3000): Promise<boolean> {
    return new Promise((res) => {
      const confirmation = setInterval(async () => {
        const isConfirmed = await fetch(`${this.url}/txs/${txHash}`, {
          headers: { project_id: this.projectId, lucid },
        }).then((res) => res.json());
        if (isConfirmed && !isConfirmed.error) {
          clearInterval(confirmation);
          await new Promise((res) => setTimeout(() => res(1), 1000));
          return res(true);
        }
      }, checkInterval);
    });
  }

  async submitTx(tx: Transaction): Promise<TxHash> {
    const result = await fetch(`${this.url}/tx/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        project_id: this.projectId,
        lucid,
      },
      body: fromHex(tx),
    }).then((res) => res.json());
    if (!result || result.error) {
      if (result?.status_code === 400) throw new Error(result.message);
      else throw new Error("Could not submit transaction.");
    }
    return result;
  }

  private async blockfrostUtxosToUtxos(
    result: BlockfrostUtxoResult,
  ): Promise<UTxO[]> {
    const utxos: UTxO[] = [];
    const batchSize = 10;
    let count = 0;

    for (let i = 0; i < result.length; i += batchSize) {
      const batch = result.slice(i, i + batchSize);
      count += batchSize;
      await handleRateLimit(count);
      const batchResults: UTxO[] = await Promise.all(
        batch.map(async (r) => {
          return {
            txHash: r.tx_hash,
            outputIndex: r.output_index,
            assets: Object.fromEntries(
              r.amount.map(({ unit, quantity }) => [unit, BigInt(quantity)]),
            ),
            address: r.address,
            datumHash: (!r.inline_datum && r.data_hash) || undefined,
            datum: r.inline_datum || undefined,
            scriptRef: r.reference_script_hash
              ? await (async () => {
                  const { type } = await fetch(
                    `${this.url}/scripts/${r.reference_script_hash}`,
                    {
                      headers: { project_id: this.projectId, lucid },
                    },
                  ).then((res) => res.json());

                  const { cbor: script } = await fetch(
                    `${this.url}/scripts/${r.reference_script_hash}/cbor`,
                    { headers: { project_id: this.projectId, lucid } },
                  ).then((res) => res.json());
                  switch (type) {
                    case "timelock":
                      const { json: script } = await fetch(
                        `${this.url}/scripts/${r.reference_script_hash}/json`,
                        { headers: { project_id: this.projectId, lucid } },
                      ).then((res) => res.json());
                      return scriptFromNative(script);
                    case "plutusV1":
                      return {
                        type: "PlutusV1",
                        script: applyDoubleCborEncoding(script),
                      } satisfies Script;
                    case "plutusV2":
                      return {
                        type: "PlutusV2",
                        script: applyDoubleCborEncoding(script),
                      } satisfies Script;
                    case "plutusV3":
                      return {
                        type: "PlutusV3",
                        script: applyDoubleCborEncoding(script),
                      } satisfies Script;
                  }
                })()
              : undefined,
          };
        }),
      );

      utxos.push(...batchResults);
    }

    return utxos;
  }

  async evaluateTx(
    tx: Transaction,
    additionalUTxOs?: UTxO[], // for tx chaining
  ): Promise<EvalRedeemer[]> {
    const payload = {
      cbor: tx,
      additionalUtxoSet: _Blockfrost.toAditionalUTXOs(additionalUTxOs),
    };

    const res = await fetch(`${this.url}/utils/txs/evaluate/utxos`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        project_id: this.projectId,
        lucid,
      },
      body: JSON.stringify(payload),
    }).then((res) => res.json());
    if (!res || res.error) {
      const message =
        res?.status_code === 400
          ? res.message
          : `Could not evaluate the transaction: ${JSON.stringify(res)}`;
      throw new Error(message);
    }
    const blockfrostRedeemer = res as BlockfrostRedeemer;
    if (!("EvaluationResult" in blockfrostRedeemer.result)) {
      throw new Error(
        `EvaluateTransaction fails: ${JSON.stringify(blockfrostRedeemer.result)}`,
      );
    }
    const evalRedeemers: EvalRedeemer[] = [];
    Object.entries(blockfrostRedeemer.result.EvaluationResult).forEach(
      ([redeemerPointer, data]) => {
        const [pTag, pIndex] = redeemerPointer.split(":");
        evalRedeemers.push({
          redeemer_tag: pTag,
          redeemer_index: Number(pIndex),
          ex_units: { mem: Number(data.memory), steps: Number(data.steps) },
        });
      },
    );

    return evalRedeemers;
  }
}

const handleRateLimit = async (count: number): Promise<void> => {
  if (count % 100 === 0) {
    await sleep(5_000); // 1 seconds for every 100 requests
  } else if (count % 10 === 0) {
    await sleep(500); // 100 milliseconds for every 10 requests
  }
};

type BlockfrostUtxoResult = Array<{
  tx_hash: string;
  output_index: number;
  address: Address;
  amount: Array<{ unit: string; quantity: string }>;
  data_hash?: string;
  inline_datum?: string;
  reference_script_hash?: string;
}>;

type BlockfrostUtxoError = {
  status_code: number;
  error: unknown;
};

type BlockfrostRedeemer = {
  result:
    | {
        EvaluationResult: {
          [key: string]: {
            memory: number;
            steps: number;
          };
        };
      }
    | {
        CannotCreateEvaluationContext: any;
      };
};

const lucid = packageJson.version; // Lucid version
