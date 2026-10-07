// Lets the app import ../shared (types + money helpers) so server and app share ONE API contract.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, '../shared')];

module.exports = config;
