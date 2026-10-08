/**
 * Where Pyrodeck listens, from PYRODECK_HOST, PYRODECK_PORT and
 * PYRODECK_SIDECAR.
 *
 * The default host is 127.0.0.1 (since 0.5.2; 0.0.0.0 before): only browsers
 * on this machine, an SSH tunnel or a reverse proxy here reach the panel. A
 * LAN without a proxy sets PYRODECK_HOST=0.0.0.0. The desktop app's sidecar
 * always listens on 127.0.0.1 on a port the system picks, whatever is set.
 */

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3001;

export interface ListenAddress {
  host: string;
  /** 0 = a free port the system picks (the sidecar). */
  port: number;
  /** PYRODECK_HOST was unset or blank, so the host is DEFAULT_HOST. */
  hostIsDefault: boolean;
  sidecar: boolean;
}

export function resolveListenAddress(env: Record<string, string | undefined>): ListenAddress {
  const sidecar = env.PYRODECK_SIDECAR === "1";
  if (sidecar) return { host: "127.0.0.1", port: 0, hostIsDefault: false, sidecar };

  const rawHost = (env.PYRODECK_HOST ?? "").trim();
  const rawPort = (env.PYRODECK_PORT ?? "").trim();
  const port = rawPort === "" ? DEFAULT_PORT : /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new Error(`PYRODECK_PORT: "${rawPort}" is not a port number (0-65535).`);
  }
  return { host: rawHost || DEFAULT_HOST, port, hostIsDefault: rawHost === "", sidecar };
}
