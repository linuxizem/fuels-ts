import { BaseAssetId } from '@fuel-ts/address/configs';
import { toHex } from '@fuel-ts/math';
import { Provider } from '@fuel-ts/providers';
import { Signer } from '@fuel-ts/signer';
import { defaultChainConfig, defaultConsensusKey } from '@fuel-ts/utils';
import { findBinPath } from '@fuel-ts/utils/cli-utils';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { hexlify } from 'ethers';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { getPortPromise } from 'portfinder';
import treeKill from 'tree-kill';

import type { WalletUnlocked } from '../wallets';

import { generateTestWallet } from './generateTestWallet';

const getFlagValueFromArgs = (args: string[], flag: string) => {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return undefined;
  }
  return args[flagIndex + 1];
};

const extractRemainingArgs = (args: string[], flagsToRemove: string[]) => {
  const newArgs = [...args];
  flagsToRemove.forEach((flag) => {
    const flagIndex = newArgs.indexOf(flag);
    if (flagIndex !== -1) {
      newArgs.splice(flagIndex, 2);
    }
  });
  return newArgs;
};

export type LaunchNodeOptions = {
  ip?: string;
  port?: string;
  args?: string[];
  useSystemFuelCore?: boolean;
  loggingEnabled?: boolean;
  debugEnabled?: boolean;
  basePath?: string;
};

export type LaunchNodeResult = Promise<{
  cleanup: () => void;
  ip: string;
  port: string;
  chainConfigPath: string;
}>;

export type KillNodeParams = {
  child: ChildProcessWithoutNullStreams;
  configPath: string;
  killFn: (pid: number) => void;
  state: {
    isDead: boolean;
  };
};

export const killNode = (params: KillNodeParams) => {
  const { child, configPath, state, killFn } = params;
  if (!state.isDead) {
    if (child.pid) {
      state.isDead = true;
      killFn(Number(child.pid));
    }

    // Remove all the listeners we've added.
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();

    // Remove the temporary folder and all its contents.
    if (existsSync(configPath)) {
      rmSync(configPath, { recursive: true });
    }
  }
};

// #region launchNode-launchNodeOptions
/**
 * Launches a fuel-core node.
 * @param ip - the ip to bind to. (optional, defaults to 0.0.0.0)
 * @param port - the port to bind to. (optional, defaults to 4000 or the next available port)
 * @param args - additional arguments to pass to fuel-core.
 * @param useSystemFuelCore - whether to use the system fuel-core binary or the one provided by the \@fuel-ts/fuel-core package.
 * @param loggingEnabled - whether the node should output logs. (optional, defaults to true)
 * @param debugEnabled - whether the node should log debug messages. (optional, defaults to false)
 * @param basePath - the base path to use for the temporary folder. (optional, defaults to os.tmpdir())
 * */
