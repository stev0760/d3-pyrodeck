/**
 * Transport abstraction for D3 server communication.
 * The Telnet implementation is the only one today, but this interface
 * allows future transports without touching business logic.
 */
export interface ServerConnection {
  connect(host: string, port: number, password: string): Promise<void>;
  send(command: string): Promise<string>;
  onData(callback: (data: string) => void): void;
  onDisconnect(callback: (reason: string) => void): void;
  disconnect(): Promise<void>;
  /**
   * Send `quit` and half-close: the server exits and tells its clients it has gone, and the console port is left
   * free. Resolves once the server has closed the connection, or after the timeout.
   */
  quit(timeoutMs?: number): Promise<void>;
  isConnected(): boolean;
}
