import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  decodeBase64Strict,
  encodeRolesCsvBuffer,
  loadRolesFile,
  loadRolesFromEnv,
  normalizeRoleUsername,
  parseRolesBase64Text,
  parseRolesCsvBuffer,
  parseRolesCsvText,
  RoleConfigError,
} from '../src/roles.js';

const execFileAsync = promisify(execFile);
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function assertRoleConfigError(action: () => unknown, expected?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof RoleConfigError);
    if (expected) assert.match(error.message, expected);
    return true;
  });
}

function encodedRecord(record: string): string {
  return Buffer.from(record, 'utf8').toString('base64');
}

function encodedRolesFile(...records: string[]): string {
  return records.map(encodedRecord).join('\n');
}

async function withTemporaryDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'azkey-card-generator-roles-'));
  try {
    return await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runRolesValidate(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(npmCommand, ['run', 'roles:validate', '--', ...args], {
      cwd: projectDirectory,
      encoding: 'utf8',
    });
    return { status: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof result.code === 'number' ? result.code : -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }
}

test('parses UTF-8 Japanese CSV with BOM, CRLF, empty lines, trimming, lowercase, and quoted fields', () => {
  const csv = '\uFEFFusername,役職名\r\n\r\n Alice_1 , 開発リード \r\nBOB,"研究,開発"\r\nquote,"引用 ""符"""\r\n';
  const expected = [['alice_1', '開発リード'], ['bob', '研究,開発'], ['quote', '引用 "符"']];

  assert.deepEqual([...parseRolesCsvText(csv)], expected);
  assert.deepEqual([...parseRolesCsvBuffer(Buffer.from(csv, 'utf8'))], expected);
});

test('compares parsed header values exactly and accepts an empty table', () => {
  assert.deepEqual([...parseRolesCsvText('"username","役職名"\r\n\r\n')], []);
  assert.deepEqual([...parseRolesCsvText('username,役職名\n')], []);

  for (const csv of [
    ' username,役職名\nalice,role',
    'username ,役職名\nalice,role',
    'username,役職名 \nalice,role',
    'username,役職名,extra\nalice,role,extra',
  ]) {
    assertRoleConfigError(() => parseRolesCsvText(csv), /header must be username,役職名/);
  }
});

test('does not accept spaces outside quoted CSV fields', () => {
  assertRoleConfigError(() => parseRolesCsvText('username,役職名\nalice, "開発"'), /invalid CSV syntax/);
});

test('rejects duplicate, empty, remote, and invalid usernames or roles', () => {
  const invalidCsv = [
    ['duplicate username', 'username,役職名\nAlice,one\n alice ,two', /duplicate username/],
    ['empty role', 'username,役職名\nalice,   ', /role must not be empty/],
    ['empty username', 'username,役職名\n   ,role', /username must be a local username without @/],
    ['at-prefixed username', 'username,役職名\n@alice,role', /username must be a local username without @/],
    ['remote username', 'username,役職名\nalice@example.com,role', /username must be a local username without @/],
    ['remote Japanese username', 'username,役職名\n@リモート,role', /username must be a local username without @/],
  ] as const;

  for (const [name, csv, expected] of invalidCsv) {
    assert.throws(() => parseRolesCsvText(csv), (error: unknown) => {
      assert.ok(error instanceof RoleConfigError, name);
      assert.match(error.message, expected, name);
      return true;
    });
  }
});

test('rejects newlines in the username or role before trimming and rejects malformed CSV syntax', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    assertRoleConfigError(
      () => parseRolesCsvText(`username,役職名\nalice,"before${newline}after"`),
      /role must not contain a newline/,
    );
    assertRoleConfigError(
      () => parseRolesCsvText(`username,役職名\n"ali${newline}ce",role`),
      /username must not contain a newline/,
    );
  }
  assertRoleConfigError(() => parseRolesCsvText('username,役職名\nalice,"unterminated'), /invalid CSV syntax/);
  assertRoleConfigError(() => parseRolesCsvText('username,役職名\nalice,one,two'), /invalid CSV syntax/);
});

