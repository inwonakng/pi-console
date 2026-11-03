export type LinuxNetworkNamespace = { user: string; net: string };
export class LinuxSessionNetwork {
  static start(httpSocketPath: string | undefined, socksSocketPath: string | undefined, env?: NodeJS.ProcessEnv): Promise<LinuxSessionNetwork>;
  readonly namespace: LinuxNetworkNamespace;
  assertAlive(): void;
  close(): Promise<void>;
}
