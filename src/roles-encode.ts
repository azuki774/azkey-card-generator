import { readFile, writeFile } from 'node:fs/promises';

import { encodeRolesCsvBuffer, RoleConfigError } from './roles.js';

function usage(): void {
  process.stderr.write('Usage: npm run roles:encode -- <input.csv> <output.b64>\n');
}

function safeMessage(error: unknown): string {
  return error instanceof RoleConfigError ? error.message : 'role file conversion failed';
}

async function main(): Promise<number> {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length > 0) {
    usage();
    return 2;
  }

  let csv: Buffer;
  try {
    csv = await readFile(inputPath);
  } catch {
    process.stderr.write('roles:encode: input CSV could not be read\n');
    return 1;
  }

  let encoded: Buffer;
  try {
    encoded = encodeRolesCsvBuffer(csv);
  } catch (error) {
    process.stderr.write(`${safeMessage(error)}\n`);
    return 1;
  }

  try {
    await writeFile(outputPath, encoded);
  } catch {
    process.stderr.write('roles:encode: output Base64 file could not be written\n');
    return 1;
  }
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) process.exitCode = exitCode;
