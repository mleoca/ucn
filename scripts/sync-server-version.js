// npm `version` lifecycle hook: keep server.json's version fields in lockstep
// with package.json so `npm version patch|minor|major` releases both in one
// commit. The publish workflow still injects from the git tag at publish time
// (belt and braces — the values will already match).
const fs = require('fs');
const v = require('../package.json').version;
const p = require('path').join(__dirname, '..', 'server.json');
const before = fs.readFileSync(p, 'utf8');
const after = before.replace(/"version": "[^"]+"/g, `"version": "${v}"`);
fs.writeFileSync(p, after);
console.log(`server.json version fields -> ${v}`);
