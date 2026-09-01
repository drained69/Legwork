import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet, formatUnits } from 'ethers';
import { config } from '../config.js';
import { audit, deleteWallet, getWallet, now, saveWallet } from '../db.js';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function encryptionKey(): Buffer {
  if (!config.payments.vaultKey) {
    throw new Error('WALLET_ENCRYPTION_KEY is required for wallet custody');
  }
  return createHash('sha256').update(config.payments.vaultKey).digest();
}

function encrypt(privateKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decrypt(payload: string): string {
  const [iv, tag, ciphertext] = payload.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !tag || !ciphertext) throw new Error('invalid encrypted wallet payload');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function provider(): JsonRpcProvider {
  return new JsonRpcProvider(config.payments.rpcUrl, config.payments.chainId, { staticNetwork: true });
}

export function walletConfigured(): boolean {
  return Boolean(config.payments.vaultKey && config.payments.rpcUrl);
}

export function createUserWallet(userId: string): { address: string; privateKey: string } {
  if (getWallet(userId)) throw new Error('A wallet is already connected');
  const wallet = Wallet.createRandom();
  saveWallet({
    userId,
    address: wallet.address,
    encryptedPrivateKey: encrypt(wallet.privateKey),
    createdAt: now(),
    imported: false,
  });
  audit('wallet', 'CREATED', `user=${userId} address=${wallet.address}`);
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export function importUserWallet(userId: string, privateKey: string): string {
  const wallet = new Wallet(privateKey.trim());
  saveWallet({
    userId,
    address: wallet.address,
    encryptedPrivateKey: encrypt(wallet.privateKey),
    createdAt: now(),
    imported: true,
  });
  audit('wallet', 'IMPORTED', `user=${userId} address=${wallet.address}`);
  return wallet.address;
}

export function disconnectUserWallet(userId: string): void {
  deleteWallet(userId);
  audit('wallet', 'DISCONNECTED', `user=${userId}`);
}

export async function walletBalances(userId: string): Promise<{ eth: string; asset?: string }> {
  const stored = getWallet(userId);
  if (!stored) throw new Error('No wallet connected');
  const rpc = provider();
  const eth = formatUnits(await rpc.getBalance(stored.address), 18);
  if (!config.payments.asset) return { eth };
  const token = new Contract(config.payments.asset, ERC20_ABI, rpc);
  const balance = (await token.balanceOf(stored.address)) as bigint;
  return { eth, asset: formatUnits(balance, config.payments.assetDecimals) };
}

export async function payForService(userId: string, amountAtomic: string): Promise<string> {
  const stored = getWallet(userId);
  if (!stored) throw new Error('Create or import a wallet first');
  if (!config.payments.asset || !config.payments.payTo) throw new Error('Service payments are not configured');
  const signer = new Wallet(decrypt(stored.encryptedPrivateKey), provider());
  const token = new Contract(config.payments.asset, ERC20_ABI, signer);
  const tx = await token.transfer(config.payments.payTo, BigInt(amountAtomic));
  const receipt = await tx.wait(config.payments.confirmations);
  if (!receipt || receipt.status !== 1) throw new Error('Payment transaction failed');
  audit('wallet', 'SERVICE_PAYMENT', `user=${userId} amount=${amountAtomic} tx=${tx.hash}`);
  return tx.hash;
}
