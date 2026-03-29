import { readFileSync } from "fs";
import { createInterface } from "readline";
import { Writable } from "stream";

import type { PrivateUserId } from "../../core/userid";

export interface ParsedCliArgs {
  values: Record<string, string>;
  positionals: string[];
  help: boolean;
}

export class CliUsageError extends Error {
  exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliUsageError";
    this.exitCode = exitCode;
  }
}

export function parseArgs(argv: string[]): ParsedCliArgs {
  const values: Record<string, string> = {};
  const positionals: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];
      if (!nextArg || nextArg.startsWith("-")) {
        throw new CliUsageError(`Missing value for ${arg}`, 1);
      }
      values[key] = nextArg;
      i++;
      continue;
    }

    positionals.push(arg);
  }

  return { values, positionals, help };
}

export function requireIdentityArg(args: ParsedCliArgs, helpText: string): string {
  if (args.help) {
    throw new CliUsageError(helpText, 0);
  }

  const identityPath = args.values.identity;
  if (!identityPath) {
    throw new CliUsageError(helpText, 1);
  }

  return identityPath;
}

export function getOptionalArg(args: ParsedCliArgs, name: string): string | undefined {
  return args.values[name];
}

export function loadPrivateIdentity(path: string): PrivateUserId {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as PrivateUserId;

  if (
    !parsed?.username ||
    !parsed?.userSigningKeyPair?.publicKey ||
    !parsed?.userSigningKeyPair?.privateKey ||
    !parsed?.userEncryptionKeyPair?.publicKey ||
    !parsed?.userEncryptionKeyPair?.privateKey
  ) {
    throw new Error(`Invalid identity file: ${path}`);
  }

  return parsed;
}

export async function promptHiddenLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (value) => resolve(value));
    });
    rl.close();
    return answer;
  }

  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) {
        process.stderr.write(chunk, encoding as BufferEncoding);
      }
      callback();
    },
  });

  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });

  return new Promise((resolve) => {
    const cleanup = () => {
      muted = false;
      rl.close();
    };

    rl.on("SIGINT", () => {
      cleanup();
      process.kill(process.pid, "SIGINT");
    });

    process.stderr.write(question);
    muted = true;
    rl.question("", (answer) => {
      process.stderr.write("\n");
      cleanup();
      resolve(answer);
    });
  });
}
