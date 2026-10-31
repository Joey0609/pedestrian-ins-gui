'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { OTA_APP_DESC_OFFSET, OTA_APP_DESC_MAGIC } = require('./constants');

function readCString(buffer, offset, maxLen) {
  if (!Buffer.isBuffer(buffer) || offset >= buffer.length || maxLen <= 0) return '';
  const end = Math.min(offset + maxLen, buffer.length);
  const slice = buffer.slice(offset, end);
  const nulIdx = slice.indexOf(0);
  const text = (nulIdx >= 0 ? slice.slice(0, nulIdx) : slice).toString('utf8').trim();
  return text;
}

function parseFirmwareDescriptorFromBin(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < OTA_APP_DESC_OFFSET + 128) {
    return null;
  }

  const magic = buffer.readUInt32LE(OTA_APP_DESC_OFFSET);
  if (magic !== OTA_APP_DESC_MAGIC) {
    return null;
  }

  const version = readCString(buffer, OTA_APP_DESC_OFFSET + 16, 32);
  const projectName = readCString(buffer, OTA_APP_DESC_OFFSET + 48, 32);
  const buildTime = readCString(buffer, OTA_APP_DESC_OFFSET + 80, 16);
  const buildDate = readCString(buffer, OTA_APP_DESC_OFFSET + 96, 16);
  const idfVer = readCString(buffer, OTA_APP_DESC_OFFSET + 112, 32);

  return {
    version,
    projectName,
    buildTime,
    buildDate,
    idfVer,
  };
}

function inspectFirmwareBin(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'invalid-file-path' };
  }
  if (!filePath.toLowerCase().endsWith('.bin')) {
    return { ok: false, error: 'only-bin-supported' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'file-not-found' };
  }

  const buffer = fs.readFileSync(filePath);
  const descriptor = parseFirmwareDescriptorFromBin(buffer);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  let fallbackVersion = '';
  const markerMatch = buffer.toString('latin1').match(/FWVER:([0-9]+\.[0-9]+\.[0-9]+);/);
  if (markerMatch && markerMatch[1]) {
    fallbackVersion = markerMatch[1];
  }

  const version = fallbackVersion || (descriptor && descriptor.version) || 'unknown';
  const projectName = (descriptor && descriptor.projectName) || 'unknown';
  const buildDateTime = descriptor ? `${descriptor.buildDate || ''} ${descriptor.buildTime || ''}`.trim() : 'unknown';
  const idfVer = (descriptor && descriptor.idfVer) || 'unknown';

  return {
    ok: true,
    filePath,
    fileName: path.basename(filePath),
    size: buffer.length,
    sha256: fileHash,
    version,
    projectName,
    buildDateTime,
    idfVer,
    buffer,
  };
}

module.exports = { readCString, parseFirmwareDescriptorFromBin, inspectFirmwareBin };
