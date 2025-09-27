// Temporary type shims to unblock development. Replace with proper types by installing packages.
// npm install ethers

declare module 'ethers';

declare global {
  interface Window {
    ethereum?: any;
  }
}

export {};