test('strictly decodes a single Base64 line and rejects embedded whitespace', () => {
  const record = 'username,役職名';
  const encoded = encodedRecord(record);

  assert.equal(decodeBase64Strict(`\t ${encoded} \r\n`).toString('utf8'), record);
  for (const invalid of ['', '!!!!', 'YWJj=', 'AB==', 'YW Jj', 'YW\nJj', `${encoded}\n${encoded}`]) {
    assertRoleConfigError(() => decodeBase64Strict(invalid), /invalid Base64 encoding/);
  }
  assertRoleConfigError(() => parseRolesBase64Text(Buffer.from([0xff, 0xfe]).toString('base64')), /roles file line 1: invalid UTF-8/);
  assertRoleConfigError(() => parseRolesCsvBuffer(Buffer.from([0xff, 0xfe])), /invalid UTF-8/);
});

test('loads one Base64-encoded CSV record per line, ignores blank lines, and accepts CRLF', async () => {
  const encoded = `${encodedRolesFile('username,役職名', 'Alice,開発', 'bob,"研究,開発"')}\r\n\r\n`;
  assert.deepEqual([...parseRolesBase64Text(encoded)], [['alice', '開発'], ['bob', '研究,開発']]);

  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, 'roles.csv.b64');
    await writeFile(filePath, encoded, 'ascii');
    assert.deepEqual([...await loadRolesFile(filePath)], [['alice', '開発'], ['bob', '研究,開発']]);
    assert.deepEqual([...await loadRolesFromEnv({ CARD_ROLES_FILE: filePath })], [['alice', '開発'], ['bob', '研究,開発']]);
  });
});

test('rejects old whole-CSV Base64 and decoded records containing newlines', () => {
  const oldFormat = Buffer.from('username,役職名\nalice,開発\nbob,管理', 'utf8').toString('base64');
  assertRoleConfigError(() => parseRolesBase64Text(oldFormat), /roles file line 1: decoded record must not contain a newline/);

  for (const record of ['username,役職名\n', 'alice,開発\r\n', 'alice,"開発\nリード"', '"ali\rce",role']) {
    const file = encodedRecord(record);
    assertRoleConfigError(() => parseRolesBase64Text(file), /roles file line 1: decoded record must not contain a newline/);
  }
});

test('reports encoded-file line numbers without exposing usernames or roles', () => {
  const file = [
    '',
    encodedRecord('username,役職名'),
    'not-base64',
    encodedRecord('alice,開発'),
    encodedRecord('Alice,別の役職'),
  ].join('\n');

  assertRoleConfigError(() => parseRolesBase64Text(file), /roles file line 3: invalid Base64 encoding/);
  assertRoleConfigError(() => parseRolesBase64Text(`${encodedRecord('username,役職名')}\n${encodedRecord('alice,開発')}\n${encodedRecord('Alice,別の役職')}`), /roles file line 3: duplicate username/);
  try {
    parseRolesBase64Text(`${encodedRecord('username,役職名')}\n${encodedRecord('alice,開発')}\n${encodedRecord('Alice,別の役職')}`);
  } catch (error) {
    assert.ok(error instanceof RoleConfigError);
    assert.doesNotMatch(error.message, /alice|開発|別の役職/u);
  }
});

test('loads the bundled role file by default', async () => {
  const expected = await loadRolesFile(resolve(projectDirectory, 'config/roles.csv.b64'));
  const actual = await loadRolesFromEnv({});
  assert.ok(actual.size > 0);
  assert.ok(actual.size === expected.size && [...expected].every(([username, role]) => actual.get(username) === role));
});

