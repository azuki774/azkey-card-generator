import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import { parse } from 'csv-parse/sync';

const LOCAL_USERNAME_PATTERN = /^[A-Za-z0-9_]{1,100}$/;

export class RoleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleConfigError';
  }
}

interface ParsedCsvRecord {
  record: unknown;
  info?: {
    lines?: unknown;
  };
}

interface ValidatedRolesCsv {
  records: string[][];
  roles: Map<string, string>;
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function errorLine(error: unknown): number {
  if (!error || typeof error !== 'object') return 1;
  const details = error as { lines?: unknown; line?: unknown };
  return positiveLine(details.lines) ?? positiveLine(details.line) ?? 1;
}

function csvError(line: number, reason: string): RoleConfigError {
  return new RoleConfigError(`roles CSV line ${line}: ${reason}`);
}

function encodedFileError(line: number, reason: string): RoleConfigError {
  return new RoleConfigError(`roles file line ${line}: ${reason}`);
}

function decodeUtf8(data: Uint8Array, description: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new RoleConfigError(`${description}: invalid UTF-8`);
  }
}

export function normalizeRoleUsername(value: string): string | undefined {
  const username = value.trim();
  if (!LOCAL_USERNAME_PATTERN.test(username)) return undefined;
  return username.toLowerCase();
}

function parseCsvRecords(text: string, errorForLine: (line: number, reason: string) => RoleConfigError): ParsedCsvRecord[] {
  let records: ParsedCsvRecord[];
  try {
    records = parse(text, {
      bom: true,
      info: true,
      relax_column_count: false,
      skip_empty_lines: true,
    }) as unknown as ParsedCsvRecord[];
  } catch (error) {
    throw errorForLine(errorLine(error), 'invalid CSV syntax');
  }
  return records;
}

function validateRolesCsvRecords(
  records: readonly ParsedCsvRecord[],
  errorForLine: (line: number, reason: string) => RoleConfigError,
): ValidatedRolesCsv {
  if (records.length === 0) throw errorForLine(1, 'header is missing');

  const header = records[0].record;
  const headerLine = positiveLine(records[0].info?.lines) ?? 1;
  if (!Array.isArray(header) || header.length !== 2 || header[0] !== 'username' || header[1] !== '役職名') {
    throw errorForLine(headerLine, 'header must be username,役職名');
  }

  const roles = new Map<string, string>();
  const canonicalRecords: string[][] = [['username', '役職名']];
  for (let index = 1; index < records.length; index += 1) {
    const entry = records[index];
    const line = positiveLine(entry.info?.lines) ?? headerLine + index;
    const row = entry.record;
    if (!Array.isArray(row) || row.length !== 2) throw errorForLine(line, 'each record must have two columns');

    const rawUsername = row[0];
    const rawRole = row[1];
    if (typeof rawUsername !== 'string' || typeof rawRole !== 'string') throw errorForLine(line, 'each field must be text');
    if (/[\r\n]/u.test(rawUsername)) {
      throw errorForLine(line, 'username must not contain a newline');
    }
    if (/[\r\n]/u.test(rawRole)) {
      throw errorForLine(line, 'role must not contain a newline');
    }

    const username = normalizeRoleUsername(rawUsername);
    if (!username) throw errorForLine(line, 'username must be a local username without @');

    const role = rawRole.trim();
    if (!role) throw errorForLine(line, 'role must not be empty');
    if (roles.has(username)) throw errorForLine(line, 'duplicate username');
    roles.set(username, role);
    canonicalRecords.push([username, role]);
  }

  return { records: canonicalRecords, roles };
}

export function parseRolesCsvText(text: string): ReadonlyMap<string, string> {
  return validateRolesCsvRecords(parseCsvRecords(text, csvError), csvError).roles;
}

export function parseRolesCsvBuffer(data: Uint8Array): ReadonlyMap<string, string> {
  return parseRolesCsvText(decodeUtf8(data, 'roles CSV'));
}

export function decodeBase64Strict(encoded: string): Buffer {
  const normalized = encoded.trim();
  if (!normalized || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)) {
    throw new RoleConfigError('roles Base64: invalid Base64 encoding');
  }

  const decoded = Buffer.from(normalized, 'base64');
  if (decoded.toString('base64') !== normalized) throw new RoleConfigError('roles Base64: invalid Base64 encoding');
  return decoded;
}

function serializeCsvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function serializeCsvRecord(record: readonly string[]): string {
  return record.map((field) => serializeCsvField(field)).join(',');
}

function parseEncodedCsvRecord(encoded: string, line: number): ParsedCsvRecord {
  let decoded: Buffer;
  try {
    decoded = decodeBase64Strict(encoded);
  } catch {
    throw encodedFileError(line, 'invalid Base64 encoding');
  }

  let csvRecord: string;
  try {
    csvRecord = decodeUtf8(decoded, `roles file line ${line}`);
  } catch {
    throw encodedFileError(line, 'invalid UTF-8');
  }
  if (/[\r\n]/u.test(csvRecord)) {
    throw encodedFileError(line, 'decoded record must not contain a newline');
  }

  let records: ParsedCsvRecord[];
  try {
    records = parse(csvRecord, {
      bom: true,
      info: true,
      relax_column_count: false,
      skip_empty_lines: false,
    }) as unknown as ParsedCsvRecord[];
  } catch {
    throw encodedFileError(line, 'invalid CSV syntax');
  }
  if (records.length !== 1) throw encodedFileError(line, 'each Base64 line must decode to exactly one CSV record');
  return { record: records[0].record, info: { lines: line } };
}

interface EncodedFileLine {
  line: number;
  encoded: string;
}

function parseEncodedFileLines(lines: readonly EncodedFileLine[]): ReadonlyMap<string, string> {
  const records: ParsedCsvRecord[] = [];
  for (const { line, encoded } of lines) {
    if (encoded.trim() === '') continue;
    records.push(parseEncodedCsvRecord(encoded, line));
  }
  return validateRolesCsvRecords(records, encodedFileError).roles;
}

export function parseRolesBase64Text(encoded: string): ReadonlyMap<string, string> {
  return parseEncodedFileLines(encoded.split(/\r\n|\n|\r/u).map((line, index) => ({ line: index + 1, encoded: line })));
}

function splitEncodedFileBytes(data: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== 0x0a && data[index] !== 0x0d) continue;
    lines.push(data.subarray(start, index));
    if (data[index] === 0x0d && data[index + 1] === 0x0a) index += 1;
    start = index + 1;
  }
  lines.push(data.subarray(start));
  return lines;
}

export function parseRolesBase64Buffer(data: Uint8Array): ReadonlyMap<string, string> {
  const lines: EncodedFileLine[] = [];
  const fileLines = splitEncodedFileBytes(data);
  for (let index = 0; index < fileLines.length; index += 1) {
    const line = index + 1;
    const bytes = fileLines[index];
    if (bytes.length === 0) {
      lines.push({ line, encoded: '' });
      continue;
    }
    let encoded: string;
    try {
      encoded = decodeUtf8(bytes, `roles file line ${line}`);
    } catch {
      throw encodedFileError(line, 'invalid UTF-8');
    }
    lines.push({ line, encoded });
  }
  return parseEncodedFileLines(lines);
}

export function encodeRolesCsvText(text: string): Buffer {
  const validated = validateRolesCsvRecords(parseCsvRecords(text, csvError), csvError);
  const encodedRecords = validated.records.map((record) => Buffer.from(serializeCsvRecord(record), 'utf8').toString('base64'));
  return Buffer.from(`${encodedRecords.join('\n')}\n`, 'ascii');
}

export function encodeRolesCsvBuffer(data: Uint8Array): Buffer {
  return encodeRolesCsvText(decodeUtf8(data, 'roles CSV'));
}

export async function loadRolesFile(filePath: string): Promise<ReadonlyMap<string, string>> {
  let encodedBytes: Buffer;
  try {
    encodedBytes = await readFile(filePath);
  } catch {
    throw new RoleConfigError('CARD_ROLES_FILE: file could not be read');
  }

  return parseRolesBase64Buffer(encodedBytes);
}

export async function loadRolesFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Promise<ReadonlyMap<string, string>> {
  const filePath = env.CARD_ROLES_FILE ?? fileURLToPath(new URL('../config/roles.csv.b64', import.meta.url));
  if (!filePath) throw new RoleConfigError('CARD_ROLES_FILE: file path is empty');
  return loadRolesFile(filePath);
}