// #endregion launchNode-launchNodeOptions
export const launchNode = async ({
  ip,
  port,
  args = [],
  useSystemFuelCore = false,
  loggingEnabled = true,
  debugEnabled = false,
  basePath,
}: LaunchNodeOptions): LaunchNodeResult =>
  // eslint-disable-next-line no-async-promise-executor
  new Promise(async (resolve, reject) => {
    // filter out the flags chain, consensus-key, db-type, and poa-instant. we don't want to pass them twice to fuel-core. see line 214.
    const remainingArgs = extractRemainingArgs(args, [
      '--chain',
      '--consensus-key',
      '--db-type',
      '--poa-instant',
    ]);

    const chainConfigPath = getFlagValueFromArgs(args, '--chain');
    const consensusKey = getFlagValueFromArgs(args, '--consensus-key') || defaultConsensusKey;

    const dbTypeFlagValue = getFlagValueFromArgs(args, '--db-type');
    const useInMemoryDb = dbTypeFlagValue === 'in-memory' || dbTypeFlagValue === undefined;

    const poaInstantFlagValue = getFlagValueFromArgs(args, '--poa-instant');
    const poaInstant = poaInstantFlagValue === 'true' || poaInstantFlagValue === undefined;

    // This string is logged by the client when the node has successfully started. We use it to know when to resolve.
    const graphQLStartSubstring = 'Binding GraphQL provider to';

    const binPath = findBinPath('fuels-core', __dirname);

    const command = useSystemFuelCore ? 'fuel-core' : binPath;

    const ipToUse = ip || '0.0.0.0';

    const portToUse =
      port ||
      (
        await getPortPromise({
          port: 4000, // tries 4000 first, then 4001, then 4002, etc.
          stopPort: 5000, // don't try ports above 5000
        })
      ).toString();

    let chainConfigPathToUse: string;

    const prefix = basePath || os.tmpdir();
    const suffix = basePath ? '' : randomUUID();
    const tempDirPath = path.join(prefix, '.fuels', suffix);

    if (chainConfigPath) {
      chainConfigPathToUse = chainConfigPath;
    } else {
      if (!existsSync(tempDirPath)) {
        mkdirSync(tempDirPath, { recursive: true });
      }
      const tempChainConfigFilePath = path.join(tempDirPath, 'chainConfig.json');

      let chainConfig = defaultChainConfig;

      // If there's no genesis key, generate one and some coins to the genesis block.
      if (!process.env.GENESIS_SECRET) {
        const pk = Signer.generatePrivateKey();
        const signer = new Signer(pk);
        process.env.GENESIS_SECRET = hexlify(pk);

        chainConfig = {
          ...defaultChainConfig,
          initial_state: {
            ...defaultChainConfig.initial_state,
            coins: [
              ...defaultChainConfig.initial_state.coins,
              {
                owner: signer.address.toHexString(),
                amount: toHex(1_000_000_000),
                asset_id: BaseAssetId,
              },
            ],
          },
        };
      }

      // Write a temporary chain configuration file.
      writeFileSync(tempChainConfigFilePath, JSON.stringify(chainConfig), 'utf8');

      chainConfigPathToUse = tempChainConfigFilePath;
    }

    const child = spawn(
      command,
      [
        'run',
        ['--ip', ipToUse],
        ['--port', portToUse],
        useInMemoryDb ? ['--db-type', 'in-memory'] : ['--db-path', tempDirPath],
        ['--min-gas-price', '0'],
        poaInstant ? ['--poa-instant', 'true'] : [],
        ['--consensus-key', consensusKey],
        ['--chain', chainConfigPathToUse as string],
        '--vm-backtrace',
        '--utxo-validation',
        '--debug',
        ...remainingArgs,
      ].flat(),
      {
        stdio: 'pipe',
      }
    );

    if (loggingEnabled) {
      child.stderr.pipe(process.stderr);
    }

    if (debugEnabled) {
      child.stdout.pipe(process.stdout);
    }

    const cleanupConfig: KillNodeParams = {
      child,
      configPath: tempDirPath,
      killFn: treeKill,
      state: {
        isDead: false,
      },
    };

    // Look for a specific graphql start point in the output.
    child.stderr.on('data', (chunk: string) => {
      // Look for the graphql service start.
      if (chunk.indexOf(graphQLStartSubstring) !== -1) {
        // Resolve with the cleanup method.
        resolve({
          cleanup: () => killNode(cleanupConfig),
          ip: ipToUse,
          port: portToUse,
          chainConfigPath: chainConfigPathToUse as string,
        });
      }
      if (/error/i.test(chunk)) {
        reject(chunk.toString());
      }
    });

    // Process exit.
    process.on('exit', () => killNode(cleanupConfig));

    // Catches ctrl+c event.
    process.on('SIGINT', () => killNode(cleanupConfig));

    // Catches "kill pid" (for example: nodemon restart).
    process.on('SIGUSR1', () => killNode(cleanupConfig));
    process.on('SIGUSR2', () => killNode(cleanupConfig));

    // Catches uncaught exceptions.
    process.on('beforeExit', () => killNode(cleanupConfig));
    process.on('uncaughtException', () => killNode(cleanupConfig));

    child.on('error', reject);
  });

const generateWallets = async (count: number, provider: Provider) => {
  const wallets: WalletUnlocked[] = [];
  for (let i = 0; i < count; i += 1) {
    const wallet = await generateTestWallet(provider, [[1_000, BaseAssetId]]);
    wallets.push(wallet);
  }
  return wallets;
};

export type LaunchNodeAndGetWalletsResult = Promise<{
  wallets: WalletUnlocked[];
  stop: () => void;
  provider: Provider;
}>;

/**
 * Launches a fuel-core node and returns a provider, 10 wallets, and a cleanup function to stop the node.
 * @param launchNodeOptions - options to launch the fuel-core node with.
 * @param walletCount - the number of wallets to generate. (optional, defaults to 10)
 * */
export const launchNodeAndGetWallets = async ({
  launchNodeOptions,
  walletCount = 10,
}: {
  launchNodeOptions?: Partial<LaunchNodeOptions>;
  walletCount?: number;
} = {}): LaunchNodeAndGetWalletsResult => {
  const { cleanup: closeNode, ip, port } = await launchNode(launchNodeOptions || {});

  const provider = await Provider.create(`http://${ip}:${port}/graphql`);
  const wallets = await generateWallets(walletCount, provider);

  const cleanup = () => {
    closeNode();
  };

  return { wallets, stop: cleanup, provider };
};