test('loads the bundled role file independently of the working directory', async () => {
  await withTemporaryDirectory(async (directory) => {
    await execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      import { loadRolesFromEnv } from ${JSON.stringify(new URL('../src/roles.ts', import.meta.url).href)};
      assert.ok((await loadRolesFromEnv({})).size > 0);
    `], { cwd: directory });
  });
});

test('loads overridden role files and rejects empty or missing paths', async () => {
  await assert.rejects(
    () => loadRolesFromEnv({ CARD_ROLES_FILE: '' }),
    (error: unknown) => error instanceof RoleConfigError && /file path is empty/.test(error.message),
  );

  await loadRolesFile(resolve(projectDirectory, 'config/roles.csv.b64'));

  await withTemporaryDirectory(async (directory) => {
    const filePath = join(directory, 'roles.csv.b64');
    await writeFile(filePath, `${encodedRolesFile('username,役職名', 'Alice,開発')}\n`, 'ascii');
    assert.deepEqual([...await loadRolesFile(filePath)], [['alice', '開発']]);
    assert.deepEqual([...await loadRolesFromEnv({ CARD_ROLES_FILE: filePath })], [['alice', '開発']]);

    await assert.rejects(
      () => loadRolesFromEnv({ CARD_ROLES_FILE: join(directory, 'does-not-exist.b64') }),
      (error: unknown) => error instanceof RoleConfigError && /file could not be read/.test(error.message),
    );
  });
});

test('normalizes only local usernames', () => {
  assert.equal(normalizeRoleUsername(' Alice_1 '), 'alice_1');
  for (const username of ['', '   ', '@alice', 'alice@example.com', 'a'.repeat(101), 'リモート']) {
    assert.equal(normalizeRoleUsername(username), undefined, username);
  }
});

test('encodes validated CSV records independently and round-trips quotes, commas, and UTF-8', () => {
  const csv = '\uFEFFusername,役職名\r\n\r\n Alice_1 , 開発リード \r\nBOB,"研究,開発"\r\nquote,"引用 ""符"""\r\n';
  const encoded = encodeRolesCsvBuffer(Buffer.from(csv, 'utf8')).toString('ascii');
  const lines = encoded.split('\n');
  assert.equal(lines.pop(), '');
  assert.deepEqual(lines.map((line) => decodeBase64Strict(line).toString('utf8')), [
    'username,役職名',
    'alice_1,開発リード',
    'bob,"研究,開発"',
    'quote,"引用 ""符"""',
  ]);
  assert.deepEqual([...parseRolesBase64Text(encoded)], [
    ['alice_1', '開発リード'],
    ['bob', '研究,開発'],
    ['quote', '引用 "符"'],
  ]);
});

test('roles:encode validates before writing and preserves the previous output on invalid CSV', async () => {
  await withTemporaryDirectory(async (directory) => {
    const input = join(directory, 'roles.csv');
    const output = join(directory, 'roles.b64');
    const csv = 'username,役職名\nAlice,名誉村民\nBob,"研究,開発"\n';
    const run = (...args: string[]) => execFileAsync(npmCommand, ['run', 'roles:encode', '--', ...args], {
      cwd: projectDirectory, encoding: 'utf8',
    });
    await writeFile(input, csv);
    await run(input, output);
    const encoded = await readFile(output, 'utf8');
    assert.deepEqual([...await loadRolesFile(output)], [['alice', '名誉村民'], ['bob', '研究,開発']]);
    assert.equal(decodeBase64Strict(encoded.split('\n')[0]).toString('utf8'), 'username,役職名');
    assert.equal(decodeBase64Strict(encoded.split('\n')[1]).toString('utf8'), 'alice,名誉村民');
    assert.equal(decodeBase64Strict(encoded.split('\n')[2]).toString('utf8'), 'bob,"研究,開発"');

    await writeFile(input, 'username,役職名\nAlice,\n');
    await assert.rejects(run(input, output), (error: any) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /roles CSV line 2: role must not be empty/);
      return true;
    });
    assert.equal(await readFile(output, 'utf8'), encoded);
    await assert.rejects(run(), (error: any) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Usage: npm run roles:encode/);
      return true;
    });
  });
});

test('roles:validate CLI succeeds for a line-oriented file and fails for invalid input', async () => {
  await withTemporaryDirectory(async (directory) => {
    const validPath = join(directory, 'valid.b64');
    const invalidPath = join(directory, 'invalid.b64');
    await writeFile(validPath, `${encodedRolesFile('username,役職名', 'Alice,開発')}\n`, 'ascii');
    await writeFile(invalidPath, `${encodedRecord('username,役職名')}\nnot-base64\n`, 'ascii');

    const valid = await runRolesValidate(validPath);
    assert.equal(valid.status, 0);
    assert.match(valid.stdout, /roles file is valid/);

    const invalid = await runRolesValidate(invalidPath);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /roles file line 2: invalid Base64 encoding/);

    const usage = await runRolesValidate();
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage: npm run roles:validate/);
  });
});
