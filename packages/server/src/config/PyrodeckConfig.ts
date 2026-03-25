import fs from "node:fs/promises";
import path from "node:path";

export interface PyrodeckConfig {
  d3InstallPath: string | null;
  d3Executable: string | null;
  defaultConfigFile: string;
  defaultTelnetPort: number;
  preferredMode: "connect" | "launch";
}

const DEFAULT_CONFIG: PyrodeckConfig = {
  d3InstallPath: null,
  d3Executable: null,
  defaultConfigFile: "dedicated.cfg",
  defaultTelnetPort: 2092,
  preferredMode: "connect",
};

export class PyrodeckConfigManager {
  private configPath: string;
  private config: PyrodeckConfig = { ...DEFAULT_CONFIG };

  constructor(configDir: string) {
    this.configPath = path.join(configDir, "pyrodeck.json");
  }

  async load(): Promise<PyrodeckConfig> {
    try {
      const raw = await fs.readFile(this.configPath, "utf-8");
      const saved = JSON.parse(raw) as Partial<PyrodeckConfig>;
      this.config = { ...DEFAULT_CONFIG, ...saved };
    } catch {
      // File doesn't exist or is invalid — use defaults
      this.config = { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  async save(updates: Partial<PyrodeckConfig>): Promise<PyrodeckConfig> {
    this.config = { ...this.config, ...updates };
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
    return this.config;
  }

  get(): PyrodeckConfig {
    return this.config;
  }

  needsSetup(): boolean {
    return !this.config.d3InstallPath;
  }
}

export interface PathValidationResult {
  valid: boolean;
  errors: string[];
  configFiles: string[];
  hogFiles: string[];
}

/**
 * Validate a D3 installation path.
 * Checks that the directory exists, the specified executable is present,
 * and required game files (.hog) exist.
 */
export async function validateD3Path(
  installPath: string,
  executable: string | null,
): Promise<PathValidationResult> {
  const errors: string[] = [];
  const configFiles: string[] = [];
  const hogFiles: string[] = [];

  // Check directory exists
  try {
    const stat = await fs.stat(installPath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ["Path is not a directory"], configFiles, hogFiles };
    }
  } catch {
    return { valid: false, errors: ["Directory does not exist"], configFiles, hogFiles };
  }

  // Check executable exists
  if (executable) {
    const exePath = path.join(installPath, executable);
    try {
      await fs.access(exePath);
    } catch {
      errors.push(`Executable not found: ${executable}`);
    }
  }

  // Scan for .hog files and .cfg files
  try {
    const entries = await fs.readdir(installPath);
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (lower.endsWith(".hog")) hogFiles.push(entry);
      if (lower.endsWith(".cfg")) configFiles.push(entry);
    }
  } catch {
    errors.push("Cannot read directory contents");
  }

  // Check for required game data
  const hasD3Hog = hogFiles.some((f) => f.toLowerCase() === "d3.hog");
  if (!hasD3Hog) {
    errors.push("Required file d3.hog not found — game data may be missing");
  }

  return {
    valid: errors.length === 0,
    errors,
    configFiles,
    hogFiles,
  };
}
