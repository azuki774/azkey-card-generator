import { loadRolesFile, RoleConfigError } from './roles.js';

function usage(): void {
  process.stderr.write('Usage: npm run roles:validate -- <roles.b64>\n');
}

async function main(): Promise<number> {
  const [filePath, ...extra] = process.argv.slice(2);
  if (!filePath || extra.length > 0) {
    usage();
    return 2;
  }

  try {
    await loadRolesFile(filePath);
  } catch (error) {
    process.stderr.write(`${error instanceof RoleConfigError ? error.message : 'role file validation failed'}\n`);
    return 1;
  }
  process.stdout.write('roles file is valid\n');
  return 0;
}

const exitCode = await main();
if (exitCode !== 0) process.exitCode = exitCode;
