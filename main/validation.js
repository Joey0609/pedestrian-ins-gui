'use strict';

function isIPv4Address(text) {
  if (typeof text !== 'string') return false;
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(text.trim());
}

module.exports = { isIPv4Address };
